/**
 * 一个 Pupu 用哪个模型（docs/自带模型方案.md）。只有创建者能改；所有成员看得到用的是哪种，看不到 key。
 *
 * - `pupu`：我们的 DeepSeek，扣每日额度。
 * - `computer`：经某台电脑转发，地址和 key 在那台电脑上，云端只记是哪台。
 * - `key`：主人的 OpenAI 兼容地址和 key 存在这个 Pupu 的 SQLite 里，云端直接调。
 */

export type ModelChoice =
  | { readonly source: "pupu" }
  | {
      readonly source: "computer";
      readonly computerId: string;
      /** 那台电脑不在线时，用我们的模型顶上（扣额度）。默认关：内容不该悄悄发给别的模型。 */
      readonly fallback: boolean;
    }
  | {
      readonly source: "key";
      readonly baseUrl: string;
      readonly model: string;
      readonly apiKey: string;
      readonly vision: boolean;
      readonly contextWindow: number;
    };

/** 发给所有成员的样子：没有 key，地址只给主机名。 */
export type ModelView =
  | { readonly source: "pupu" }
  | { readonly source: "computer"; readonly computerId: string; readonly fallback: boolean }
  | {
      readonly source: "key";
      readonly host: string;
      readonly model: string;
      readonly vision: boolean;
      readonly contextWindow: number;
    };

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
      return { source: "computer", computerId: choice.computerId, fallback: choice.fallback };
    case "key":
      return {
        source: "key",
        host: hostOf(choice.baseUrl),
        model: choice.model,
        vision: choice.vision,
        contextWindow: choice.contextWindow
      };
  }
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

export type ParsedChoice =
  | { readonly ok: true; readonly choice: ModelChoice }
  | { readonly ok: false; readonly error: string };

/**
 * 网页提交的设置。`key` 模式下 key 留空表示沿用已存的（网页拿不到旧 key，只能这样表示不改）。
 */
export function parseChoice(value: unknown, current: ModelChoice): ParsedChoice {
  if (typeof value !== "object" || value === null) return { ok: false, error: "设置不对。" };
  const input = value as Record<string, unknown>;
  switch (input.source) {
    case "pupu":
      return { ok: true, choice: PUPU_CHOICE };
    case "computer": {
      if (typeof input.computerId !== "string" || !input.computerId) return { ok: false, error: "选一台电脑。" };
      return { ok: true, choice: { source: "computer", computerId: input.computerId, fallback: input.fallback === true } };
    }
    case "key": {
      const baseUrl = normalizeBaseUrl(String(input.baseUrl ?? ""));
      let url: URL;
      try {
        url = new URL(baseUrl);
      } catch {
        return { ok: false, error: "地址不对，要像 https://api.example.com/v1 这样。" };
      }
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
        return { ok: false, error: "地址要用 https。内网的模型请改用「经电脑转发」。" };
      }
      if (url.username || url.password) return { ok: false, error: "地址里不要带账号密码，key 填在下面。" };
      const model = String(input.model ?? "").trim();
      if (!model || model.length > 200) return { ok: false, error: "填上模型名。" };
      const typed = String(input.apiKey ?? "").trim();
      const kept = current.source === "key" && current.baseUrl === baseUrl ? current.apiKey : "";
      const apiKey = typed || kept;
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
          baseUrl,
          model,
          apiKey,
          vision: input.vision === true,
          contextWindow: Math.min(Math.floor(contextWindow), MAX_CONTEXT)
        }
      };
    }
    default:
      return { ok: false, error: "没有这种模型来源。" };
  }
}
