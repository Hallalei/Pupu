/**
 * 会话里记的模型固定是 `pupu/main`，每次调模型时这里按当前设置决定真正调谁：
 * 我们的 DeepSeek、主人电脑上的模型（经桥转发），或者主人在云端存的 key。
 *
 * 固定一个引用，是为了换设置时不用逐个会话 setModel，也让 pi-durable 每次 `getModel()` 都拿到当前模型的
 * 上下文长度和能不能看图：压缩上下文的时机、截图要不要换成文字说明，都看这里给的元数据。
 * 真正的请求交给 pi-ai 的 OpenAI 兼容实现，换掉的只是 model 对象、key 和 fetch。
 */

import type {
  Api,
  Model,
  OpenAICompletionsCompat,
  Provider,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
  TranscriptContext
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { LocalModelInfo } from "../bridge/model-relay.ts";
import type { ModelChoice } from "./settings.ts";

export const ROUTER_MODEL = { provider: "pupu", id: "main" } as const;

/** 转发时 OpenAI SDK 要一个地址和 key 才肯发请求；真正的地址和 key 在电脑上，电脑一律换掉。 */
const RELAY_BASE_URL = "https://relay.pupu.invalid/v1";
const RELAY_KEY = "relay";

/**
 * 不认识的 OpenAI 兼容服务按最保守的来：ollama、vLLM、公司网关常拒 developer 角色、store、strict 和
 * max_completion_tokens。转发时云端连地址都不知道，更不能靠地址自动探测。
 */
export const OWN_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  maxTokensField: "max_tokens",
  thinkingFormat: "openai"
};

/** 一次回答最多这么多 token；上下文小的按四分之一算。 */
const OWN_MAX_TOKENS = 8192;

export function ownModel(input: {
  readonly provider: string;
  readonly id: string;
  readonly baseUrl: string;
  readonly vision: boolean;
  readonly contextWindow: number;
}): Model<"openai-completions"> {
  return {
    id: input.id,
    name: input.id,
    api: "openai-completions",
    provider: input.provider,
    baseUrl: input.baseUrl,
    reasoning: false,
    input: input.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: input.contextWindow,
    maxTokens: Math.max(1024, Math.min(OWN_MAX_TOKENS, Math.floor(input.contextWindow / 4))),
    compat: OWN_COMPAT
  };
}

export type RouterDeps = {
  readonly choice: () => ModelChoice;
  /** 我们的模型：已经包好每日额度的 DeepSeek provider 和它的 model。 */
  readonly pupu: { readonly provider: Provider<Api>; readonly model: Model<Api>; readonly apiKey: () => string | undefined };
  /** OpenAI 兼容的流式实现，自带 key 和转发都用它。 */
  readonly openai: ProviderStreams;
  /** 这台电脑现在能不能转发。 */
  readonly computerModel: (computerId: string) => LocalModelInfo | null | "offline" | "outdated";
  readonly computerName: (computerId: string) => string;
  readonly relayFetch: (computerId: string) => typeof fetch;
};

/** 这一次调谁。`error` 是不调，这一轮以这句话出错结束。 */
export type Route =
  | { readonly kind: "pupu" }
  | { readonly kind: "own"; readonly model: Model<"openai-completions">; readonly apiKey: string; readonly fetch?: typeof fetch }
  | { readonly kind: "error"; readonly message: string };

export function routeOf(deps: RouterDeps): Route {
  const choice = deps.choice();
  switch (choice.source) {
    case "pupu":
      return { kind: "pupu" };
    case "key":
      return {
        kind: "own",
        model: ownModel({ provider: "own", id: choice.model, baseUrl: choice.baseUrl, vision: choice.vision, contextWindow: choice.contextWindow }),
        apiKey: choice.apiKey
      };
    case "computer": {
      const state = deps.computerModel(choice.computerId);
      if (state !== null && typeof state === "object") {
        return {
          kind: "own",
          model: ownModel({ provider: "own-relay", id: state.name, baseUrl: RELAY_BASE_URL, ...state }),
          apiKey: RELAY_KEY,
          fetch: deps.relayFetch(choice.computerId)
        };
      }
      if (choice.fallback) return { kind: "pupu" };
      const name = deps.computerName(choice.computerId);
      if (state === "offline") return { kind: "error", message: `「${name}」现在没连上，用不了它上面的模型。等它回来，或者在设置里换模型。` };
      if (state === "outdated") return { kind: "error", message: `「${name}」上的 Pupu 太旧，不能转发模型。更新电脑 App 后再试。` };
      return { kind: "error", message: `「${name}」上还没有设模型。在那台电脑的 Pupu 设置里填上。` };
    }
  }
}

/** 会话看到的模型元数据：按当前设置给。转发的电脑不在线时按设置里最后报的给不了，就按保守值。 */
export function describeRouter(deps: RouterDeps): Model<Api> {
  const route = routeOf(deps);
  const base =
    route.kind === "own"
      ? route.model
      : route.kind === "pupu"
        ? deps.pupu.model
        : ownModel({ provider: "own", id: "unavailable", baseUrl: RELAY_BASE_URL, vision: false, contextWindow: 32_000 });
  return { ...base, provider: ROUTER_MODEL.provider, id: ROUTER_MODEL.id, name: base.name } as Model<Api>;
}

export function routerProvider(deps: RouterDeps): Provider<Api> {
  const run = <O extends StreamOptions>(
    model: Model<Api>,
    context: TranscriptContext,
    options: O | undefined,
    call: (streams: ProviderStreams | Provider<Api>, model: Model<Api>, options: O) => ReturnType<ProviderStreams["stream"]>
  ) =>
    lazyStream(model, async () => {
      const route = routeOf(deps);
      if (route.kind === "error") throw new Error(route.message);
      if (route.kind === "pupu") {
        const apiKey = deps.pupu.apiKey();
        if (!apiKey) throw new Error("Pupu 自带的模型没有配 key。");
        return call(deps.pupu.provider, deps.pupu.model, { ...options, apiKey } as O);
      }
      return call(deps.openai, route.model as Model<Api>, {
        ...options,
        apiKey: route.apiKey,
        ...(route.fetch ? { fetch: route.fetch } : {})
      } as O);
    });
  return {
    id: ROUTER_MODEL.provider,
    name: "Pupu",
    // 真正的 key 在上面按路线换上；这里只让 Models 认为它配好了。
    auth: { apiKey: { name: "Pupu", resolve: async () => ({ auth: { apiKey: "router" }, source: "router" }) } },
    getModels: () => [describeRouter(deps)],
    stream: (model, context, options) =>
      run(model as Model<Api>, context, options as StreamOptions | undefined, (streams, inner, opts) =>
        streams.stream(inner, context, opts)
      ),
    streamSimple: (model, context, options) =>
      run(model, context, options as SimpleStreamOptions | undefined, (streams, inner, opts) =>
        streams.streamSimple(inner, context, opts)
      )
  };
}
