/**
 * 远程桌面的信令和租约（技术方案第 6 节）。手机和网页连 `/api/desktop/:computerId`，这里把消息转给这台电脑的桥；
 * 视频和键鼠走 WebRTC 点对点，不经过这里。做法参考 Cindy 的 docs/remote-desktop.md（Apache-2.0）：
 * 一台电脑同一时间只有一个观看者，新来的要明说接管，租约靠心跳续，过期的判断放在桥上，
 * 这样 Durable Object 休眠或重启都不会让一个掉线的手机一直占着屏幕。
 */
export const DESKTOP_PATH = "/api/desktop/";
export const DESKTOP_TAG = "pupu-desktop";
/** 手机多久发一次心跳；桥超过 DESKTOP_EXPIRE_MS 没收到就停。两个数值取自 Cindy。 */
export const DESKTOP_BEAT_MS = 3_000;
export const DESKTOP_EXPIRE_MS = 12_000;
/** 兼容模式的一帧，base64 之后的上限。180 KB 取自 Cindy，留一点余量。 */
export const MAX_FRAME_CHARS = 260_000;
const MAX_SDP_CHARS = 64_000;
const MAX_CANDIDATE_CHARS = 2_048;
const MAX_TEXT_CHARS = 2_000;

export type DesktopQuality = "auto" | "hd" | "saver";

export type IceServer = {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
};

export type IceCandidate = {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
};

/** 输入通道里的一条消息，坐标是 0 到 1 的比例。兼容模式下走 WebSocket，格式一样。 */
export type DesktopInput =
  | { readonly t: "move" | "down" | "up"; readonly x: number; readonly y: number; readonly b?: number }
  | { readonly t: "scroll"; readonly dx: number; readonly dy: number }
  | { readonly t: "text"; readonly s: string }
  | { readonly t: "key"; readonly k: string; readonly m?: readonly string[] }
  | { readonly t: "release" };

/** 手机 → 云端。 */
export type PhoneMessage =
  | { readonly type: "start"; readonly quality: DesktopQuality; readonly takeover: boolean }
  | { readonly type: "answer"; readonly sdp: string }
  | ({ readonly type: "ice" } & IceCandidate)
  | { readonly type: "beat" }
  | { readonly type: "control"; readonly on: boolean }
  | { readonly type: "quality"; readonly quality: DesktopQuality }
  /** 视频连不上时要一帧 JPEG，一次只要一帧。 */
  | { readonly type: "jpeg" }
  | { readonly type: "input"; readonly event: DesktopInput }
  | { readonly type: "stop" };

export type DesktopEndReason =
  | "stopped"
  | "taken_over"
  | "expired"
  | "offline"
  | "not_allowed"
  | "screen_off"
  | "needs_app"
  | "capture_failed"
  | "takeback";

/** 云端 → 手机。 */
export type ToPhone =
  /** 这台电脑正被别的手机看着。手机问过人以后带 takeover 再 start。 */
  | { readonly type: "busy"; readonly by: string }
  | { readonly type: "lease"; readonly session: string; readonly iceServers: readonly IceServer[] }
  | { readonly type: "offer"; readonly sdp: string }
  | ({ readonly type: "ice" } & IceCandidate)
  | { readonly type: "frame"; readonly data: string; readonly width: number; readonly height: number }
  /** 能不能控制变了，比如键鼠注入失败。画面照常。 */
  | { readonly type: "control"; readonly on: boolean; readonly message?: string }
  | { readonly type: "ended"; readonly reason: DesktopEndReason; readonly message?: string };

/** 云端 → 桥，都带着会话 id。 */
export type DesktopDown =
  | { readonly type: "start"; readonly iceServers: readonly IceServer[]; readonly quality: DesktopQuality }
  | Exclude<PhoneMessage, { readonly type: "start" }>;

