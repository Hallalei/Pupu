import type { MagpieModel } from "../src/bridge/model-relay.ts";
import { MIN_CONTEXT } from "../src/model/settings.ts";

/**
 * 这台电脑上开着的 Magpie（usemagpie.ai，本机的模型网关，订阅和 key 都在它那里）。
 *
 * 做法照 Cindy（makecindy/cindy，Apache-2.0）：地址固定是 http://127.0.0.1:3425/v1，按 OpenAI Chat 协议调；
 * 先问 `/api/hello` 认出是 Magpie（packages/model-providers/catalog/providers.json 的 magpie 条目、
 * apps/desktop/src/main/maker-host/provider-model-fetch.ts），模型名优先用 `magpie_label`
 * （packages/model-providers/src/modelSource.ts 的 discoveredMagpieSource）。
 *
 * 只连本机回环地址，不跟重定向，不带任何凭据。只报会调工具的聊天模型：Pupu 做事靠工具。
 */
export const MAGPIE_BASE_URL = "http://127.0.0.1:3425/v1";
const HELLO_URL = "http://127.0.0.1:3425/api/hello";
const TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_MAGPIE_MODELS = 200;
const DEFAULT_CONTEXT = 128_000;

export type Magpie = { readonly baseUrl: string; readonly models: readonly MagpieModel[] };

/** 没开、不是 Magpie、列表读不出来都是 null。 */
export async function discoverMagpie(fetchImpl: typeof fetch = fetch): Promise<Magpie | null> {
  const hello = await getJson(fetchImpl, HELLO_URL);
  if (!isRecord(hello) || hello.name !== "magpie") return null;
  const list = await getJson(fetchImpl, `${MAGPIE_BASE_URL}/models`);
  const models = parseMagpieModels(list);
  return models ? { baseUrl: MAGPIE_BASE_URL, models } : null;
}

export function parseMagpieModels(body: unknown): MagpieModel[] | null {
  const entries = isRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : null;
  if (!entries) return null;
  const seen = new Set<string>();
  const out: MagpieModel[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const id = entry.id.trim();
    if (!id || id.length > 200 || seen.has(id)) continue;
    if (typeof entry.type === "string" && entry.type !== "model") continue;
    // 没说会不会调工具的也收：老版本的 Magpie 不报这个字段，保存时会试一次。
    if (entry.tool_call === false) continue;
    const contextWindow =
      tokens(entry.context_window) ?? tokens(entry.context_length) ?? tokens(entry.max_input_tokens) ?? DEFAULT_CONTEXT;
    if (contextWindow < MIN_CONTEXT) continue;
    const label = [entry.magpie_label, entry.display_name].find((value) => typeof value === "string" && value.trim());
    const input = isRecord(entry.modalities) && Array.isArray(entry.modalities.input) ? entry.modalities.input : [];
    seen.add(id);
    out.push({
      id,
      name: (typeof label === "string" ? label.trim() : id).slice(0, 200),
      contextWindow,
      vision: input.includes("image"),
      reasoning: entry.reasoning === true
    });
    if (out.length >= MAX_MAGPIE_MODELS) break;
  }
  return out;
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
