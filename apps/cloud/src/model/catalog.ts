/**
 * 自带 key 能选的服务商（docs/自带模型方案.md）。只收贴一个 API key 就能用的；要订阅登录、OAuth 或云厂商凭证的
 * （Copilot、ChatGPT 订阅、Bedrock、Vertex、Azure）不收。
 *
 * 这里只有模板本身，桥（电脑上）也会引到；模型资料在 catalog-models.ts，只有云端用。
 *
 * pi-ai 有目录的服务商直接用它的模型资料：协议、上下文、能不能看图、会不会思考、兼容参数都在里面，跟着依赖更新。
 * pi-ai 没有的几家（硅基流动、火山方舟、智谱按量、百炼 Coding Plan 等）地址和协议取自 Cindy 的
 * packages/model-providers/catalog/providers.json（makecindy/cindy，Apache-2.0）的 `runtimes.pi`，模型靠拉 `/models`。
 * 百炼按量（dashscope 的 compatible-mode）是阿里云公开文档里的兼容地址，Cindy 没收。
 */


/** 云端会说的几种协议。转发到电脑的固定走 openai-completions。 */
export const OWN_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations"
] as const;
export type OwnApi = (typeof OWN_APIS)[number];

export function isOwnApi(value: unknown): value is OwnApi {
  return typeof value === "string" && (OWN_APIS as readonly string[]).includes(value);
}

export type Template = {
  readonly id: string;
  readonly name: string;
  readonly region: "cn" | "global" | "custom";
  /** 目录外的模型、自定义地址用这个地址和协议。 */
  readonly baseUrl: string;
  readonly api: OwnApi;
  /** 去哪拿 key。 */
  readonly keyUrl?: string;
  /** 拉不拉 `/models`。目录很全或者 `/models` 混着别的东西的（OpenAI 会列出画图、嵌入模型）不拉。 */
  readonly live: boolean;
  /** 地址能不能改。只有自定义的能改，模板的地址改了就不是这家了。 */
  readonly editableBaseUrl?: boolean;
};

export const CUSTOM_OPENAI = "custom-openai";
export const CUSTOM_ANTHROPIC = "custom-anthropic";

