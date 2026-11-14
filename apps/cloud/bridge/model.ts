import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MODEL_CHUNK_CHARS,
  MAX_MODEL_BODY_CHARS,
  type LocalModelInfo,
  type ModelDown,
  type ModelUp
} from "../src/bridge/model-relay.ts";
import { DEFAULT_CONTEXT, MIN_CONTEXT, normalizeBaseUrl } from "../src/model/settings.ts";
import { pupuDir } from "./config.ts";
import type { Magpie } from "./magpie.ts";

/**
 * 这台电脑上的模型（docs/自带模型方案.md 第 2 节）。地址和 key 只在这里，云端只知道模型名、上下文多长、能不能看图。
 * 命令行的桥存在 ~/.pupu/model.json（0600，文件工具碰不到）；电脑 App 用 safeStorage 加密存，解开后交给桥。
 */
export type LocalModel = {
  readonly baseUrl: string;
  /** 本地的 ollama 之类可以没有 key。 */
  readonly apiKey: string;
  readonly model: string;
  readonly vision: boolean;
  readonly contextWindow: number;
};

export function modelPath(): string {
  return path.join(pupuDir(), "model.json");
}

export function infoOf(model: LocalModel | null): LocalModelInfo | null {
  return model ? { name: model.model, vision: model.vision, contextWindow: model.contextWindow } : null;
}

/** 校验并整理用户填的。电脑上的模型可以是 http：内网和本机的服务大多没有证书。 */
export function parseLocalModel(value: unknown): LocalModel | string {
  if (typeof value !== "object" || value === null) return "设置不对。";
  const input = value as Record<string, unknown>;
  const baseUrl = normalizeBaseUrl(String(input.baseUrl ?? ""));
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "地址要以 http:// 或 https:// 开头。";
  } catch {
    return "地址不对，要像 http://localhost:11434/v1 这样。";
  }
  const model = String(input.model ?? "").trim();
  if (!model || model.length > 200) return "填上模型名。";
  const contextWindow = input.contextWindow === undefined || input.contextWindow === null || input.contextWindow === ""
    ? DEFAULT_CONTEXT
    : Number(input.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow < MIN_CONTEXT) return `上下文至少要 ${MIN_CONTEXT / 1000}k。`;
  return {
    baseUrl,
    apiKey: String(input.apiKey ?? "").trim(),
    model,
    vision: input.vision === true,
    contextWindow: Math.floor(contextWindow)
  };
}

