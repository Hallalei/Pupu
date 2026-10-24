/**
 * 电脑桥的帧。云端和本机桥共用这一份。
 *
 * 传输是一条可休眠的 WebSocket。心跳帧是固定字符串，云端用
 * `setWebSocketAutoResponse` 回 pong，不把 Durable Object 叫醒。
 * 其余帧都是 JSON。
 */

export const BRIDGE_PATH = "/api/bridge";
export const BRIDGE_TAG = "pupu-bridge";
export const BRIDGE_PING = "pupu:ping";
export const BRIDGE_PONG = "pupu:pong";
export const PROTOCOL_VERSION = 1;

/** 桥多久发一次心跳。 */
export const HEARTBEAT_MS = 10_000;
/** 超过这么久没有心跳，就当成掉线。 */
export const STALE_MS = 30_000;
/** 发出请求后，这么久还没有任何回包，就当成这台电脑没回应。 */
export const FIRST_BYTE_MS = 10_000;
export const FOREGROUND_DEFAULT_MS = 30_000;
export const FOREGROUND_MAX_MS = 120_000;

/** 交回给模型的输出，只留末尾这么多字符，完整的在终端文件里。 */
export const OUTPUT_TAIL_CHARS = 32_000;
/** 一次 write_file 的上限。再大就让模型用命令写。 */
export const MAX_WRITE_CHARS = 200_000;
export const MAX_READ_BYTES = 256 * 1024;
/** 和 Grok Bot 的文件传输上限对齐。单条 WebSocket 消息放不下时由工具层拦住。 */
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
export const MAX_LIST_ENTRIES = 500;
export const MAX_STDIN_CHARS = 100_000;

/** 这台电脑已经有一条健康连接，后来的连接让一下。 */
export const ALREADY_CONNECTED_CODE = 4000;
/** 凭据或协议不对，桥不该拿同一份凭据立刻重试。 */
export const REJECT_CODE = 1008;

export type RunAction = {
  readonly kind: "run";
  readonly command: string;
  readonly background: boolean;
};

/** 截图像素。原点在左上角，和发给模型的那张图同一套坐标。 */
export type ComputerOp =
  | "screenshot"
  | "permissions"
  | "click"
  | "move"
  | "drag"
  | "scroll"
  | "type"
  | "key";

export type ComputerAction = {
  readonly kind: "computer";
  readonly op: ComputerOp;
  readonly x?: number;
  readonly y?: number;
  readonly x2?: number;
  readonly y2?: number;
  readonly button?: "left" | "right" | "middle";
  readonly count?: number;
  readonly delta?: number;
  readonly text?: string;
  readonly key?: string;
};

export type Action =
  | RunAction
  | { readonly kind: "stdin"; readonly commandId: string; readonly data: string; readonly eof: boolean }
  | { readonly kind: "read"; readonly path: string; readonly maxBytes: number }
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "list"; readonly path: string }
  | ComputerAction;

/** 云端 → 桥。 */
export type DownFrame =
  | { readonly type: "welcome" }
  | { readonly type: "exec"; readonly requestId: string; readonly action: Action }
  | { readonly type: "cancel"; readonly requestId: string }
  /** 停止把输出往连接上送，进程继续跑，输出继续写进文件。 */
  | { readonly type: "detach"; readonly requestId: string };

export type ListEntry = {
  readonly name: string;
  readonly kind: "file" | "dir" | "other";
};

/** 桥 → 云端。`hello` 在连上之后发一次。 */
export type UpFrame =
  | {
      readonly type: "hello";
      readonly protocol: number;
      readonly computerId: string;
      readonly name: string;
      readonly localRoot: string;
      readonly terminalsFolder: string;
    }
  | { readonly type: "output"; readonly requestId: string; readonly text: string }
  | {
      readonly type: "started";
      readonly requestId: string;
      readonly commandId: string;
      readonly outputPath: string;
    }
  | { readonly type: "exit"; readonly requestId: string; readonly code: number | null }
  | { readonly type: "error"; readonly requestId: string; readonly message: string }
  | {
      readonly type: "data";
      readonly requestId: string;
      readonly text?: string;
      readonly bytes: number;
      readonly binary?: boolean;
      readonly truncated?: boolean;
    }
  | { readonly type: "listed"; readonly requestId: string; readonly entries: readonly ListEntry[]; readonly truncated: boolean }
  | { readonly type: "done"; readonly requestId: string; readonly path?: string }
  | {
      readonly type: "picture";
      readonly requestId: string;
      readonly mime: "image/jpeg";
      readonly width: number;
      readonly height: number;
      readonly screenWidth: number;
      readonly screenHeight: number;
      /** base64，不含 data: 前缀。 */
      readonly data: string;
      /** 当前窗口里能点的控件和坐标，给看不见图的模型用。 */
      readonly summary?: string;
    };

