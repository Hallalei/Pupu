import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { MODEL_PIECE_CHARS, ModelRelay, requestPieces, type ModelDown, type ModelUp } from "../src/bridge/model-relay.ts";
import { describeRouter, ROUTER_MODEL, routeOf, routerProvider, type RouterDeps } from "../src/model/router.ts";
import { modelView, parseChoice, PUPU_CHOICE, type ModelChoice } from "../src/model/settings.ts";
import { ModelStore } from "../src/model/store.ts";
import { USAGE_LIMIT_MESSAGE, withDailyLimit } from "../src/usage.ts";
import { ModelRelayClient, parseLocalModel, type LocalModel } from "./model.ts";
import { sqlStorage } from "./sql-memory.ts";

const LOCAL: LocalModel = {
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "local-test-key",
  model: "qwen-local",
  vision: false,
  contextWindow: 32_000
};

/** 一段 OpenAI 兼容的 SSE：先分两块吐一个工具调用，再结束。 */
function toolCallSse(): string[] {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "list_files", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "\"~/Desktop\"}" } }] }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  ];
}

type Upstream = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** 云端的 ModelRelay 和电脑上的 ModelRelayClient 在内存里接起来，上游换成假的。 */
function wire(options: { upstream?: typeof fetch; local?: LocalModel | null; online?: () => boolean } = {}) {
  const seen: Upstream[] = [];
  const down: ModelDown[] = [];
  const upstream: typeof fetch =
    options.upstream ??
    (async (input, init) => {
      seen.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      });
      const pieces = toolCallSse();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
  let relay: ModelRelay;
  const client = new ModelRelayClient({
    // 桥上的帧异步回到云端，和真连接一样。
    send: (message: ModelUp) => {
      queueMicrotask(() => {
        if (message.kind !== "info") relay.receive("pc1", message);
      });
      return true;
    },
    current: () => (options.local === undefined ? LOCAL : options.local),
    fetch: upstream
  });
  relay = new ModelRelay({
    send: (computerId, message) => {
      if (computerId !== "pc1" || !(options.online?.() ?? true)) return false;
      down.push(message);
      queueMicrotask(() => client.receive(message));
      return true;
    }
  });
  return { relay, client, seen, down };
}

function deps(choice: ModelChoice, overrides: Partial<RouterDeps> = {}): RouterDeps {
  const faux = fauxProvider();
  return {
    choice: () => choice,
    pupu: { provider: faux.provider, model: faux.getModel(), apiKey: () => "pupu-key" },
    apis: { "openai-completions": openAICompletionsApi() },
    computerModel: () => ({ name: LOCAL.model, vision: LOCAL.vision, contextWindow: LOCAL.contextWindow }),
    computerName: () => "办公室的 Mac",
    relayFetch: () => {
      throw new Error("不该转发");
    },
    ...overrides
  };
}

const listFiles: Tool = {
  name: "list_files",
  description: "列目录",
  parameters: Type.Object({ path: Type.String() })
};