/** 桥 → 云端，原样转给拿着这个会话的手机。 */
export type DesktopUp = Exclude<ToPhone, { readonly type: "busy" } | { readonly type: "lease" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function qualityOf(value: unknown): DesktopQuality {
  return value === "hd" || value === "saver" ? value : "auto";
}

function ratio(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function iceOf(value: Record<string, unknown>): IceCandidate | null {
  const { candidate, sdpMid, sdpMLineIndex } = value;
  if (typeof candidate !== "string" || candidate.length > MAX_CANDIDATE_CHARS) return null;
  return {
    candidate,
    sdpMid: typeof sdpMid === "string" ? sdpMid.slice(0, 64) : null,
    sdpMLineIndex: typeof sdpMLineIndex === "number" ? sdpMLineIndex : null
  };
}

export function parseInput(value: unknown): DesktopInput | null {
  if (!isRecord(value)) return null;
  switch (value.t) {
    case "move":
    case "down":
    case "up": {
      const x = ratio(value.x);
      const y = ratio(value.y);
      if (x === null || y === null) return null;
      return { t: value.t, x, y, ...(typeof value.b === "number" ? { b: value.b } : {}) };
    }
    case "scroll":
      return typeof value.dx === "number" && typeof value.dy === "number" && Number.isFinite(value.dx + value.dy)
        ? { t: "scroll", dx: value.dx, dy: value.dy }
        : null;
    case "text":
      return typeof value.s === "string" && value.s.length > 0 && value.s.length <= MAX_TEXT_CHARS
        ? { t: "text", s: value.s }
        : null;
    case "key":
      if (typeof value.k !== "string" || value.k.length > 40) return null;
      return {
        t: "key",
        k: value.k,
        ...(Array.isArray(value.m)
          ? { m: value.m.filter((item): item is string => typeof item === "string").slice(0, 4) }
          : {})
      };
    case "release":
      return { t: "release" };
    default:
      return null;
  }
}

export function parsePhoneMessage(raw: string): PhoneMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "start":
      return { type: "start", quality: qualityOf(value.quality), takeover: value.takeover === true };
    case "answer":
      return typeof value.sdp === "string" && value.sdp.length <= MAX_SDP_CHARS
        ? { type: "answer", sdp: value.sdp }
        : null;
    case "ice": {
      const ice = iceOf(value);
      return ice ? { type: "ice", ...ice } : null;
    }
    case "beat":
    case "jpeg":
    case "stop":
      return { type: value.type };
    case "control":
      return { type: "control", on: value.on === true };
    case "quality":
      return { type: "quality", quality: qualityOf(value.quality) };
    case "input": {
      const event = parseInput(value.event);
      return event ? { type: "input", event } : null;
    }
    default:
      return null;
  }
}

export function parseDesktopDown(value: unknown): DesktopDown | null {
  if (!isRecord(value)) return null;
  if (value.type === "start") {
    if (!Array.isArray(value.iceServers)) return null;
    return { type: "start", iceServers: value.iceServers as readonly IceServer[], quality: qualityOf(value.quality) };
  }
  const parsed = parsePhoneMessage(JSON.stringify(value));
  return parsed && parsed.type !== "start" ? parsed : null;
}

const END_REASONS: readonly DesktopEndReason[] = [
  "stopped",
  "taken_over",
  "expired",
  "offline",
  "not_allowed",
  "screen_off",
  "needs_app",
  "capture_failed",
  "takeback"
];

export function parseDesktopUp(value: unknown): DesktopUp | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "offer":
      return typeof value.sdp === "string" && value.sdp.length <= MAX_SDP_CHARS
        ? { type: "offer", sdp: value.sdp }
        : null;
    case "ice": {
      const ice = iceOf(value);
      return ice ? { type: "ice", ...ice } : null;
    }
    case "frame":
      return typeof value.data === "string" &&
        value.data.length > 0 &&
        value.data.length <= MAX_FRAME_CHARS &&
        typeof value.width === "number" &&
        typeof value.height === "number"
        ? { type: "frame", data: value.data, width: value.width, height: value.height }
        : null;
    case "control":
      return {
        type: "control",
        on: value.on === true,
        ...(typeof value.message === "string" ? { message: value.message.slice(0, 200) } : {})
      };
    case "ended": {
      const reason = END_REASONS.find((item) => item === value.reason) ?? "stopped";
      return {
        type: "ended",
        reason,
        ...(typeof value.message === "string" ? { message: value.message.slice(0, 200) } : {})
      };
    }
    default:
      return null;
  }
}

/**
 * 能不能开这台电脑的远程桌面。开远程桌面等于人坐在这台电脑前，所以要人亲手确认，和审批一样：
 * - 主人自己的手机直接能开；还没主人的电脑（迁移前配的）哪台手机都行。
 * - 网页和电脑 App 开在 Pupu 能操作的电脑上，它能自己点，所以要主人刚为这台电脑按过通行密钥：
 *   `confirmedBy` 是这次连接带来的确认是谁做的（见 server.ts 的 `desktopTicket`）。没主人的电脑不给。
 * `actor` 是 null 是本机开发没带凭据。
 */
