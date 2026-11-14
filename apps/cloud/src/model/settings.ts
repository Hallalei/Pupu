import type { MagpieModel } from "../bridge/model-relay.ts";
import { CUSTOM_OPENAI, isOwnApi, templateOf, type OwnApi, type Template } from "./catalog.ts";

/**
 * 一个 Pupu 用哪个模型（docs/自带模型方案.md）。只有创建者能改；所有成员看得到用的是哪种，看不到 key。
 *
 * - `pupu`：我们的 DeepSeek，扣每日额度。
 * - `computer`：经某台电脑转发，地址和 key 在那台电脑上，云端只记是哪台。带 `magpie` 的转给那台电脑上的 Magpie，
 *   模型是选的那个；不带的转给那台电脑上设的模型。
 * - `key`：主人选的服务商（catalog.ts）、地址和 key 存在这个 Pupu 的 SQLite 里，云端直接调。
 *
 * `key` 的 `provider`、`api`、`reasoning` 是后来加的：之前存的只有 OpenAI 兼容地址，读出来按自定义的 OpenAI 兼容处理。
 */

export type ModelChoice =
  | { readonly source: "pupu" }
  | {
      readonly source: "computer";
      readonly computerId: string;
      /** 那台电脑不在线时，用我们的模型顶上（扣额度）。默认关：内容不该悄悄发给别的模型。 */
      readonly fallback: boolean;
      /** 用那台电脑上 Magpie 里的这个模型。选的时候从那台电脑报的清单里抄下来。 */
      readonly magpie?: MagpieChoice;
    }
  | KeyChoice;

export type MagpieChoice = Pick<MagpieModel, "id" | "name" | "contextWindow" | "vision">;

export type KeyChoice = {
  readonly source: "key";
  /** catalog.ts 里的模板。没有是老记录，当自定义的 OpenAI 兼容地址。 */
  readonly provider?: string;
  readonly api?: OwnApi;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly vision: boolean;
  readonly contextWindow: number;
  /** 会不会思考。开了才按思考的格式发、收思考内容。 */
  readonly reasoning?: boolean;
};

export function providerOf(choice: KeyChoice): string {
  return choice.provider ?? CUSTOM_OPENAI;
}

export function apiOf(choice: KeyChoice): OwnApi {
  return choice.api ?? "openai-completions";
}

/** 自带 key 的设置发给成员的样子。 */
export type KeyView = {
  readonly source: "key";
  readonly provider: string;
  readonly providerName: string;
  readonly host: string;
  readonly model: string;
  readonly vision: boolean;
  readonly contextWindow: number;
  readonly reasoning: boolean;
};

/** 发给所有成员的样子：没有 key，地址只给主机名。 */
export type ModelView =
  | { readonly source: "pupu" }
  | {
      readonly source: "computer";
      readonly computerId: string;
      readonly fallback: boolean;
      readonly magpie?: { readonly id: string; readonly name: string };
    }
  | KeyView;

/** 低于这个上下文长度，系统提示词和工具说明就占掉一大半，不让选。 */
export const MIN_CONTEXT = 16_000;
/** 没填时按这个算。宁小勿大：报大了压缩来不及，请求会被上游拒掉。 */
export const DEFAULT_CONTEXT = 32_000;
const MAX_CONTEXT = 2_000_000;

export const PUPU_CHOICE: ModelChoice = { source: "pupu" };

export function modelView(choice: ModelChoice): ModelView {
  switch (choice.source) {
    case "pupu":
      return { source: "pupu" };
    case "computer":
      return {
        source: "computer",
        computerId: choice.computerId,
        fallback: choice.fallback,
        ...(choice.magpie ? { magpie: { id: choice.magpie.id, name: choice.magpie.name } } : {})
      };
    case "key":
      return keyView(choice);
  }
}