describe("经电脑转发模型请求", () => {
  test("请求体按片发、按序收齐；电脑只认请求体，地址、key、模型名都换成本地的", async () => {
    const { relay, seen } = wire();
    const body = JSON.stringify({ model: "pupu-said-this", stream: true, padding: "x".repeat(MODEL_PIECE_CHARS * 2 + 10) });
    const response = await relay.fetch("pc1")("https://evil.example/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer cloud-should-not-matter" },
      body
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /list_files/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(seen[0]!.headers.authorization, "Bearer local-test-key");
    assert.equal(seen[0]!.body.model, "qwen-local");
    assert.equal((seen[0]!.body.padding as string).length, MODEL_PIECE_CHARS * 2 + 10);
    assert.equal(relay.size, 0);
  });

  test("切片：空的请求体也发一片，最后一片标 last", () => {
    assert.deepEqual(requestPieces("a", ""), [{ kind: "request", id: "a", seq: 0, text: "", last: true }]);
    const pieces = requestPieces("a", "y".repeat(MODEL_PIECE_CHARS + 1));
    assert.deepEqual(
      pieces.map((piece) => (piece.kind === "request" ? [piece.seq, piece.text.length, piece.last] : null)),
      [
        [0, MODEL_PIECE_CHARS, false],
        [1, 1, true]
      ]
    );
  });

  test("经 pi-ai 跑一轮：工具调用分几块流回来，拼成一个完整的调用，不计费", async () => {
    const { relay, seen } = wire();
    const provider = routerProvider(
      deps({ source: "computer", computerId: "pc1", fallback: false }, { relayFetch: (id) => relay.fetch(id) })
    );
    const context: Context = { systemPrompt: "你是 Pupu。", messages: [{ role: "user", content: "看看桌面", timestamp: 1 }], tools: [listFiles] };
    const message = await provider.streamSimple(describeRouter(deps({ source: "pupu" })), normalizeContext(context)).result();
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    const call = message.content.find((part) => part.type === "toolCall");
    assert.ok(call && call.type === "toolCall");
    assert.equal(call.name, "list_files");
    assert.deepEqual(call.arguments, { path: "~/Desktop" });
    assert.equal(message.usage.cost.total, 0);
    // 不认识的服务按保守的来：不发 developer 角色、store、max_completion_tokens。
    const sent = seen[0]!.body;
    assert.ok(Array.isArray(sent.tools) && sent.tools.length === 1);
    assert.equal(sent.store, undefined);
    assert.equal(sent.max_completion_tokens, undefined);
    assert.ok((sent.messages as { role: string }[]).every((each) => each.role !== "developer"));
  });

  test("上游连不上：电脑回 502，说明原因但不带地址", async () => {
    const { relay } = wire({
      upstream: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }
    });
    const response = await relay.fetch("pc1")("https://x/v1/chat/completions", { method: "POST", body: "{}" });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.match(text, /连不上它设的模型服务/);
    assert.match(text, /ECONNREFUSED/);
    assert.doesNotMatch(text, /127\.0\.0\.1/);
  });

  test("电脑上没设模型：回 503", async () => {
    const { relay } = wire({ local: null });
    const response = await relay.fetch("pc1")("https://x/v1/chat/completions", { method: "POST", body: "{}" });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /没有设模型/);
  });

  test("电脑没连着：立刻失败，错误里带 pi 认得的 connection 字样", async () => {
    const { relay } = wire({ online: () => false });
    await assert.rejects(relay.fetch("pc1")("https://x", { method: "POST", body: "{}" }), /connection refused/);
    assert.equal(relay.size, 0);
  });

  test("停下：云端发取消，电脑停掉上游请求", async () => {
    let upstreamAborted = false;
    const { relay, down } = wire({
      upstream: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            upstreamAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        })
    });
    const controller = new AbortController();
    const pending = relay.fetch("pc1")("https://x", { method: "POST", body: "{}", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(pending, /取消/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(down.some((message) => message.kind === "cancel"));
    assert.equal(upstreamAborted, true);
    assert.equal(relay.size, 0);
  });

  test("流到一半电脑断了：流报 connection lost，好让 pi 重试", async () => {
    const { relay } = wire({
      upstream: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(toolCallSse()[0]!));
            }
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    });
    const response = await relay.fetch("pc1")("https://x", { method: "POST", body: "{}" });
    const reader = response.body!.getReader();
    await reader.read();
    relay.gone("pc1");
    await assert.rejects(reader.read(), /connection lost/);
  });
});