export const TEMPLATES: readonly Template[] = [
  // 国内
  { id: "deepseek", name: "DeepSeek", region: "cn", baseUrl: "https://api.deepseek.com", api: "openai-completions", keyUrl: "https://platform.deepseek.com/api_keys", live: true },
  { id: "moonshotai-cn", name: "Kimi", region: "cn", baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions", keyUrl: "https://platform.moonshot.cn/console/api-keys", live: true },
  { id: "kimi-coding", name: "Kimi Code（包月）", region: "cn", baseUrl: "https://api.kimi.com/coding/v1", api: "openai-completions", keyUrl: "https://www.kimi.com/zh-cn/help/kimi-code/third-party-agents", live: false },
  { id: "zhipu", name: "智谱 GLM", region: "cn", baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys", live: true },
  { id: "zai-coding-cn", name: "智谱 GLM Coding Plan（包月）", region: "cn", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", api: "openai-completions", keyUrl: "https://docs.bigmodel.cn/cn/coding-plan/quick-start", live: false },
  { id: "dashscope", name: "阿里云百炼", region: "cn", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions", keyUrl: "https://bailian.console.aliyun.com/", live: true },
  { id: "bailian-coding", name: "阿里云百炼 Coding Plan（包月）", region: "cn", baseUrl: "https://coding.dashscope.aliyuncs.com/v1", api: "openai-completions", keyUrl: "https://help.aliyun.com/zh/model-studio/coding-plan", live: true },
  { id: "qwen-token-plan-cn", name: "阿里云百炼 Token Plan", region: "cn", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", api: "openai-completions", keyUrl: "https://help.aliyun.com/zh/model-studio/token-plan-personal-overview", live: false },
  { id: "volcengine", name: "火山方舟", region: "cn", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", api: "openai-completions", keyUrl: "https://www.volcengine.com/docs/82379/1330310", live: true },
  { id: "volcengine-coding", name: "火山方舟 Coding Plan（包月）", region: "cn", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", api: "openai-completions", keyUrl: "https://www.volcengine.com/docs/82379/1925114", live: true },
  { id: "minimax-cn", name: "MiniMax", region: "cn", baseUrl: "https://api.minimaxi.com/anthropic", api: "anthropic-messages", keyUrl: "https://platform.minimaxi.com/docs/api-reference/responses-create", live: false },
  { id: "xiaomi", name: "小米 MiMo", region: "cn", baseUrl: "https://api.xiaomimimo.com/v1", api: "openai-completions", keyUrl: "https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call", live: true },
  { id: "xiaomi-token-plan-cn", name: "小米 MiMo Token Plan（包月）", region: "cn", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", api: "openai-completions", keyUrl: "https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call", live: false },
  { id: "siliconflow-cn", name: "硅基流动", region: "cn", baseUrl: "https://api.siliconflow.cn/v1", api: "openai-completions", keyUrl: "https://cloud.siliconflow.cn/account/ak", live: true },
  { id: "tencent-coding", name: "腾讯云 Coding Plan（包月）", region: "cn", baseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3", api: "openai-completions", keyUrl: "https://cloud.tencent.com/document/product/1823/130092", live: true },
  { id: "longcat", name: "LongCat", region: "cn", baseUrl: "https://api.longcat.chat/openai/v1", api: "openai-completions", keyUrl: "https://longcat.chat/platform/docs/zh/", live: true },
  // 海外
  { id: "openai", name: "OpenAI", region: "global", baseUrl: "https://api.openai.com/v1", api: "openai-responses", keyUrl: "https://platform.openai.com/api-keys", live: false },
  { id: "anthropic", name: "Anthropic", region: "global", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", keyUrl: "https://console.anthropic.com/settings/keys", live: false },
  { id: "google", name: "Google Gemini", region: "global", baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", keyUrl: "https://aistudio.google.com/apikey", live: false },
  { id: "xai", name: "xAI Grok", region: "global", baseUrl: "https://api.x.ai/v1", api: "openai-responses", keyUrl: "https://console.x.ai/", live: false },
  { id: "openrouter", name: "OpenRouter", region: "global", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", keyUrl: "https://openrouter.ai/keys", live: false },
  { id: "moonshotai", name: "Kimi (Global)", region: "global", baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions", keyUrl: "https://platform.moonshot.ai/console/api-keys", live: true },
  { id: "zai", name: "Z.ai GLM Coding Plan", region: "global", baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions", keyUrl: "https://docs.z.ai/devpack/overview", live: false },
  { id: "minimax", name: "MiniMax (Global)", region: "global", baseUrl: "https://api.minimax.io/anthropic", api: "anthropic-messages", keyUrl: "https://platform.minimax.io/docs/api-reference/responses-create", live: false },
  { id: "mistral", name: "Mistral", region: "global", baseUrl: "https://api.mistral.ai", api: "mistral-conversations", keyUrl: "https://console.mistral.ai/api-keys", live: false },
  { id: "groq", name: "Groq", region: "global", baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", keyUrl: "https://console.groq.com/keys", live: true },
  { id: "together", name: "Together AI", region: "global", baseUrl: "https://api.together.ai/v1", api: "openai-completions", keyUrl: "https://api.together.ai/settings/api-keys", live: false },
  { id: "fireworks", name: "Fireworks", region: "global", baseUrl: "https://api.fireworks.ai/inference/v1", api: "openai-completions", keyUrl: "https://app.fireworks.ai/settings/users/api-keys", live: false },
  { id: "cerebras", name: "Cerebras", region: "global", baseUrl: "https://api.cerebras.ai/v1", api: "openai-completions", keyUrl: "https://cloud.cerebras.ai/", live: true },
  { id: "nvidia", name: "NVIDIA NIM", region: "global", baseUrl: "https://integrate.api.nvidia.com/v1", api: "openai-completions", keyUrl: "https://build.nvidia.com/", live: false },
  { id: "huggingface", name: "Hugging Face", region: "global", baseUrl: "https://router.huggingface.co/v1", api: "openai-completions", keyUrl: "https://huggingface.co/settings/tokens", live: false },
  { id: "vercel-ai-gateway", name: "Vercel AI Gateway", region: "global", baseUrl: "https://ai-gateway.vercel.sh/v1", api: "openai-completions", keyUrl: "https://vercel.com/docs/ai-gateway", live: false },
  { id: "siliconflow", name: "SiliconFlow", region: "global", baseUrl: "https://api.siliconflow.com/v1", api: "openai-completions", keyUrl: "https://cloud.siliconflow.com/account/ak", live: true },
  { id: "ollama-cloud", name: "Ollama Cloud", region: "global", baseUrl: "https://ollama.com/v1", api: "openai-completions", keyUrl: "https://ollama.com/settings/keys", live: true },
  // 自定义
  { id: CUSTOM_OPENAI, name: "OpenAI 兼容地址", region: "custom", baseUrl: "", api: "openai-completions", live: true, editableBaseUrl: true },
  { id: CUSTOM_ANTHROPIC, name: "Anthropic 兼容地址", region: "custom", baseUrl: "", api: "anthropic-messages", live: true, editableBaseUrl: true }
];

export function templateOf(id: string | undefined): Template | undefined {
  return TEMPLATES.find((template) => template.id === (id ?? CUSTOM_OPENAI));
}

/**
 * 贴进来的地址是哪家的：主机和路径都对上的那家。认不出来就是自定义。
 * 只用来帮用户选模板，不影响请求发到哪。
 */
export function recognize(raw: string): Template | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|responses|messages|models)$/, "");
  let best: Template | undefined;
  let bestLength = -1;
  for (const template of TEMPLATES) {
    if (!template.baseUrl) continue;
    const base = new URL(template.baseUrl);
    if (base.host !== url.host) continue;
    const basePath = base.pathname.replace(/\/+$/, "");
    // 路径也要对上（可以多一个 /v1）：同一个主机上别的路径可能是另一种协议，比如 DeepSeek 的 /anthropic。
    if ((path === basePath || path === `${basePath}/v1`) && basePath.length > bestLength) {
      best = template;
      bestLength = basePath.length;
    }
  }
  return best;
}
