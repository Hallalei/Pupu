import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRelay, parseModelDown, parseModelUp, requestPieces, type MagpieModel, type ModelUp } from "../src/bridge/model-relay.ts";
import { probeKeyModel } from "../src/model/key-probe.ts";
import { magpieModel, RELAY_KEY, routeOf, type RouterDeps } from "../src/model/router.ts";
import { modelView, parseChoice, type ModelChoice } from "../src/model/settings.ts";
import { ModelStore } from "../src/model/store.ts";
import { discoverMagpie, MAGPIE_BASE_URL, parseMagpieModels, type Magpie } from "./magpie.ts";
import { ModelRelayClient } from "./model.ts";
import { sqlStorage } from "./sql-memory.ts";

// 名字都是编的，不放真实的 Magpie 清单。
const RAW = {
  object: "list",
  data: [
    { id: "acme/fast", object: "model", type: "model", display_name: "Fast", magpie_label: "Acme Fast", context_window: 200_000, modalities: { input: ["text", "image"] }, reasoning: true, tool_call: true },
    { id: "acme/no-tools", type: "model", display_name: "No Tools", context_window: 200_000, tool_call: false },
    { id: "acme/embed", type: "embedding", context_window: 8_000, tool_call: true },
    { id: "acme/tiny", type: "model", context_length: 4_000, tool_call: true },
    { id: "acme/plain", type: "model", display_name: "Plain" },
    { id: "acme/fast", type: "model", context_window: 1 }
  ]
};

const FAST: MagpieModel = { id: "acme/fast", name: "Acme Fast", contextWindow: 200_000, vision: true, reasoning: true };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("发现 Magpie", () => {
  test("只留会调工具的聊天模型，名字用 magpie_label，没写上下文按 128k", () => {
    assert.deepEqual(parseMagpieModels(RAW), [
      FAST,
      { id: "acme/plain", name: "Plain", contextWindow: 128_000, vision: false, reasoning: false }
    ]);
  });

  test("先问 /api/hello 认出是 Magpie，只连本机，不跟重定向、不带凭据", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const found = await discoverMagpie(async (input, init) => {
      calls.push({ url: String(input), init });
      return String(input).endsWith("/api/hello") ? json({ name: "magpie", version: "0.1" }) : json(RAW);
    });
    assert.equal(found?.baseUrl, MAGPIE_BASE_URL);
    assert.equal(found?.models.length, 2);
    assert.deepEqual(
      calls.map((call) => call.url),
      ["http://127.0.0.1:3425/api/hello", "http://127.0.0.1:3425/v1/models"]
    );
    for (const call of calls) {
      assert.equal(call.init?.redirect, "manual");
      assert.equal(new Headers(call.init?.headers).has("authorization"), false);
    }
  });

  test("端口上是别的服务、没开、重定向，都当没有", async () => {
    assert.equal(await discoverMagpie(async () => json({ name: "other" })), null);
    assert.equal(
      await discoverMagpie(async () => {
        throw new TypeError("fetch failed");
      }),
      null
    );
    assert.equal(await discoverMagpie(async () => new Response(null, { status: 302, headers: { location: "http://x" } })), null);
  });
});

describe("协议", () => {
  test("第一片带 target，老的请求不带；老的云端看到 magpie 帧会丢掉", () => {
    const pieces = requestPieces("r", "x".repeat(70_000), "magpie");
    assert.equal(pieces[0]?.kind === "request" && pieces[0].target, "magpie");
    assert.equal(pieces[1]?.kind === "request" && pieces[1].target, undefined);
    assert.deepEqual(parseModelDown(pieces[0]), pieces[0]);
    assert.equal("target" in (requestPieces("r", "x")[0] as object), false);
    assert.deepEqual(parseModelUp({ kind: "magpie", models: [FAST] }), { kind: "magpie", models: [FAST] });
    assert.deepEqual(parseModelUp({ kind: "magpie", models: null }), { kind: "magpie", models: null });
    assert.equal(parseModelUp({ kind: "magpie", models: "nope" }), null);
  });
});

/** 云端的 ModelRelay 接到电脑的 ModelRelayClient，上游换成假的。 */
function wire(magpie: Magpie | null) {
  const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  let relay: ModelRelay;
  const client = new ModelRelayClient({
    send: (message: ModelUp) => {
      queueMicrotask(() => relay.receive("pc1", message));
      return true;
    },
    current: () => ({ baseUrl: "http://127.0.0.1:11434/v1", apiKey: "local-key", model: "local-model", vision: false, contextWindow: 32_000 }),
    magpie: async () => magpie,
    fetch: async (input, init) => {
      seen.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const sse =
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "ping", arguments: "{\"word\":\"pupu\"}" } }] }) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n";
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  relay = new ModelRelay({
    send: (_computerId, message) => {
      queueMicrotask(() => client.receive(message));
      return true;
    }
  });
  return { relay, seen };
}