export function mayViewDesktop(
  actor: { readonly kind: string; readonly memberId: string | null } | null | undefined,
  ownerId: string | null,
  confirmedBy: string | null = null
): boolean {
  if (actor === null) return true;
  if (actor === undefined) return false;
  if (actor.kind === "phone") return ownerId === null || actor.memberId === ownerId;
  return ownerId !== null && actor.memberId === ownerId && confirmedBy === ownerId;
}

/** 测试和 Durable Object 的 WebSocket 都能当这个用。 */
export interface DesktopSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  deserializeAttachment(): unknown;
  setState?(state: unknown): unknown;
}

/** 一条手机连接上、能在休眠之后读回来的状态。 */
type ViewerLink = {
  readonly role: "desktop";
  readonly computerId: string;
  readonly device: string | null;
  /** 拿着租约时是会话 id。 */
  readonly session: string | null;
};

export type DesktopOptions = {
  readonly sockets: () => readonly DesktopSocket[];
  /** Worker 认出来的设备，放在请求头里。 */
  readonly deviceOf: (request: Request) => string | null;
  /** 把一帧发给这台电脑的桥。不在线返回 false。 */
  readonly toBridge: (computerId: string, session: string, message: DesktopDown) => boolean;
  /** `ticket` 是网页按过通行密钥换来的一次性票，放在地址的 `ticket` 参数里；手机不带。 */
  readonly mayView: (device: string | null, computerId: string, ticket: string | null) => boolean;
  readonly iceServers: () => Promise<readonly IceServer[]>;
  readonly deviceName: (device: string | null) => string;
  readonly newSession: () => string;
};

const OPEN = 1;

function readLink(socket: DesktopSocket): ViewerLink | null {
  const attachment = socket.deserializeAttachment();
  const link = isRecord(attachment) ? attachment.__user : null;
  return isRecord(link) && link.role === "desktop" ? (link as ViewerLink) : null;
}

function writeLink(socket: DesktopSocket, link: ViewerLink): void {
  if (socket.setState) {
    socket.setState(link);
    return;
  }
  const current = socket.deserializeAttachment();
  const base = isRecord(current) ? current : {};
  (socket as DesktopSocket & { serializeAttachment?(value: unknown): void }).serializeAttachment?.({
    ...base,
    __user: link
  });
}

function send(socket: DesktopSocket, message: ToPhone): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // 检查状态和发送之间连接断了。
  }
}

export function computerIdOfPath(pathname: string): string | null {
  if (!pathname.startsWith(DESKTOP_PATH)) return null;
  const id = decodeURIComponent(pathname.slice(DESKTOP_PATH.length));
  return id && !id.includes("/") ? id : null;
}

export class RemoteDesktopHub {
  readonly #options: DesktopOptions;

  constructor(options: DesktopOptions) {
    this.#options = options;
  }

  isRequest(request: Request): boolean {
    return computerIdOfPath(new URL(request.url).pathname) !== null;
  }

  async onConnect(socket: DesktopSocket, request: Request): Promise<void> {
    const url = new URL(request.url);
    const computerId = computerIdOfPath(url.pathname);
    const device = this.#options.deviceOf(request);
    if (!computerId || !this.#options.mayView(device, computerId, url.searchParams.get("ticket"))) {
      send(socket, { type: "ended", reason: "not_allowed" });
      socket.close(1008, "not allowed");
      return;
    }
    writeLink(socket, { role: "desktop", computerId, device, session: null });
  }

  async onMessage(socket: DesktopSocket, raw: string): Promise<void> {
    const link = readLink(socket);
    const message = parsePhoneMessage(raw);
    if (!link || !message) return;
    if (message.type === "start") {
      await this.#start(socket, link, message);
      return;
    }
    if (!link.session) return;
    if (!this.#options.toBridge(link.computerId, link.session, message)) {
      this.#end(socket, link, "offline");
      return;
    }
    if (message.type === "stop") writeLink(socket, { ...link, session: null });
  }