describe("按设置路由", () => {
  test("电脑离线：默认报错说清楚，不悄悄换成我们的模型", () => {
    const route = routeOf(deps({ source: "computer", computerId: "pc1", fallback: false }, { computerModel: () => "offline" }));
    assert.equal(route.kind, "error");
    assert.match(route.kind === "error" ? route.message : "", /办公室的 Mac.*没连上/);
  });

  test("电脑离线、开了回落：用我们的模型", () => {
    assert.equal(routeOf(deps({ source: "computer", computerId: "pc1", fallback: true }, { computerModel: () => "offline" })).kind, "pupu");
  });

  test("老的电脑 App：说要更新；没设模型：说去那台电脑上填", () => {
    const outdated = routeOf(deps({ source: "computer", computerId: "pc1", fallback: false }, { computerModel: () => "outdated" }));
    assert.match(outdated.kind === "error" ? outdated.message : "", /更新电脑 App/);
    const empty = routeOf(deps({ source: "computer", computerId: "pc1", fallback: false }, { computerModel: () => null }));
    assert.match(empty.kind === "error" ? empty.message : "", /还没有设模型/);
  });

  test("会话看到的元数据跟着设置走：上下文、能不能看图、费用", () => {
    const own = describeRouter(
      deps({ source: "key", baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k", vision: true, contextWindow: 64_000 })
    );
    assert.deepEqual([own.provider, own.id], [ROUTER_MODEL.provider, ROUTER_MODEL.id]);
    assert.equal(own.contextWindow, 64_000);
    assert.deepEqual(own.input, ["text", "image"]);
    assert.equal(own.reasoning, false);
    assert.equal(own.cost.input, 0);
    const ours = describeRouter(deps(PUPU_CHOICE));
    assert.equal(ours.reasoning, fauxProvider().getModel().reasoning);
  });

  test("用自己的模型不查额度；回落到我们的模型要查，额度用完就停", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("不该走到这里")]);
    const limited = withDailyLimit(faux.provider, () => USAGE_LIMIT_MESSAGE);
    const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
    const fallback = routerProvider(
      deps(
        { source: "computer", computerId: "pc1", fallback: true },
        { computerModel: () => "offline", pupu: { provider: limited, model: faux.getModel(), apiKey: () => "k" } }
      )
    );
    const refused = await fallback.streamSimple(describeRouter(deps(PUPU_CHOICE)), context).result();
    assert.equal(refused.errorMessage, USAGE_LIMIT_MESSAGE);
    assert.equal(faux.state.callCount, 0);

    const { relay } = wire();
    const own = routerProvider(
      deps(
        { source: "computer", computerId: "pc1", fallback: true },
        { relayFetch: (id) => relay.fetch(id), pupu: { provider: limited, model: faux.getModel(), apiKey: () => "k" } }
      )
    );
    const answered = await own.streamSimple(describeRouter(deps(PUPU_CHOICE)), context).result();
    assert.equal(answered.stopReason, "toolUse", answered.errorMessage);
  });
});

