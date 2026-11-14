/**
 * 经电脑转发模型请求（docs/自带模型方案.md 第 2 节）。
 *
 * 云端照常用 pi-ai 的 OpenAI 兼容实现拼请求、解析流，只把它的 `fetch` 换成这里的 `ModelRelay.fetch`：
 * 请求体切成几片经桥发给电脑，电脑用自己存的地址和 key 调模型，把响应原样（状态码、SSE 文本）传回来。
 * 地址和 key 只在电脑上；云端发过去的只有请求体，电脑只认请求体，URL 和 Authorization 一律用本地的。
 *
 * 帧包在桥协议的 `{ type: "model", message }` 里，和远程桌面一样。老的桥不认识 `model` 帧，会静默丢掉；
 * 所以云端只给连上后报过 `info` 的电脑转发。
 *
 * 电脑上开着 Magpie 的，桥另报一份 `magpie` 清单；请求带 `target: "magpie"` 的转给它。老的云端不认识 `magpie` 帧，
 * 丢掉就是；老的桥不认识 `target`，会转给本地设的模型，所以云端只给报过清单的电脑发这种请求。
 */

/** 电脑报给云端的本地模型，不含地址和 key。 */
export type LocalModelInfo = {
  readonly name: string;
  readonly vision: boolean;
  readonly contextWindow: number;
};

/** 电脑上 Magpie 里能用的一个模型。`name` 是 Magpie 起的名字。 */
export type MagpieModel = {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly vision: boolean;
  readonly reasoning: boolean;
};

export type ModelTarget = "local" | "magpie";

/** 云端 → 电脑。 */
export type ModelDown =
  /** 请求体的一片。`last` 的那片到了，电脑开始调模型。`target` 只在第一片上有，没有是本地设的模型。 */
  | {
      readonly kind: "request";
      readonly id: string;
      readonly seq: number;
      readonly text: string;
      readonly last: boolean;
      readonly target?: ModelTarget;
    }
  | { readonly kind: "cancel"; readonly id: string };

/** 电脑 → 云端。 */
export type ModelUp =
  /** 连上时报一次，本地设置变了再报。null 是这台电脑没设模型。 */
  | { readonly kind: "info"; readonly model: LocalModelInfo | null }
  /** 连上时报一次，Magpie 开了、关了、清单变了再报。null 是这台电脑上没开 Magpie。 */
  | { readonly kind: "magpie"; readonly models: readonly MagpieModel[] | null }
  /** 请求体收齐了，开始调。 */
  | { readonly kind: "ack"; readonly id: string }
  /** 上游回了响应头。连不上上游时电脑自己回 502，正文说明原因。 */
  | { readonly kind: "head"; readonly id: string; readonly status: number; readonly contentType: string }
  | { readonly kind: "chunk"; readonly id: string; readonly text: string }
  /** 响应读完了。`error` 是读到一半断了。 */
  | { readonly kind: "end"; readonly id: string; readonly error?: string };

/**
 * 一片请求体最多这么多字符。截图多的上下文有好几 MB，一条 WebSocket 消息放不下也不该放。
 * 按字符切：最坏是全是 \uXXXX 转义或中文，一片也不过几百 KB。
 */
export const MODEL_PIECE_CHARS = 64 * 1024;
/** 一片响应最多这么多字符，电脑那边按这个切。 */
export const MODEL_CHUNK_CHARS = 64 * 1024;
/** 请求体发完以后，电脑这么久还没说收到，就当它没回应。 */
export const MODEL_ACK_MS = 15_000;
/** 收到 ack 以后，响应头和每一块之间最多等这么久。本地模型处理长上下文可能要好几分钟。 */
export const MODEL_IDLE_MS = 5 * 60_000;
/** 请求体最大多大。和桥的文件传输上限一个量级，再大就是上下文出了问题。 */
export const MAX_MODEL_BODY_CHARS = 64 * 1024 * 1024;
const MAX_NAME_CHARS = 200;
const MAX_MAGPIE_MODELS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseLocalModelInfo(value: unknown): LocalModelInfo | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) return null;
  const contextWindow = typeof value.contextWindow === "number" && value.contextWindow > 0 ? value.contextWindow : null;
  if (contextWindow === null) return null;
  return {
    name: value.name.trim().slice(0, MAX_NAME_CHARS),
    vision: value.vision === true,
    contextWindow: Math.floor(contextWindow)
  };
}