  onClose(socket: DesktopSocket): void {
    const link = readLink(socket);
    if (link?.session) this.#options.toBridge(link.computerId, link.session, { type: "stop" });
  }

  /** 桥发来的。不是当前租约的（比如被接管的旧会话）丢掉。 */
  fromBridge(computerId: string, session: string, message: DesktopUp): void {
    for (const socket of this.#open()) {
      const link = readLink(socket);
      if (link?.computerId !== computerId || link.session !== session) continue;
      send(socket, message);
      if (message.type === "ended") writeLink(socket, { ...link, session: null });
    }
  }

  /** 桥掉线了：拿着这台电脑租约的手机都结束。 */
  bridgeGone(computerId: string): void {
    for (const socket of this.#open()) {
      const link = readLink(socket);
      if (link?.computerId === computerId && link.session) this.#end(socket, link, "offline");
    }
  }

  async #start(
    socket: DesktopSocket,
    link: ViewerLink,
    message: Extract<PhoneMessage, { type: "start" }>
  ): Promise<void> {
    // 重开之前先放掉自己手上的旧会话。
    if (link.session) this.#options.toBridge(link.computerId, link.session, { type: "stop" });
    const other = this.#open().find((candidate) => {
      const current = readLink(candidate);
      return candidate !== socket && current?.computerId === link.computerId && current.session !== null;
    });
    if (other) {
      const holder = readLink(other)!;
      if (!message.takeover) {
        writeLink(socket, { ...link, session: null });
        send(socket, { type: "busy", by: this.#options.deviceName(holder.device) });
        return;
      }
      this.#options.toBridge(holder.computerId, holder.session!, { type: "stop" });
      this.#end(other, holder, "taken_over");
    }
    const session = this.#options.newSession();
    // 先占住再等 TURN 凭证，免得两台手机同时拿到租约。
    writeLink(socket, { ...link, session });
    const iceServers = await this.#options.iceServers();
    if (readLink(socket)?.session !== session) return;
    if (!this.#options.toBridge(link.computerId, session, { type: "start", iceServers, quality: message.quality })) {
      this.#end(socket, { ...link, session }, "offline");
      return;
    }
    send(socket, { type: "lease", session, iceServers });
  }

  #end(socket: DesktopSocket, link: ViewerLink, reason: DesktopEndReason): void {
    writeLink(socket, { ...link, session: null });
    send(socket, { type: "ended", reason });
  }

  #open(): DesktopSocket[] {
    return this.#options.sockets().filter((socket) => socket.readyState === OPEN);
  }
}

const STUN: readonly IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
/** 一次远程会话的上限，TURN 凭证按它签。 */
const TURN_TTL_SECONDS = 4 * 60 * 60;
/** 换 TURN 凭证最多等这么久。等的时候租约已经占着，别的手机看到的是「忙」。 */
export const TURN_FETCH_MS = 5_000;

/**
 * 向 Cloudflare 换短期 TURN 凭证。没配密钥或者换不到就只用 STUN：局域网和大多数家用网络还能连上，
 * 连不上时手机退到 JPEG。53 端口的地址去掉：浏览器会拦，留着只会多一轮失败。
 */
export async function iceServersFrom(
  env: { readonly TURN_KEY_ID?: string; readonly TURN_KEY_TOKEN?: string },
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs = TURN_FETCH_MS
): Promise<readonly IceServer[]> {
  const id = env.TURN_KEY_ID?.trim();
  const token = env.TURN_KEY_TOKEN?.trim();
  if (!id || !token) return STUN;
  try {
    const response = await fetcher(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    if (!response.ok) throw new Error(`Cloudflare 返回 ${response.status}`);
    const body = (await response.json()) as { iceServers?: IceServer | readonly IceServer[] };
    const list = Array.isArray(body.iceServers) ? (body.iceServers as readonly IceServer[]) : [body.iceServers as IceServer];
    const servers = list.flatMap((server) => {
      const urls = (Array.isArray(server?.urls) ? server.urls : [server?.urls]).filter(
        (url): url is string => typeof url === "string" && !/:53\b/.test(url)
      );
      return urls.length > 0 ? [{ ...server, urls }] : [];
    });
    return servers.length > 0 ? servers : STUN;
  } catch (error) {
    console.warn(`TURN 凭证没换到，只用 STUN：${error instanceof Error ? error.message : String(error)}`);
    return STUN;
  }
}