export async function readModelFile(): Promise<LocalModel | null> {
  let raw: string;
  try {
    raw = await readFile(modelPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = parseLocalModel(JSON.parse(raw));
    return typeof parsed === "string" ? null : parsed;
  } catch {
    return null;
  }
}

export async function writeModelFile(model: LocalModel | null): Promise<void> {
  const target = modelPath();
  if (!model) {
    await rm(target, { force: true });
    return;
  }
  await mkdir(pupuDir(), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(model, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

type Incoming = { pieces: string[]; size: number; controller: AbortController | null; magpie: boolean };

/**
 * 桥这头：收齐请求体，用本地的地址和 key 调模型，把响应原样传回去。
 * 只认请求体：URL 和 Authorization 一律用本地配置，`model` 也换成本地的，云端指不了别的地方。
 * 连不上上游时自己回 502 说明原因，云端的 pi 按服务端错误重试，用户看得到为什么。
 */
export class ModelRelayClient {
  readonly #send: (message: ModelUp) => boolean;
  readonly #current: () => LocalModel | null;
  readonly #magpie: () => Promise<Magpie | null>;
  readonly #fetch: typeof fetch;
  readonly #incoming = new Map<string, Incoming>();

  constructor(options: {
    send: (message: ModelUp) => boolean;
    current: () => LocalModel | null;
    /** 这台电脑上的 Magpie。只转给它报过的模型，地址也只用这里的。 */
    magpie?: () => Promise<Magpie | null>;
    fetch?: typeof fetch;
  }) {
    this.#send = options.send;
    this.#current = options.current;
    this.#magpie = options.magpie ?? (async () => null);
    this.#fetch = options.fetch ?? fetch;
  }

  receive(message: ModelDown): void {
    if (message.kind === "cancel") {
      const incoming = this.#incoming.get(message.id);
      incoming?.controller?.abort();
      this.#incoming.delete(message.id);
      return;
    }
    let incoming = this.#incoming.get(message.id);
    if (!incoming) {
      if (message.seq !== 0) return;
      incoming = { pieces: [], size: 0, controller: null, magpie: message.target === "magpie" };
      this.#incoming.set(message.id, incoming);
    }
    if (incoming.controller || message.seq !== incoming.pieces.length) {
      this.#reply(message.id, 400, "模型请求的分片乱了。");
      return;
    }
    incoming.pieces.push(message.text);
    incoming.size += message.text.length;
    if (incoming.size > MAX_MODEL_BODY_CHARS) {
      this.#reply(message.id, 413, "模型请求太大。");
      return;
    }
    if (message.last) void this.#call(message.id, incoming);
  }

  /** 连接断了：停掉所有在途的请求，云端那边也已经当断了。 */
  stopAll(): void {
    for (const incoming of this.#incoming.values()) incoming.controller?.abort();
    this.#incoming.clear();
  }

  async #call(id: string, incoming: Incoming): Promise<void> {
    const controller = new AbortController();
    incoming.controller = controller;
    this.#send({ kind: "ack", id });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(incoming.pieces.join("")) as Record<string, unknown>;
    } catch {
      this.#reply(id, 400, "模型请求不是 JSON。");
      return;
    }
    let target: { baseUrl: string; apiKey: string };
    if (incoming.magpie) {
      const magpie = await this.#magpie();
      if (!magpie) {
        this.#reply(id, 503, "这台电脑上的 Magpie 没开。打开 Magpie 再试。");
        return;
      }
      // 模型名由云端指定，但只能是这台电脑报过的那几个。
      if (typeof body.model !== "string" || !magpie.models.some((model) => model.id === body.model)) {
        this.#reply(id, 404, "Magpie 里没有这个模型了，到设置里重新选一个。");
        return;
      }
      target = { baseUrl: magpie.baseUrl, apiKey: "" };
    } else {
      const local = this.#current();
      if (!local) {
        this.#reply(id, 503, "这台电脑上没有设模型。");
        return;
      }
      body.model = local.model;
      target = local;
    }
    let response: Response;
    try {
      response = await this.#fetch(`${target.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: body.stream === true ? "text/event-stream" : "application/json",
          ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) return this.#forget(id);
      this.#reply(
        id,
        502,
        incoming.magpie ? `这台电脑连不上 Magpie：${causeOf(error)}` : `这台电脑连不上它设的模型服务：${causeOf(error)}`
      );
      return;
    }
    if (!this.#incoming.has(id)) {
      controller.abort();
      return;
    }
    this.#send({ kind: "head", id, status: response.status, contentType: response.headers.get("content-type") ?? "" });
    try {
      if (response.body) {
        const decoder = new TextDecoder();
        for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
          const text = decoder.decode(bytes, { stream: true });
          if (text) this.#chunks(id, text);
        }
        const rest = decoder.decode();
        if (rest) this.#chunks(id, rest);
      }
      this.#send({ kind: "end", id });
    } catch (error) {
      if (!controller.signal.aborted) this.#send({ kind: "end", id, error: causeOf(error) });
    } finally {
      this.#forget(id);
    }
  }

  #chunks(id: string, text: string): void {
    for (let start = 0; start < text.length; start += MODEL_CHUNK_CHARS) {
      this.#send({ kind: "chunk", id, text: text.slice(start, start + MODEL_CHUNK_CHARS) });
    }
  }

  /** 自己回一个错误响应。正文是 OpenAI 的错误格式，pi 能把原因显示出来。 */
  #reply(id: string, status: number, message: string): void {
    this.#send({ kind: "head", id, status, contentType: "application/json" });
    this.#send({ kind: "chunk", id, text: JSON.stringify({ error: { message, type: "pupu_relay" } }) });
    this.#send({ kind: "end", id });
    this.#forget(id);
  }

  #forget(id: string): void {
    this.#incoming.delete(id);
  }
}

/** 只给错误码，不带地址：这句话会进聊天，成员都看得到，内网的主机名不该露出去。 */
function causeOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: { code?: unknown } }).cause;
  const code = cause && typeof cause.code === "string" ? cause.code : "";
  return code ? `${error.message}（${code}）` : error.message;
}
