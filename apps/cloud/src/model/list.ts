/**
 * 一家服务商能选哪些模型：目录里的，加上用这个 key 拉 `/models` 拉到的。拉到了以实时的为准，目录只补资料；
 * 实时有、目录没有的按保守默认值，用户可以在「高级」里改。拉不到就给目录，再不行就让用户手填模型名，不卡住保存。
 *
 * 解析 `/models` 的几种形状、读上下文的字段名照 Cindy 的 parseModelsListResponse
 * （makecindy/cindy packages/model-providers/src/modelDiscovery.ts，Apache-2.0）：
 * `{data:[{id}]}`、`{models:[{id|name}]}`、字符串数组；上下文认 context_length / context_window /
 * max_context_length / max_input_tokens / inputTokenLimit。请求不跟重定向，响应最多读 1 MiB。
 */

import type { Template } from "./catalog.ts";
import { catalogModels } from "./catalog-models.ts";
import { DEFAULT_CONTEXT, MIN_CONTEXT } from "./settings.ts";

export type ModelOption = {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly vision: boolean;
  readonly reasoning: boolean;
  /** 目录里有资料的。没有的上下文是猜的。 */
  readonly known: boolean;
};

export type ModelList = {
  readonly models: readonly ModelOption[];
  /** 拉 `/models` 没成功时说为什么。 */
  readonly error: string | null;
};

const LIST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MODELS = 2000;

export async function listModels(
  template: Template,
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<ModelList> {
  const catalog = catalogModels(template).map(
    (model): ModelOption => ({
      id: model.id,
      name: model.name || model.id,
      contextWindow: model.contextWindow,
      vision: model.input.includes("image"),
      reasoning: model.reasoning,
      known: true
    })
  );
  const usable = (models: ModelOption[]) => models.filter((model) => model.contextWindow >= MIN_CONTEXT);
  if (!template.live || !apiKey || !baseUrl) return { models: usable(catalog), error: null };
  const fetched = await fetchList(template, baseUrl, apiKey, fetchImpl);
  if (!fetched.ok) return { models: usable(catalog), error: fetched.error };
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const merged = fetched.models.map((live) => {
    const known = byId.get(live.id);
    if (known) return known;
    return {
      id: live.id,
      name: live.name,
      contextWindow: live.contextWindow ?? DEFAULT_CONTEXT,
      vision: false,
      reasoning: false,
      known: false
    } satisfies ModelOption;
  });
  return { models: usable(merged), error: null };
}

type Live = { readonly id: string; readonly name: string; readonly contextWindow?: number };

async function fetchList(
  template: Template,
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch
): Promise<{ ok: true; models: Live[] } | { ok: false; error: string }> {
  const headers: Record<string, string> = { accept: "application/json" };
  let url: string;
  if (template.api === "anthropic-messages") {
    url = `${baseUrl}/v1/models?limit=1000`;
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (template.api === "google-generative-ai") {
    url = `${baseUrl}/models?pageSize=1000`;
    headers["x-goog-api-key"] = apiKey;
  } else {
    url = `${baseUrl}/models`;
    headers.authorization = `Bearer ${apiKey}`;
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  } catch {
    // 连不上、超时：原话多半是英文（「Network connection lost.」）。为什么连不上，按「保存」试的时候会写。
    return { ok: false, error: "拉不到模型列表，可以直接填模型名。" };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { ok: false, error: "拉模型列表时被重定向了，地址要填最终的那个。" };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return { ok: false, error: `key 不对（${response.status}）。` };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, error: `拉不到模型列表（${response.status}），可以直接填模型名。` };
  }
  const text = await readLimited(response);
  if (text === null) return { ok: false, error: "模型列表太大了，可以直接填模型名。" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "模型列表不是 JSON，可以直接填模型名。" };
  }
  const models = parseModelsList(body);
  if (!models || models.length === 0) return { ok: false, error: "这个地址没列出模型，可以直接填模型名。" };
  return { ok: true, models };
}

async function readLimited(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
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
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tokens(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** 认不出来返回 null。 */
export function parseModelsList(body: unknown): Live[] | null {
  const root = record(body);
  const entries: unknown[] | null = Array.isArray(body)
    ? body
    : Array.isArray(root?.data)
      ? (root.data as unknown[])
      : Array.isArray(root?.models)
        ? (root.models as unknown[])
        : null;
  if (!entries) return null;
  const seen = new Set<string>();
  const out: Live[] = [];
  for (const entry of entries) {
    const item = record(entry);
    let id = typeof entry === "string" ? entry : typeof item?.id === "string" ? item.id : typeof item?.name === "string" ? item.name : "";
    // Gemini 的是 models/gemini-…，调用时不带前缀。
    if (item && typeof item.name === "string" && item.name.startsWith("models/") && !item.id) id = item.name.slice("models/".length);
    id = id.trim();
    if (!id || id.length > 256 || seen.has(id)) continue;
    // Gemini 列表里有嵌入、画图模型，只留能聊天的。
    const methods = item?.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes("generateContent")) continue;
    seen.add(id);
    const name = typeof item?.display_name === "string" ? item.display_name : typeof item?.displayName === "string" ? item.displayName : id;
    const contextWindow =
      tokens(item?.context_length) ??
      tokens(item?.context_window) ??
      tokens(item?.max_context_length) ??
      tokens(item?.max_input_tokens) ??
      tokens(item?.inputTokenLimit);
    out.push({ id, name: name.slice(0, 256), ...(contextWindow ? { contextWindow } : {}) });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}