describe("转给 Magpie", () => {
  test("发到本机 Magpie，模型名用云端选的，不带 key；不在清单里的拒掉", async () => {
    const { relay, seen } = wire({ baseUrl: MAGPIE_BASE_URL, models: [FAST] });
    const ok = await relay.fetch("pc1", "magpie")("https://relay.pupu.invalid/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "acme/fast", stream: true })
    });
    assert.equal(ok.status, 200);
    await ok.text();
    assert.equal(seen[0]?.url, "http://127.0.0.1:3425/v1/chat/completions");
    assert.equal(seen[0]?.body.model, "acme/fast");
    assert.equal(seen[0]?.headers.authorization, undefined);

    const missing = await relay.fetch("pc1", "magpie")("https://relay.pupu.invalid/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "acme/secret" })
    });
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /没有这个模型/);
    assert.equal(seen.length, 1);

    // 不带 target 的照旧发给本地设的模型。
    const local = await relay.fetch("pc1")("https://relay.pupu.invalid/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "acme/fast" })
    });
    await local.text();
    assert.equal(seen[1]?.url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(seen[1]?.body.model, "local-model");
  });

  test("Magpie 没开回 503，说清楚", async () => {
    const { relay, seen } = wire(null);
    const response = await relay.fetch("pc1", "magpie")("https://relay.pupu.invalid/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "acme/fast" })
    });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Magpie 没开/);
    assert.equal(seen.length, 0);
  });

  test("保存前的试调走同一条路：经 pi-ai、经桥、到 Magpie，调到了工具", async () => {
    const { relay, seen } = wire({ baseUrl: MAGPIE_BASE_URL, models: [FAST] });
    const result = await probeKeyModel({
      model: magpieModel(FAST),
      apiKey: RELAY_KEY,
      apis: { "openai-completions": openAICompletionsApi() },
      fetch: relay.fetch("pc1", "magpie")
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(seen[0]?.body.model, "acme/fast");
  });
});

function deps(choice: ModelChoice, magpie: ReturnType<RouterDeps["computerMagpie"]>): RouterDeps {
  const faux = fauxProvider();
  return {
    choice: () => choice,
    pupu: { provider: faux.provider, model: faux.getModel(), apiKey: () => "pupu-key" },
    apis: { "openai-completions": openAICompletionsApi() },
    computerModel: () => null,
    computerMagpie: () => magpie,
    computerName: () => "书房",
    relayFetch: (_id, target) => {
      assert.equal(target, "magpie");
      return fetch;
    }
  };
}

describe("选 Magpie 和路由", () => {
  const choice: ModelChoice = {
    source: "computer",
    computerId: "pc1",
    fallback: false,
    magpie: { id: FAST.id, name: FAST.name, contextWindow: FAST.contextWindow, vision: FAST.vision }
  };

  test("模型资料从电脑报的清单里抄，不信网页给的；别人看到的只有名字", () => {
    const lookup = (computerId: string, id: string) => (computerId === "pc1" && id === FAST.id ? FAST : null);
    const parsed = parseChoice({ source: "computer", computerId: "pc1", magpie: FAST.id, contextWindow: 9_999_999 }, () => "", lookup);
    assert.deepEqual(parsed, { ok: true, choice });
    assert.equal(parseChoice({ source: "computer", computerId: "pc2", magpie: FAST.id }, () => "", lookup).ok, false);
    assert.deepEqual(modelView(choice), { source: "computer", computerId: "pc1", fallback: false, magpie: { id: FAST.id, name: FAST.name } });
  });

  test("开着、在清单里就转；不然说清楚是哪种情况", () => {
    const route = routeOf(deps(choice, [FAST]));
    assert.equal(route.kind, "own");
    if (route.kind === "own") {
      assert.equal(route.model.provider, "magpie");
      assert.equal(route.model.id, FAST.id);
      assert.equal(route.model.contextWindow, FAST.contextWindow);
      assert.deepEqual(route.model.input, ["text", "image"]);
      assert.equal(route.model.reasoning, false);
    }
    const message = (state: ReturnType<RouterDeps["computerMagpie"]>) => {
      const result = routeOf(deps(choice, state));
      return result.kind === "error" ? result.message : result.kind;
    };
    assert.match(message(null), /Magpie 没开/);
    assert.match(message([]), /没有「Acme Fast」了/);
    assert.match(message("offline"), /没连上/);
    assert.match(message("outdated"), /太旧/);
    assert.equal(routeOf(deps({ ...choice, fallback: true }, null)).kind, "pupu");
  });

  test("清单存在 SQLite 里，没变不重写", () => {
    const store = new ModelStore(sqlStorage());
    assert.equal(store.magpieModels("pc1"), null);
    assert.equal(store.setMagpieModels("pc1", [FAST]), true);
    assert.equal(store.setMagpieModels("pc1", [FAST]), false);
    assert.deepEqual(store.magpieModels("pc1"), [FAST]);
  });
});
