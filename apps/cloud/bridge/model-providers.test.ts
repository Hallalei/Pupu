import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Tool } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { recognize, templateOf, TEMPLATES } from "../src/model/catalog.ts";
import { catalogModels } from "../src/model/catalog-models.ts";
import { probeKeyModel } from "../src/model/key-probe.ts";
import { listModels, parseModelsList } from "../src/model/list.ts";
import { describeRouter, keyModel, routeOf, routerProvider, type RouterDeps } from "../src/model/router.ts";
import { keyBaseUrl, keyView, modelView, parseChoice, PUPU_CHOICE, type KeyChoice, type ModelChoice } from "../src/model/settings.ts";
import { ModelStore } from "../src/model/store.ts";
import { sqlStorage } from "./sql-memory.ts";

const apis = {
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
  "anthropic-messages": anthropicMessagesApi(),
  "google-generative-ai": googleGenerativeAIApi(),
  "mistral-conversations": mistralConversationsApi()
};

function deps(choice: ModelChoice): RouterDeps {
  const faux = fauxProvider();
  return {
    choice: () => choice,
    pupu: { provider: faux.provider, model: faux.getModel(), apiKey: () => "pupu-key" },
    apis,
    computerModel: () => null,
    computerName: () => "Mac",
    relayFetch: () => {
      throw new Error("不该转发");
    }
  };
}

const KIMI: KeyChoice = {
  source: "key",
  provider: "moonshotai-cn",
  api: "openai-completions",
  baseUrl: "https://api.moonshot.cn/v1",
  model: "kimi-k2.6",
  apiKey: "kimi-key",
  vision: true,
  contextWindow: 200_000,
  reasoning: true
};

const CLAUDE: KeyChoice = {
  source: "key",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  apiKey: "anthropic-key",
  vision: true,
  contextWindow: 200_000,
  reasoning: true
};

type Seen = { url: string; headers: Headers; body: Record<string, unknown> };

/** 假的 Anthropic：回一段 SSE，调一次 ping。 */
function fakeAnthropic(seen: Seen[], tool = "ping"): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, headers: request.headers, body: (await request.json()) as Record<string, unknown> });
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const text = [
      event("message_start", {
        message: { id: "m1", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } }
      }),
      event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: tool, input: {} } }),
      event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"word":"pupu"}' } }),
      event("content_block_stop", { index: 0 }),
      event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
      event("message_stop", {})
    ].join("");
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

