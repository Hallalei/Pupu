import { parseDesktopDown, parseDesktopUp, type DesktopDown, type DesktopUp } from "./desktop.ts";
import { parseModelDown, parseModelUp, type LocalModelInfo, type ModelDown, type ModelUp } from "./model-relay.ts";
import type { ComputerPolicy } from "./policy.ts";

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
/** 取消发出去以后，最多等电脑这么久说一声做没做。 */
export const CANCEL_CONFIRM_MS = 3_000;
export const FOREGROUND_DEFAULT_MS = 30_000;
export const FOREGROUND_MAX_MS = 120_000;

/** 交回给模型的输出，只留末尾这么多字符，完整的在终端文件里。 */
export const OUTPUT_TAIL_CHARS = 32_000;
/** 交出去的命令退出时，回到对话里的那段输出最多这么长。 */
export const FINISHED_TAIL_CHARS = 2_000;
/** 一次 write_file 的上限。再大就让模型用命令写。 */
export const MAX_WRITE_CHARS = 200_000;
export const MAX_READ_BYTES = 256 * 1024;
/** 和 Grok Bot 的文件传输上限对齐。单条 WebSocket 消息放不下时由工具层拦住。 */
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
export const MAX_LIST_ENTRIES = 500;
export const MAX_STDIN_CHARS = 100_000;

/** 这台电脑已经有一条健康连接，后来的连接让一下。 */
export const ALREADY_CONNECTED_CODE = 4000;
/** 凭据不对，桥不该拿同一份凭据立刻重试。 */
export const REJECT_CODE = 1008;
/**
 * 凭据没问题，是桥的协议版本和云端对不上。不用 REJECT_CODE：0.2.1 之前的桥见了它会删掉凭据，
 * 见了不认识的码只当断线，隔一会儿再连。
 */
export const OUTDATED_CODE = 4010;

export type RunAction = {
  readonly kind: "run";
  readonly command: string;
  readonly background: boolean;
};

const COMPUTER_OPS = ["permissions", "windows", "look", "open", "click", "drag", "scroll", "type", "set", "key", "menu"] as const;

export type ComputerOp = (typeof COMPUTER_OPS)[number];

/** 按窗口操作，不碰用户的鼠标和前台。 */
export type ComputerAction = {
  readonly kind: "computer";
  readonly op: ComputerOp;
  /** `windows` 的筛选，`open` 要开的应用。 */
  readonly app?: string;
  /** `open` 用这个应用打开的文件或网址。 */
  readonly path?: string;
  /** `look` 只看名字里带这段文字的控件。 */
  readonly query?: string;
  readonly pid?: number;
  readonly windowId?: number;
  /** `look` 给的控件编号，比如 s0000002a:11。 */
  readonly element?: string;
  /** 这个窗口截图上的像素，原点在窗口左上角。 */
  readonly x?: number;
  readonly y?: number;
  readonly x2?: number;
  readonly y2?: number;
  readonly button?: "left" | "right" | "middle";
  readonly count?: number;
  readonly direction?: "up" | "down" | "left" | "right";
  readonly amount?: number;
  /** `type` 要输入的文字，`set` 要设的值。 */
  readonly text?: string;
  readonly key?: string;
  /** 菜单路径，从顶层到要点的那一项。 */
  readonly menu?: readonly string[];
  /** 点的是什么，审批和聊天记录里给人看。 */
  readonly label?: string;
  /** 后台做不到时才用：短暂切到前面，做完切回去。 */
  readonly foreground?: boolean;
  /** 这一步会发消息、付款、提交或删除。分级里算高风险，单独审批。 */
  readonly sensitive?: boolean;
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
  | {
      readonly type: "exec";
      readonly requestId: string;
      readonly action: Action;
      /** 用户批过这一步、屏幕授权还有效，或者分级是都放行。高风险动作和屏幕操作，桥只认带它的。 */
      readonly approved?: boolean;
    }
  | { readonly type: "cancel"; readonly requestId: string }
  /** 停止把输出往连接上送，进程继续跑，输出继续写进文件。 */
  | { readonly type: "detach"; readonly requestId: string }
  /** 菜单栏上要显示的：这台电脑在等批准的动作、屏幕授权还在不在。 */
  | { readonly type: "status"; readonly pending: readonly string[]; readonly screen: boolean }
  /** 远程桌面的信令和控制，见 desktop.ts。 */
  | { readonly type: "desktop"; readonly session: string; readonly message: DesktopDown }
  /** 经电脑转发的模型请求，见 model-relay.ts。 */
  | { readonly type: "model"; readonly message: ModelDown };

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
  /** 用户在电脑的菜单栏上收回了屏幕控制。 */
  | { readonly type: "takeback" }
  /** 有没有人在用这台电脑：键盘鼠标最近动过。变了才发，连上时发一次。 */
  | { readonly type: "presence"; readonly active: boolean }
  /**
   * 交出去的命令（后台命令、前台到时间转后台）退出了。那次调用早就结束了，云端凭它回到发起的那条对话。
   * 只送最后一段输出，全文在 `outputPath`。
   */
  | {
      readonly type: "finished";
      readonly requestId: string;
      readonly commandId: string;
      readonly command: string;
      readonly code: number | null;
      readonly outputPath: string;
      readonly tail: string;
      readonly stopped?: "user" | "cloud";
    }
  | { readonly type: "desktop"; readonly session: string; readonly message: DesktopUp }
  /** 本地模型的信息和转发的响应，见 model-relay.ts。 */
  | { readonly type: "model"; readonly message: ModelUp }
  | {
      readonly type: "started";
      readonly requestId: string;
      readonly commandId: string;
      readonly outputPath: string;
    }
  | {
      readonly type: "exit";
      readonly requestId: string;
      readonly code: number | null;
      /** 命令是被停掉的：用户在电脑上停的，或者云端取消的。自己退出的没有。 */
      readonly stopped?: "user" | "cloud";
    }
  | { readonly type: "error"; readonly requestId: string; readonly message: string }
  /** 云端取消时这一步还没动手，桥没做。 */
  | { readonly type: "cancelled"; readonly requestId: string }
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
      /** base64，不含 data: 前缀。 */
      readonly data: string;
      /** 这个窗口的控件和编号。 */
      readonly summary?: string;
    };