export function parseMagpieModels(value: unknown): MagpieModel[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: MagpieModel[] = [];
  for (const item of value.slice(0, MAX_MAGPIE_MODELS)) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim() || item.id.length > MAX_NAME_CHARS) continue;
    const id = item.id.trim();
    const contextWindow = typeof item.contextWindow === "number" && item.contextWindow > 0 ? Math.floor(item.contextWindow) : 0;
    if (!contextWindow || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: (typeof item.name === "string" && item.name.trim() ? item.name.trim() : id).slice(0, MAX_NAME_CHARS),
      contextWindow,
      vision: item.vision === true,
      reasoning: item.reasoning === true
    });
  }
  return out;
}

export function parseModelUp(value: unknown): ModelUp | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "info") {
    return { kind: "info", model: value.model === null ? null : parseLocalModelInfo(value.model) };
  }
  if (value.kind === "magpie") {
    if (value.models === null) return { kind: "magpie", models: null };
    const models = parseMagpieModels(value.models);
    return models ? { kind: "magpie", models } : null;
  }
  const id = typeof value.id === "string" && value.id ? value.id : null;
  if (!id) return null;
  switch (value.kind) {
    case "ack":
      return { kind: "ack", id };
    case "head":
      return typeof value.status === "number" && value.status >= 100 && value.status <= 599
        ? { kind: "head", id, status: value.status, contentType: typeof value.contentType === "string" ? value.contentType : "" }
        : null;
    case "chunk":
      return typeof value.text === "string" && value.text.length <= MODEL_CHUNK_CHARS * 4
        ? { kind: "chunk", id, text: value.text }
        : null;
    case "end":
      return { kind: "end", id, ...(typeof value.error === "string" ? { error: value.error.slice(0, 500) } : {}) };
    default:
      return null;
  }
}

export function parseModelDown(value: unknown): ModelDown | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  if (value.kind === "cancel") return { kind: "cancel", id: value.id };
  if (value.kind !== "request") return null;
  return typeof value.seq === "number" && typeof value.text === "string" && value.text.length <= MODEL_PIECE_CHARS
    ? {
        kind: "request",
        id: value.id,
        seq: value.seq,
        text: value.text,
        last: value.last === true,
        ...(value.target === "magpie" ? { target: "magpie" as const } : {})
      }
    : null;
}

/** 把请求体切片。 */
export function requestPieces(id: string, body: string, target: ModelTarget = "local"): ModelDown[] {
  const pieces: ModelDown[] = [];
  for (let start = 0, seq = 0; start < body.length || seq === 0; start += MODEL_PIECE_CHARS, seq += 1) {
    const text = body.slice(start, start + MODEL_PIECE_CHARS);
    pieces.push({
      kind: "request",
      id,
      seq,
      text,
      last: start + MODEL_PIECE_CHARS >= body.length,
      ...(seq === 0 && target === "magpie" ? { target } : {})
    });
  }
  return pieces;
}

type Pending = {
  readonly computerId: string;
  stage: "sent" | "acked" | "streaming" | "done";
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: Error) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  readonly cleanup: () => void;
};

export type ModelRelayOptions = {
  /** 往这台电脑的桥发一帧。没连着返回 false。 */
  readonly send: (computerId: string, message: ModelDown) => boolean;
  readonly newId?: () => string;
};

/**
 * 云端这头：给 pi-ai 一个 `fetch`，背后是桥。只在内存里；DO 重启后在途的请求随调用一起作废，pi 会重试。
 * 出错的文字带上 pi 认得的英文词（connection lost、timeout），好让它按可重试处理。
 */