export type ComputerView = {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  /** 连着，但是心跳停了。界面上算离线，工具会说明是心跳。 */
  readonly stale: boolean;
  readonly lastSeenAt: number | null;
};

export function isBridgeRequest(request: Request): boolean {
  return new URL(request.url).pathname === BRIDGE_PATH;
}

export function tokenFromRequest(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const query = new URL(request.url).searchParams.get("token")?.trim();
  return query || null;
}

export function newDeviceToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `pbd_${body}`;
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bridgeWebSocketUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = BRIDGE_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

export function parseUpFrame(raw: string): UpFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const requestId = stringField(value, "requestId");
  switch (value.type) {
    case "hello": {
      const computerId = stringField(value, "computerId");
      const name = stringField(value, "name");
      const localRoot = stringField(value, "localRoot");
      const terminalsFolder = stringField(value, "terminalsFolder");
      if (
        value.protocol !== PROTOCOL_VERSION ||
        !computerId ||
        name === null ||
        !localRoot ||
        !terminalsFolder
      ) {
        return null;
      }
      return { type: "hello", protocol: PROTOCOL_VERSION, computerId, name, localRoot, terminalsFolder };
    }
    case "output":
      return requestId && typeof value.text === "string"
        ? { type: "output", requestId, text: value.text }
        : null;
    case "started": {
      const commandId = stringField(value, "commandId");
      const outputPath = stringField(value, "outputPath");
      return requestId && commandId && outputPath
        ? { type: "started", requestId, commandId, outputPath }
        : null;
    }
    case "exit":
      return requestId && (value.code === null || typeof value.code === "number")
        ? { type: "exit", requestId, code: value.code }
        : null;
    case "error":
      return requestId && typeof value.message === "string"
        ? { type: "error", requestId, message: value.message }
        : null;
    case "data":
      return requestId && typeof value.bytes === "number"
        ? {
            type: "data",
            requestId,
            bytes: value.bytes,
            ...(typeof value.text === "string" ? { text: value.text } : {}),
            ...(value.binary === true ? { binary: true } : {}),
            ...(value.truncated === true ? { truncated: true } : {})
          }
        : null;
    case "listed":
      return requestId && Array.isArray(value.entries)
        ? {
            type: "listed",
            requestId,
            entries: value.entries.flatMap((entry) => {
              if (!isRecord(entry) || typeof entry.name !== "string") return [];
              const kind = entry.kind === "dir" || entry.kind === "file" ? entry.kind : "other";
              return [{ name: entry.name, kind }];
            }),
            truncated: value.truncated === true
          }
        : null;
    case "done":
      return requestId
        ? {
            type: "done",
            requestId,
            ...(typeof value.path === "string" ? { path: value.path } : {})
          }
        : null;
    case "picture":
      return requestId &&
        value.mime === "image/jpeg" &&
        typeof value.width === "number" &&
        typeof value.height === "number" &&
        typeof value.screenWidth === "number" &&
        typeof value.screenHeight === "number" &&
        typeof value.data === "string" &&
        value.data.length > 0 &&
        value.data.length <= 4_000_000
        ? {
            type: "picture",
            requestId,
            mime: "image/jpeg",
            width: value.width,
            height: value.height,
            screenWidth: value.screenWidth,
            screenHeight: value.screenHeight,
            data: value.data,
            ...(typeof value.summary === "string" && value.summary.length > 0
              ? { summary: value.summary.slice(0, 8_000) }
              : {})
          }
        : null;
    default:
      return null;
  }
}

export function parseDownFrame(raw: string): DownFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const requestId = stringField(value, "requestId");
  switch (value.type) {
    case "welcome":
      return { type: "welcome" };
    case "cancel":
      return requestId ? { type: "cancel", requestId } : null;
    case "detach":
      return requestId ? { type: "detach", requestId } : null;
    case "exec":
      return requestId && isAction(value.action) ? { type: "exec", requestId, action: value.action } : null;
    default:
      return null;
  }
}

function isAction(value: unknown): value is Action {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "run":
      return typeof value.command === "string" && typeof value.background === "boolean";
    case "stdin":
      return typeof value.commandId === "string" && typeof value.data === "string" && typeof value.eof === "boolean";
    case "read":
      return typeof value.path === "string" && typeof value.maxBytes === "number";
    case "write":
      return typeof value.path === "string" && typeof value.content === "string";
    case "list":
      return typeof value.path === "string";
    case "computer":
      return (
        value.op === "screenshot" ||
        value.op === "permissions" ||
        value.op === "click" ||
        value.op === "move" ||
        value.op === "drag" ||
        value.op === "scroll" ||
        value.op === "type" ||
        value.op === "key"
      );
    default:
      return false;
  }
}

/** 请求 id 落到文件名上。桥用它给同一次调用去重。 */
export function safeRequestId(id: string): string {
  if (/^[A-Za-z0-9_-]{1,120}$/.test(id)) return id;
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `r${(hash >>> 0).toString(16)}`;
}