export function keyView(choice: KeyChoice): KeyView {
  const provider = providerOf(choice);
  return {
    source: "key",
    provider,
    providerName: templateOf(provider)?.name ?? provider,
    host: hostOf(choice.baseUrl),
    model: choice.model,
    vision: choice.vision,
    contextWindow: choice.contextWindow,
    reasoning: choice.reasoning === true
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** 本机开发时能连 localhost 上的假服务；线上的 Worker 连不到本机，放过也无妨。 */
function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** 去掉结尾的 `/` 和 `/chat/completions`，填哪种都行。 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

/**
 * 自带 key 实际用的地址：模板的用模板的，自定义的整理用户填的。
 * Anthropic 的 SDK 自己接 /v1/messages，贴了完整路径就去掉。保存和拉模型列表共用，存的 key 按它对。
 */
export function keyBaseUrl(template: Template, api: OwnApi, raw: unknown): string {
  if (!template.editableBaseUrl) return template.baseUrl;
  const typed = normalizeBaseUrl(String(raw ?? ""));
  return api === "anthropic-messages" ? typed.replace(/\/messages$/, "").replace(/\/v1$/, "") : typed;
}

export type ParsedChoice =
  | { readonly ok: true; readonly choice: ModelChoice }
  | { readonly ok: false; readonly error: string };

/** 这家服务商、这个地址存过的 key。地址变了就不算：不能把存的 key 发到别的主机。 */
export type SavedKey = (provider: string, baseUrl: string) => string;

/** 这台电脑报过的 Magpie 清单里的这个模型。没有是 null。 */
export type MagpieLookup = (computerId: string, modelId: string) => MagpieModel | null;

/**
 * 网页提交的设置。`key` 模式下 key 留空表示沿用已存的（网页拿不到旧 key，只能这样表示不改）。
 * 模板的地址和协议以模板为准；只有自定义的能自己填地址、选协议。
 * Magpie 的模型只认 id，资料从电脑报的清单里抄，不信网页给的。
 */
export function parseChoice(value: unknown, savedKey: SavedKey, magpie: MagpieLookup = () => null): ParsedChoice {
  if (typeof value !== "object" || value === null) return { ok: false, error: "设置不对。" };
  const input = value as Record<string, unknown>;
  switch (input.source) {
    case "pupu":
      return { ok: true, choice: PUPU_CHOICE };
    case "computer": {
      if (typeof input.computerId !== "string" || !input.computerId) return { ok: false, error: "选一台电脑。" };
      const base = { source: "computer", computerId: input.computerId, fallback: input.fallback === true } as const;
      if (input.magpie === undefined || input.magpie === null || input.magpie === "") return { ok: true, choice: base };
      if (typeof input.magpie !== "string") return { ok: false, error: "选一个 Magpie 里的模型。" };
      const found = magpie(input.computerId, input.magpie);
      if (!found) return { ok: false, error: "那台电脑的 Magpie 里没有这个模型。" };
      return {
        ok: true,
        choice: {
          ...base,
          magpie: { id: found.id, name: found.name, contextWindow: found.contextWindow, vision: found.vision }
        }
      };
    }
    case "key": {
      const provider = input.provider === undefined ? CUSTOM_OPENAI : String(input.provider);
      const template = templateOf(provider);
      if (!template) return { ok: false, error: "没有这家服务商。" };
      const api: OwnApi = template.editableBaseUrl && isOwnApi(input.api) ? input.api : template.api;
      const baseUrl = keyBaseUrl(template, api, input.baseUrl);
      let url: URL;
      try {
        url = new URL(baseUrl);
      } catch {
        return { ok: false, error: "地址不对，要像 https://api.example.com/v1 这样。" };
      }
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
        return { ok: false, error: "地址要用 https。内网的模型请设在电脑上，再在这里选那台电脑。" };
      }
      if (url.username || url.password) return { ok: false, error: "地址里不要带账号密码，key 填在下面。" };
      const model = String(input.model ?? "").trim();
      if (!model || model.length > 200) return { ok: false, error: "填上模型名。" };
      const typed = String(input.apiKey ?? "").trim();
      const apiKey = typed || savedKey(provider, baseUrl);
      if (!apiKey) return { ok: false, error: "填上 key。" };
      if (apiKey.length > 1000) return { ok: false, error: "key 太长了。" };
      const contextWindow = input.contextWindow === undefined || input.contextWindow === null || input.contextWindow === ""
        ? DEFAULT_CONTEXT
        : Number(input.contextWindow);
      if (!Number.isFinite(contextWindow) || contextWindow < MIN_CONTEXT) {
        return { ok: false, error: `上下文至少要 ${MIN_CONTEXT / 1000}k。` };
      }
      return {
        ok: true,
        choice: {
          source: "key",
          provider,
          api,
          baseUrl,
          model,
          apiKey,
          vision: input.vision === true,
          contextWindow: Math.min(Math.floor(contextWindow), MAX_CONTEXT),
          reasoning: input.reasoning === true
        }
      };
    }
    default:
      return { ok: false, error: "没有这种模型来源。" };
  }
}