export class ModelRelay {
  readonly #send: ModelRelayOptions["send"];
  readonly #newId: () => string;
  readonly #pending = new Map<string, Pending>();
  readonly #encoder = new TextEncoder();

  constructor(options: ModelRelayOptions) {
    this.#send = options.send;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** 在途的请求数，测试用。 */
  get size(): number {
    return this.#pending.size;
  }

  fetch(computerId: string, target: ModelTarget = "local"): typeof fetch {
    return async (input, init) => {
      const body = await bodyText(input, init);
      if (body.length > MAX_MODEL_BODY_CHARS) throw new Error("模型请求太大，转发不了。");
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.throwIfAborted();
      const id = this.#newId();
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => this.#abort(id);
        const pending: Pending = {
          computerId,
          stage: "sent",
          timer: undefined,
          resolve,
          reject,
          controller: null,
          cleanup: () => signal?.removeEventListener("abort", onAbort)
        };
        this.#pending.set(id, pending);
        signal?.addEventListener("abort", onAbort, { once: true });
        for (const piece of requestPieces(id, body, target)) {
          if (!this.#send(computerId, piece)) {
            this.#fail(id, "relay connection refused: 电脑没连上");
            return;
          }
        }
        this.#arm(id, MODEL_ACK_MS, "relay timeout: 电脑没有回应");
      });
    };
  }

  /** 桥发来的。 */
  receive(computerId: string, message: ModelUp): void {
    if (message.kind === "info" || message.kind === "magpie") return;
    const pending = this.#pending.get(message.id);
    if (!pending || pending.computerId !== computerId) return;
    switch (message.kind) {
      case "ack":
        if (pending.stage === "sent") pending.stage = "acked";
        this.#arm(message.id, MODEL_IDLE_MS, "relay timeout: 模型很久没有回话");
        return;
      case "head": {
        if (pending.stage === "streaming" || pending.stage === "done") return;
        pending.stage = "streaming";
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            pending.controller = controller;
          },
          cancel: () => this.#abort(message.id)
        });
        const headers = new Headers();
        if (message.contentType) headers.set("content-type", message.contentType);
        pending.resolve(new Response(stream, { status: message.status, headers }));
        this.#arm(message.id, MODEL_IDLE_MS, "relay timeout: 模型很久没有回话");
        return;
      }
      case "chunk":
        if (pending.stage !== "streaming" || !pending.controller) return;
        pending.controller.enqueue(this.#encoder.encode(message.text));
        this.#arm(message.id, MODEL_IDLE_MS, "relay timeout: 模型很久没有回话");
        return;
      case "end":
        if (message.error) {
          this.#fail(message.id, `relay connection lost: ${message.error}`);
          return;
        }
        if (pending.stage !== "streaming") {
          this.#fail(message.id, "relay connection lost: 电脑没有回响应");
          return;
        }
        this.#finish(message.id);
        pending.controller?.close();
        return;
    }
  }

  /** 这台电脑的桥断了：它上面在途的请求都断。 */
  gone(computerId: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.computerId === computerId) this.#fail(id, "relay connection lost: 电脑断开了");
    }
  }

  #arm(id: string, ms: number, reason: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.#send(pending.computerId, { kind: "cancel", id });
      this.#fail(id, reason);
    }, ms);
  }

  #abort(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#send(pending.computerId, { kind: "cancel", id });
    const error = new DOMException("模型请求取消了", "AbortError");
    this.#finish(id);
    if (pending.controller) {
      try {
        pending.controller.error(error);
      } catch {
        // 流已经关了。
      }
    } else pending.reject(error);
  }

  #fail(id: string, reason: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#finish(id);
    const error = new Error(reason);
    if (pending.controller) {
      try {
        pending.controller.error(error);
      } catch {
        // 流已经关了。
      }
    } else pending.reject(error);
  }

  #finish(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.stage = "done";
    pending.cleanup();
    this.#pending.delete(id);
  }
}

async function bodyText(input: RequestInfo | URL, init: RequestInit | undefined): Promise<string> {
  const body = init?.body ?? (input instanceof Request ? input.body : null);
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  return new Response(body).text();
}