export type ComputerView = {
  readonly id: string;
  readonly name: string;
  /** 主人的成员 id（见 apps/cloud/src/members.ts）。还没主人是 null。 */
  readonly ownerId: string | null;
  readonly online: boolean;
  /** 连着，但是心跳停了。界面上算离线，工具会说明是心跳。 */
  readonly stale: boolean;
  readonly lastSeenAt: number | null;
  readonly policy: ComputerPolicy;
  /** 屏幕授权还有效。 */
  readonly screen: boolean;
  /** 在线时，有没有人正在用它（键盘鼠标 1 分钟内动过）。老的桥不报，没有这一项。 */
  readonly inUse?: boolean;
  /** 在线、桥报过本地模型时才有：这台电脑上设的模型，null 是没设。老的桥不报，没有这一项。 */
  readonly model?: LocalModelInfo | null;
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

/** 协议版本和这边不一样的 hello。那个版本别的字段可能也改了，不读，只拿来拒掉。不是线上的帧。 */
export type OutdatedHello = { readonly type: "outdated" };

export function parseUpFrame(raw: string): UpFrame | OutdatedHello | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const requestId = stringField(value, "requestId");
  switch (value.type) {
    case "takeback":
      return { type: "takeback" };
    case "presence":
      return typeof value.active === "boolean" ? { type: "presence", active: value.active } : null;
    case "finished": {
      const commandId = stringField(value, "commandId");
      const command = stringField(value, "command");
      const outputPath = stringField(value, "outputPath");
      const tail = stringField(value, "tail");
      const code = value.code === null || typeof value.code === "number" ? value.code : undefined;
      if (!requestId || !commandId || command === null || !outputPath || tail === null || code === undefined) return null;
      return {
        type: "finished",
        requestId,
        commandId,
        command,
        code,
        outputPath,
        tail: tail.slice(-FINISHED_TAIL_CHARS),
        ...(value.stopped === "user" || value.stopped === "cloud" ? { stopped: value.stopped } : {})
      };
    }
    case "desktop": {
      const session = stringField(value, "session");
      const message = parseDesktopUp(value.message);
      return session && message ? { type: "desktop", session, message } : null;
    }
    case "model": {
      const message = parseModelUp(value.message);
      return message ? { type: "model", message } : null;
    }
    case "hello": {
      if (value.protocol !== PROTOCOL_VERSION) return { type: "outdated" };
      const computerId = stringField(value, "computerId");
      const name = stringField(value, "name");
      const localRoot = stringField(value, "localRoot");
      const terminalsFolder = stringField(value, "terminalsFolder");
      if (!computerId || name === null || !localRoot || !terminalsFolder) return null;
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
        ? {
            type: "exit",
            requestId,
            code: value.code,
            ...(value.stopped === "user" || value.stopped === "cloud" ? { stopped: value.stopped } : {})
          }
        : null;
    case "cancelled":
      return requestId ? { type: "cancelled", requestId } : null;
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
        typeof value.data === "string" &&
        value.data.length > 0 &&
        value.data.length <= 4_000_000
        ? {
            type: "picture",
            requestId,
            mime: "image/jpeg",
            width: value.width,
            height: value.height,
            data: value.data,
            ...(typeof value.summary === "string" && value.summary.length > 0
              ? { summary: value.summary.slice(0, 16_000) }
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
    case "desktop": {
      const session = stringField(value, "session");
      const message = parseDesktopDown(value.message);
      return session && message ? { type: "desktop", session, message } : null;
    }
    case "model": {
      const message = parseModelDown(value.message);
      return message ? { type: "model", message } : null;
    }
    case "cancel":
      return requestId ? { type: "cancel", requestId } : null;
    case "detach":
      return requestId ? { type: "detach", requestId } : null;
    case "exec":
      return requestId && isAction(value.action)
        ? { type: "exec", requestId, action: value.action, ...(value.approved === true ? { approved: true } : {}) }
        : null;
    case "status":
      return Array.isArray(value.pending)
        ? {
            type: "status",
            pending: value.pending.filter((item): item is string => typeof item === "string").slice(0, 20),
            screen: value.screen === true
          }
        : null;
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
      return (COMPUTER_OPS as readonly unknown[]).includes(value.op);
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