describe("服务商目录", () => {
  test("模板 id 不重复；模板的地址都是 https", () => {
    assert.equal(new Set(TEMPLATES.map((each) => each.id)).size, TEMPLATES.length);
    for (const template of TEMPLATES) {
      if (template.editableBaseUrl) continue;
      assert.match(template.baseUrl, /^https:\/\//, template.id);
    }
  });

  test("贴地址认出是哪家：带不带 /chat/completions 都行；同主机按路径分", () => {
    assert.equal(recognize("https://api.moonshot.cn/v1/chat/completions")?.id, "moonshotai-cn");
    assert.equal(recognize("https://ark.cn-beijing.volces.com/api/v3")?.id, "volcengine");
    assert.equal(recognize("https://ark.cn-beijing.volces.com/api/coding/v3/")?.id, "volcengine-coding");
    assert.equal(recognize("https://api.deepseek.com")?.id, "deepseek");
    assert.equal(recognize("https://llm.example.com/v1"), undefined);
    assert.equal(recognize("https://api.deepseek.com/v1")?.id, "deepseek");
    assert.equal(recognize("https://api.deepseek.com/anthropic"), undefined);
  });
});

describe("自带 key 的设置", () => {
  test("线上的老记录（没有 provider、api）照读、照路由，不用重填 key", () => {
    const sql = sqlStorage();
    sql.exec("CREATE TABLE IF NOT EXISTS pupu_model (id INTEGER PRIMARY KEY CHECK (id = 1), choice TEXT NOT NULL)");
    const old = { source: "key", baseUrl: "https://llm.example.com/v1", model: "qwen", apiKey: "old-key", vision: false, contextWindow: 64_000 };
    sql.exec("INSERT INTO pupu_model (id, choice) VALUES (1, ?)", JSON.stringify(old));
    const store = new ModelStore(sql);
    const choice = store.get();
    assert.equal(choice.source, "key");
    const route = routeOf(deps(choice));
    assert.ok(route.kind === "own");
    assert.equal(route.model.api, "openai-completions");
    assert.equal(route.model.provider, "own");
    assert.equal(route.apiKey, "old-key");
    assert.equal(keyView(choice as KeyChoice).provider, "custom-openai");
    // 老的网页发来的老形状：key 留空沿用。
    const parsed = parseChoice({ source: "key", baseUrl: "https://llm.example.com/v1", model: "qwen2" }, (p, u) => store.savedKey(p, u));
    assert.ok(parsed.ok && parsed.choice.source === "key" && parsed.choice.apiKey === "old-key");
  });

  test("模板的地址和协议以模板为准，网页传别的地址也不用", () => {
    const parsed = parseChoice(
      { source: "key", provider: "deepseek", baseUrl: "https://evil.example/v1", api: "anthropic-messages", model: "deepseek-chat", apiKey: "k" },
      () => ""
    );
    assert.ok(parsed.ok && parsed.choice.source === "key");
    assert.equal(parsed.choice.baseUrl, "https://api.deepseek.com");
    assert.equal(parsed.choice.api, "openai-completions");
    assert.equal(parseChoice({ source: "key", provider: "nope", model: "m", apiKey: "k" }, () => "").ok, false);
  });

  test("自定义的 Anthropic 兼容地址：贴完整的 /v1/messages 也行", () => {
    const parsed = parseChoice(
      { source: "key", provider: "custom-anthropic", baseUrl: "https://gw.example.com/anthropic/v1/messages", model: "m", apiKey: "k" },
      () => ""
    );
    assert.ok(parsed.ok && parsed.choice.source === "key");
    assert.equal(parsed.choice.baseUrl, "https://gw.example.com/anthropic");
    assert.equal(parsed.choice.api, "anthropic-messages");
  });

  test("换成别的来源再换回来 key 还在；地址变了不带存的 key；忘掉以后用不了", () => {
    const store = new ModelStore(sqlStorage());
    const custom: KeyChoice = { ...KIMI, provider: "custom-openai", baseUrl: "https://a.example/v1", apiKey: "a-key" };
    store.set(custom);
    store.set(KIMI);
    store.set(PUPU_CHOICE);
    assert.deepEqual(store.get(), PUPU_CHOICE);
    assert.equal(store.lastOwn()?.provider, "moonshotai-cn");
    assert.equal(store.savedKey("moonshotai-cn", KIMI.baseUrl), "kimi-key");
    assert.equal(store.savedKey("custom-openai", "https://a.example/v1"), "a-key");
    assert.equal(store.savedKey("custom-openai", "https://b.example/v1"), "");
    assert.deepEqual(
      store.keyProviders().map((each) => each.provider).sort(),
      ["custom-openai", "moonshotai-cn"]
    );
    store.forget("moonshotai-cn");
    assert.equal(store.savedKey("moonshotai-cn", KIMI.baseUrl), "");
    assert.equal(store.lastOwn(), null);
    store.set(KIMI);
    store.forget("moonshotai-cn");
    assert.deepEqual(store.get(), PUPU_CHOICE);
  });

  test("成员看到的没有 key", () => {
    assert.doesNotMatch(JSON.stringify(modelView(KIMI)), /kimi-key/);
  });
});

describe("按服务商调", () => {
  test("目录里的模型：带上目录的思考格式和兼容参数，上下文以设置为准", () => {
    const model = keyModel(KIMI);
    assert.equal(model.provider, "moonshotai-cn");
    assert.equal(model.reasoning, true);
    assert.equal(model.contextWindow, 200_000);
    assert.equal((model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat, "deepseek");
    const meta = describeRouter(deps(KIMI));
    assert.equal(meta.reasoning, true);
    assert.equal(meta.contextWindow, 200_000);
  });

  test("目录外的模型名：按模板的协议和保守参数", () => {
    const model = keyModel({ ...KIMI, model: "kimi-next-unknown", reasoning: false });
    assert.equal(model.api, "openai-completions");
    assert.equal(model.reasoning, false);
    assert.equal(model.baseUrl, "https://api.moonshot.cn/v1");
  });

  test("Anthropic 协议：发到 /v1/messages，key 放 x-api-key；探测认得 tool_use", async () => {
    const seen: Seen[] = [];
    const probe = await probeKeyModel({ model: keyModel(CLAUDE), apiKey: CLAUDE.apiKey, apis, fetch: fakeAnthropic(seen) });
    assert.deepEqual(probe, { ok: true });
    assert.equal(new URL(seen[0]!.url).pathname, "/v1/messages");
    assert.equal(seen[0]!.headers.get("x-api-key"), "anthropic-key");
    assert.equal(seen[0]!.body.model, "claude-sonnet-4-5");
    const wrong = await probeKeyModel({ model: keyModel(CLAUDE), apiKey: CLAUDE.apiKey, apis, fetch: fakeAnthropic([], "other") });
    assert.equal(wrong.ok, false);
  });

  test("另外三种协议：请求发到各家的地址、带上 key，401 说 key 不对", async () => {
    const expected: Record<string, { host: string; key: RegExp }> = {
      openai: { host: "api.openai.com", key: /authorization=Bearer sk-test/ },
      xai: { host: "api.x.ai", key: /authorization=Bearer sk-test/ },
      google: { host: "generativelanguage.googleapis.com", key: /x-goog-api-key=sk-test/ },
      mistral: { host: "api.mistral.ai", key: /authorization=Bearer sk-test/ }
    };
    for (const [id, want] of Object.entries(expected)) {
      const template = templateOf(id)!;
      const model = catalogModels(template)[0]!;
      const seen: { host: string; headers: string }[] = [];
      const reject: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        seen.push({ host: new URL(request.url).host, headers: [...request.headers].map(([k, v]) => `${k}=${v}`).join(",") });
        return new Response(JSON.stringify({ error: { message: "Incorrect API key provided", code: 401 } }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      };
      const choice: KeyChoice = {
        source: "key",
        provider: id,
        api: template.api,
        baseUrl: template.baseUrl,
        model: model.id,
        apiKey: "sk-test",
        vision: false,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning
      };
      // Gemini 的实现不认传进去的 fetch，直接用全局的；线上就是全局的，这里两处都换掉。
      const original = globalThis.fetch;
      globalThis.fetch = reject;
      let probe;
      try {
        probe = await probeKeyModel({ model: keyModel(choice), apiKey: "sk-test", apis, fetch: reject });
      } finally {
        globalThis.fetch = original;
      }
      assert.equal(seen.length > 0, true, `${id} 没发请求`);
      assert.equal(seen[0]!.host, want.host, id);
      assert.match(seen[0]!.headers, want.key, id);
      assert.ok(!probe.ok);
      assert.match(probe.error, /key 不对/, `${id}: ${probe.error}`);
    }
  });

  test("探测：401 说 key 不对", async () => {
    const reject: typeof fetch = async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    const probe = await probeKeyModel({ model: keyModel(CLAUDE), apiKey: "bad", apis, fetch: reject });
    assert.ok(!probe.ok);
    assert.match(probe.error, /key 不对/);
  });

  test("探测：连不上时五种协议都说人话，不写 SDK 那句「Connection error.」；收到回应的照原样报错", async () => {
    const down: typeof fetch = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const gateway: typeof fetch = async () => new Response("upstream network unreachable", { status: 502 });
    const choices: KeyChoice[] = [CLAUDE, KIMI];
    for (const id of ["openai", "xai", "google", "mistral"]) {
      const template = templateOf(id)!;
      const model = catalogModels(template)[0]!;
      choices.push({
        source: "key",
        provider: id,
        api: template.api,
        baseUrl: template.baseUrl,
        model: model.id,
        apiKey: "sk-test",
        vision: false,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning
      });
    }
    // Gemini 的实现不认传进去的 fetch，直接用全局的，两处都换掉（同上面 401 那条）。
    const probe = async (choice: KeyChoice, fake: typeof fetch) => {
      const original = globalThis.fetch;
      globalThis.fetch = fake;
      try {
        return await probeKeyModel({ model: keyModel(choice), apiKey: choice.apiKey, apis, fetch: fake });
      } finally {
        globalThis.fetch = original;
      }
    };
    for (const choice of choices) {
      assert.deepEqual(await probe(choice, down), { ok: false, error: "连不上这个地址：检查地址和网络。" }, choice.provider);
    }
    const answered = await probe(KIMI, gateway);
    assert.ok(!answered.ok);
    assert.match(answered.error, /^模型服务报错.*502 upstream network unreachable/, answered.error);
  });

  test("中途从 Kimi（带思考）换到 Claude：别家的思考去掉，工具调用和结果对得上", async () => {
    const seen: Seen[] = [];
    const listFiles: Tool = { name: "list_files", description: "列目录", parameters: Type.Object({ path: Type.String() }) };
    const context = normalizeContext({
      messages: [
        { role: "user", content: "看看桌面", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "moonshotai-cn",
          model: "kimi-k2.6",
          content: [
            { type: "thinking", thinking: "先列目录" },
            { type: "toolCall", id: "call_1", name: "list_files", arguments: { path: "~/Desktop" } }
          ],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2
        },
        { role: "toolResult", toolCallId: "call_1", toolName: "list_files", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 3 },
        { role: "user", content: "接着说", timestamp: 4 }
      ],
      tools: [listFiles]
    });
    const provider = routerProvider(deps(CLAUDE));
    const message = await provider.streamSimple(describeRouter(deps(CLAUDE)), context, { fetch: fakeAnthropic(seen) }).result();
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    const sent = seen[0]!.body.messages as { role: string; content: { type: string; id?: string; tool_use_id?: string }[] | string }[];
    const blocks = sent.flatMap((each) => (Array.isArray(each.content) ? each.content : []));
    assert.equal(blocks.some((block) => block.type === "thinking"), false);
    const use = blocks.find((block) => block.type === "tool_use");
    const result = blocks.find((block) => block.type === "tool_result");
    assert.ok(use && result && use.id === result.tool_use_id);
  });
});

describe("拉模型列表", () => {
  const json = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

  test("实时的为准，目录补资料；目录没有的按默认上下文", async () => {
    const deepseek = templateOf("deepseek")!;
    const list = await listModels(deepseek, deepseek.baseUrl, "k", json({ data: [{ id: "deepseek-flash" }, { id: "deepseek-new" }] }));
    assert.equal(list.error, null);
    assert.deepEqual(list.models.map((each) => each.id), ["deepseek-flash", "deepseek-new"]);
    assert.equal(list.models[0]!.known, true);
    assert.equal(list.models[1]!.known, false);
    assert.equal(list.models[1]!.contextWindow, 32_000);
  });

  test("拉不到：给目录，说为什么；被重定向不跟", async () => {
    const deepseek = templateOf("deepseek")!;
    const failed = await listModels(deepseek, deepseek.baseUrl, "k", json({ error: "x" }, 401));
    assert.match(failed.error ?? "", /key 不对/);
    assert.ok(failed.models.length > 0);
    let followed = "";
    const redirect: typeof fetch = async (_input, init) => {
      followed = String(init?.redirect);
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
    };
    const moved = await listModels(templateOf("siliconflow-cn")!, "https://api.siliconflow.cn/v1", "k", redirect);
    assert.equal(followed, "manual");
    assert.match(moved.error ?? "", /重定向/);
    assert.equal(moved.models.length, 0);
    const down: typeof fetch = async () => {
      throw new TypeError("Network connection lost.");
    };
    const lost = await listModels(templateOf("custom-openai")!, "https://llm.example.com/v1", "k", down);
    assert.equal(lost.error, "拉不到模型列表，可以直接填模型名。");
  });

  test("自定义的 Anthropic 兼容地址贴了完整路径：保存和拉列表用同一个地址", async () => {
    const custom = templateOf("custom-anthropic")!;
    const base = keyBaseUrl(custom, custom.api, "https://gw.example.com/anthropic/v1/messages");
    assert.equal(base, "https://gw.example.com/anthropic");
    let asked = "";
    const capture: typeof fetch = async (input) => {
      asked = String(input);
      return new Response(JSON.stringify({ data: [{ id: "c", max_input_tokens: 200000 }] }), { status: 200 });
    };
    const list = await listModels(custom, base, "k", capture);
    assert.equal(asked, "https://gw.example.com/anthropic/v1/models?limit=1000");
    assert.equal(list.models[0]?.contextWindow, 200000);
  });

  test("没有 key：只给目录，不发请求", async () => {
    const list = await listModels(templateOf("deepseek")!, "https://api.deepseek.com", "", () => {
      throw new Error("不该请求");
    });
    assert.ok(list.models.length > 0);
  });

  test("几种列表形状：OpenAI、OpenRouter 带上下文、Gemini 去掉 models/ 和非聊天的", () => {
    assert.deepEqual(parseModelsList({ data: [{ id: "a" }, { id: "a" }, { id: "b", context_length: 128000 }] }), [
      { id: "a", name: "a" },
      { id: "b", name: "b", contextWindow: 128000 }
    ]);
    assert.deepEqual(
      parseModelsList({
        models: [
          { name: "models/gemini-x", displayName: "Gemini X", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
          { name: "models/embed", supportedGenerationMethods: ["embedContent"] }
        ]
      }),
      [{ id: "gemini-x", name: "Gemini X", contextWindow: 1048576 }]
    );
    assert.equal(parseModelsList({ nope: true }), null);
  });
});