describe("中途换模型：历史里混着两种模型的消息", () => {
  /** 记下发出去的请求体，回一段只有文字的 SSE。 */
  function capture() {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const text = `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    return { bodies, fetchImpl };
  }

  const toolTurn = (provider: string, model: string, api = "openai-completions", thinking = false) => [
    { role: "user" as const, content: "看看桌面", timestamp: 1 },
    {
      role: "assistant" as const,
      api,
      provider,
      model,
      content: [
        ...(thinking ? [{ type: "thinking" as const, thinking: "先列目录" }] : []),
        { type: "toolCall" as const, id: "call_1", name: "list_files", arguments: { path: "~/Desktop" } }
      ],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse" as const,
      timestamp: 2
    },
    { role: "toolResult" as const, toolCallId: "call_1", toolName: "list_files", content: [{ type: "text" as const, text: "a.txt" }], isError: false, timestamp: 3 },
    { role: "user" as const, content: "接着说", timestamp: 4 }
  ];

  test("DeepSeek 的历史（带思考）发给自己的模型：思考去掉，工具调用和结果对得上", async () => {
    const { bodies, fetchImpl } = capture();
    const provider = routerProvider(deps({ source: "computer", computerId: "pc1", fallback: false }, { relayFetch: () => fetchImpl }));
    const context = normalizeContext({ messages: toolTurn("deepseek", "deepseek-flash", "openai-completions", true), tools: [listFiles] });
    const message = await provider.streamSimple(describeRouter(deps(PUPU_CHOICE)), context).result();
    assert.equal(message.stopReason, "stop", message.errorMessage);
    const sent = bodies[0]!.messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string; reasoning_content?: unknown }[];
    const assistant = sent.find((each) => each.role === "assistant")!;
    assert.equal(assistant.tool_calls?.[0]?.id, "call_1");
    assert.equal(assistant.reasoning_content, undefined);
    assert.equal(sent.find((each) => each.role === "tool")?.tool_call_id, "call_1");
  });

  test("自己模型的历史发给 DeepSeek（回落）：照 DeepSeek 的要求带上 reasoning_content", async () => {
    const { bodies, fetchImpl } = capture();
    const deepseek = deepseekProvider();
    const pupuModel = deepseek.getModels().find((model) => model.id === "deepseek-flash")!;
    const provider = routerProvider(
      deps(
        { source: "computer", computerId: "pc1", fallback: true },
        { computerModel: () => "offline", pupu: { provider: deepseek, model: pupuModel, apiKey: () => "test-key" } }
      )
    );
    const context = normalizeContext({ messages: toolTurn("own-relay", "qwen-local"), tools: [listFiles] });
    const message = await provider.streamSimple(describeRouter(deps(PUPU_CHOICE)), context, { fetch: fetchImpl }).result();
    assert.equal(message.stopReason, "stop", message.errorMessage);
    const sent = bodies[0]!.messages as { role: string; tool_calls?: { id: string }[]; reasoning_content?: unknown }[];
    const assistant = sent.find((each) => each.role === "assistant")!;
    assert.equal(assistant.tool_calls?.[0]?.id, "call_1");
    assert.ok("reasoning_content" in assistant);
    assert.equal(bodies[0]!.model, "deepseek-flash");
  });
});

const noKey = () => "";

describe("模型设置", () => {
  test("自带 key：要 https，不能太小的上下文；成员看到的没有 key，只有主机名", () => {
    assert.equal(parseChoice({ source: "key", baseUrl: "http://api.example.com/v1", model: "m", apiKey: "k" }, noKey).ok, false);
    assert.equal(
      parseChoice({ source: "key", baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k", contextWindow: 8000 }, noKey).ok,
      false
    );
    const parsed = parseChoice(
      { source: "key", baseUrl: "https://api.example.com/v1/chat/completions", model: "m", apiKey: "secret-key" },
      noKey
    );
    assert.ok(parsed.ok);
    const view = modelView(parsed.choice);
    assert.deepEqual(view, {
      source: "key",
      provider: "custom-openai",
      providerName: "OpenAI 兼容地址",
      host: "api.example.com",
      model: "m",
      vision: false,
      contextWindow: 32_000,
      reasoning: false
    });
    assert.doesNotMatch(JSON.stringify(view), /secret-key/);
  });

  test("key 留空是沿用旧的；换了地址就要重填", () => {
    const store = new ModelStore(sqlStorage());
    store.set({ source: "key", baseUrl: "https://a.example/v1", model: "m", apiKey: "old", vision: false, contextWindow: 32_000 });
    const saved = (provider: string, baseUrl: string) => store.savedKey(provider, baseUrl);
    const same = parseChoice({ source: "key", baseUrl: "https://a.example/v1", model: "m2" }, saved);
    assert.ok(same.ok && same.choice.source === "key" && same.choice.apiKey === "old");
    assert.equal(parseChoice({ source: "key", baseUrl: "https://b.example/v1", model: "m" }, saved).ok, false);
  });

  test("存一行，读回来一样；没存过是我们的模型", () => {
    const store = new ModelStore(sqlStorage());
    assert.deepEqual(store.get(), PUPU_CHOICE);
    store.set({ source: "computer", computerId: "pc1", fallback: true });
    assert.deepEqual(store.get(), { source: "computer", computerId: "pc1", fallback: true });
  });

  test("电脑上的模型可以是 http，地址末尾的 /chat/completions 去掉", () => {
    const parsed = parseLocalModel({ baseUrl: "http://10.0.0.5:8000/v1/chat/completions", model: "qwen" });
    assert.ok(typeof parsed !== "string");
    assert.equal(parsed.baseUrl, "http://10.0.0.5:8000/v1");
    assert.equal(parsed.apiKey, "");
  });
});
