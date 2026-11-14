/**
 * 自带 key 保存前试一次：和真正调用走同一条路（同一个 model、同一种协议、同一份 pi-ai 实现），
 * 要它调一次 ping 工具。Pupu 做事要靠工具，不会调的不让存。
 * 电脑转发的那份在 probe.ts，只依赖 fetch，桥也在用，别把 pi-ai 拖过去。
 */

import type { Api, Model, ProviderStreams, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import type { OwnApi } from "./catalog.ts";
import type { ProbeResult } from "./probe.ts";

const PROBE_TIMEOUT_MS = 45_000;

const ping: Tool = {
  name: "ping",
  description: "Connectivity check.",
  parameters: Type.Object({ word: Type.String() })
};

export async function probeKeyModel(input: {
  readonly model: Model<Api>;
  readonly apiKey: string;
  readonly apis: Partial<Record<OwnApi, ProviderStreams>>;
  readonly fetch?: typeof fetch;
}): Promise<ProbeResult> {
  const streams = input.apis[input.model.api as OwnApi];
  if (!streams) return { ok: false, error: `Pupu 还不会用 ${input.model.api} 协议。` };
  const context = normalizeContext({
    messages: [{ role: "user", content: 'Call the ping tool with word set to "pupu". Do not reply with text.', timestamp: Date.now() }],
    tools: [ping]
  });
  let status = 0;
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const message = await streams
      .streamSimple(input.model, context, {
        apiKey: input.apiKey,
        signal,
        // 带思考的模型先想一阵才调工具，给小了会被误判成不会调。
        maxTokens: 2048,
        ...(input.model.reasoning ? { reasoning: "low" as const } : {}),
        ...(input.fetch ? { fetch: input.fetch } : {}),
        onResponse: (response) => {
          status = response.status;
        }
      })
      .result();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      if (signal.aborted) return { ok: false, error: "模型 45 秒都没回话。" };
      return { ok: false, error: errorText(status, message.errorMessage ?? "") };
    }
    const called = message.content.some((block) => block.type === "toolCall" && block.name === "ping");
    if (!called) return { ok: false, error: "这个模型没有按要求调用工具。Pupu 做事要靠工具，换一个支持工具调用的模型。" };
    return { ok: true };
  } catch (error) {
    if (signal.aborted) return { ok: false, error: "模型 45 秒都没回话。" };
    return { ok: false, error: errorText(status, error instanceof Error ? error.message : String(error)) };
  }
}

function errorText(status: number, raw: string): string {
  const detail = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  // Gemini、xAI 的错 key 回 400，按字面认。
  const badKey = /\b(401|403)\b|unauthori[sz]ed|(invalid|incorrect).{0,20}(api.?key|token)|api.?key not valid/i;
  if (status === 401 || status === 403 || badKey.test(detail)) {
    return `key 不对，或者没有这个模型的权限。${detail ? ` ${detail}` : ""}`;
  }
  if (status === 404 || /\b404\b/.test(detail)) return `找不到这个模型（404）。看看模型名对不对。${detail ? ` ${detail}` : ""}`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(detail)) return `连不上这个地址：${detail}`;
  return `模型服务报错${status ? ` ${status}` : ""}${detail ? `：${detail}` : "。"}`;
}
