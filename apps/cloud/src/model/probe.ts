/**
 * 保存自带模型前试一次：能不能连上、会不会调用工具。Pupu 的活几乎都靠工具，不会调工具的模型不让用。
 * Cline 把能力当声明、没声明就放行，不支持时悄悄去掉工具（references/NOTES.md）；Pupu 改成先探测，
 * 不过就说清楚为什么，不保存。云端（自带 key）和电脑（转发）共用这一份，只依赖 fetch。
 */

export type ProbeInput = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
};

export type ProbeResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

const PROBE_TIMEOUT_MS = 45_000;

export async function probeModel(input: ProbeInput, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: input.model,
        stream: false,
        max_tokens: 200,
        messages: [{ role: "user", content: "Call the ping tool with word set to \"pupu\". Do not reply with text." }],
        tools: [
          {
            type: "function",
            function: {
              name: "ping",
              description: "Connectivity check.",
              parameters: {
                type: "object",
                properties: { word: { type: "string" } },
                required: ["word"]
              }
            }
          }
        ]
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, error: "模型 45 秒都没回话。" };
    return { ok: false, error: `连不上这个地址：${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const text = await response.text();
    if (!response.ok) return { ok: false, error: statusError(response.status, text) };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: "这个地址回的不是 OpenAI 兼容的格式。" };
    }
    const calls = (body as { choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[] })
      .choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(calls) || !calls.some((call) => call.function?.name === "ping")) {
      return { ok: false, error: "这个模型没有按要求调用工具。Pupu 做事要靠工具，换一个支持工具调用的模型。" };
    }
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

function statusError(status: number, text: string): string {
  const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
  if (status === 401 || status === 403) return `key 不对，或者没有这个模型的权限（${status}）。`;
  if (status === 404) return `找不到（404）。地址要填到 /v1 这一层，模型名也要对。${detail ? ` ${detail}` : ""}`;
  return `模型服务报错 ${status}${detail ? `：${detail}` : "。"}`;
}
