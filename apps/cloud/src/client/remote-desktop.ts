/**
 * 网页上的一次远程桌面，和 iOS 的 DesktopSession 同一套协议：信令走 `/api/desktop/:id` 的 WebSocket，
 * 视频和键鼠走 WebRTC 点对点，8 秒连不上先出 JPEG。消息格式见 ../bridge/desktop.ts。
 * 时序取自 Cindy 的 docs/remote-desktop.md（Apache-2.0）：心跳 3 秒，点对点断了先等 5 秒，1、3、8 秒重试三次。
 *
 * 和手机不同的一点：网页的连接是主人按过通行密钥换来的一次性票开的，信令断了不悄悄重连，
 * 交给页面，让人再按一次（见 server.ts 的 `desktopTicket`）。
 */

export type DesktopQuality = "auto" | "hd" | "saver";

export type DesktopState =
  | { readonly kind: "connecting" }
  | { readonly kind: "live" }
  /** 视频连不上，在用 JPEG。 */
  | { readonly kind: "compatible" }
  /** 点对点断了，正在恢复，画面停在最后一帧。 */
  | { readonly kind: "recovering" }
  /** 别的设备正在看，问过人再 `takeOver()`。 */
  | { readonly kind: "busy"; readonly by: string }
  | { readonly kind: "ended"; readonly message: string };

/** 输入通道里的一条，坐标是 0 到 1 的比例。 */
export type DesktopInput =
  | { readonly t: "move" | "down" | "up"; readonly x: number; readonly y: number; readonly b?: number }
  | { readonly t: "scroll"; readonly dx: number; readonly dy: number }
  | { readonly t: "text"; readonly s: string }
  | { readonly t: "key"; readonly k: string; readonly m?: readonly string[] }
  | { readonly t: "release" };

export type DesktopEvents = {
  onState(state: DesktopState): void;
  onStream(stream: MediaStream): void;
  /** JPEG 兜底的一帧，data URL。 */
  onImage(url: string): void;
  /** 电脑那边能不能操作，比如没有辅助功能权限，带着电脑说的原因。 */
  onControl(on: boolean, message: string | null): void;
  onLatency(ms: number): void;
};

const RETRY_DELAYS = [1_000, 3_000, 8_000];
const BEAT_MS = 3_000;
const FALLBACK_MS = 8_000;
const GRACE_MS = 5_000;

export function endedText(reason: string | undefined, message: string | undefined): string {
  if (message) return message;
  switch (reason) {
    case "taken_over":
      return "别的设备接管了这台电脑。";
    case "offline":
      return "这台电脑离线了。";
    case "not_allowed":
      return "只有电脑主人本人确认过才能打开远程桌面。";
    case "screen_off":
      return "这台电脑关掉了「允许操作屏幕」。";
    case "needs_app":
      return "这台电脑要用 Pupu 电脑 App 才能远程桌面。";
    case "takeback":
      return "电脑上收回了控制。";
    case "expired":
      return "连接超时了。";
    case "capture_failed":
      return "这台电脑截不了屏。";
    default:
      return "远程桌面结束了。";
  }
}

type Picture =
  | { readonly kind: "none" }
  | { readonly kind: "negotiating" | "live" | "faltering"; readonly peer: Peer }
  | { readonly kind: "retrying" }
  /** 一次要一帧 JPEG。点对点还在的话接着协商，通了换回视频。 */
  | { readonly kind: "stills"; readonly peer: Peer | null; readonly askedAt: number };

type Peer = {
  readonly connection: RTCPeerConnection;
  /** 远端描述设好之前到的候选先攒着；设好以后是 null。 */
  early: RTCIceCandidateInit[] | null;
  channel: RTCDataChannel | null;
  ping: ReturnType<typeof setInterval> | null;
};

export class RemoteDesktopSession {
  readonly #url: string;
  readonly #events: DesktopEvents;
  #quality: DesktopQuality;
  #socket: WebSocket | null = null;
  #beat: ReturnType<typeof setInterval> | null = null;
  #picture: Picture = { kind: "none" };
  /** 这一步的计时器，换步时收掉。 */
  #timer: ReturnType<typeof setTimeout> | null = null;
  #retries = 0;
  #leased = false;
  #ended = false;
  #shown: DesktopState["kind"] | null = null;
  #pendingMove: DesktopInput | null = null;
  #moveTimer: ReturnType<typeof setTimeout> | null = null;

  /** `url` 是带着票的信令地址，用一次。 */
  constructor(url: string, quality: DesktopQuality, events: DesktopEvents) {
    this.#url = url;
    this.#quality = quality;
    this.#events = events;
  }

  start(): void {
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    this.#show({ kind: "connecting" });
    socket.onopen = () => this.#send({ type: "start", quality: this.#quality, takeover: false });
    socket.onmessage = (event) => {
      if (this.#socket === socket && typeof event.data === "string") this.#handle(event.data);
    };
    socket.onclose = () => {
      if (this.#socket === socket) this.#finish("和 Pupu 的连接断了。");
    };
  }

  /** 别的设备在看，人点了接管。 */
  takeOver(): void {
    this.#send({ type: "start", quality: this.#quality, takeover: true });
    this.#show({ kind: "connecting" });
  }

  /** 人关掉了：放掉租约。 */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#send({ type: "stop" });
    const socket = this.#socket;
    this.#socket = null;
    // 让 stop 先发出去。
    setTimeout(() => socket?.close(1000), 200);
    this.#teardown();
  }

  setQuality(quality: DesktopQuality): void {
    this.#quality = quality;
    this.#send({ type: "quality", quality });
  }

  setViewOnly(on: boolean): void {
    this.#send({ type: "control", on: !on });
  }

  /** 移动只留最新的一条，下一拍发出去；其他的按顺序立刻发。 */
  input(event: DesktopInput): void {
    if (this.#ended) return;
    if (event.t !== "move") {
      this.#flushMove();
      this.#deliver(event);
      return;
    }
    this.#pendingMove = event;
    if (this.#moveTimer) return;
    this.#moveTimer = setTimeout(() => this.#flushMove(), this.#picture.kind === "live" ? 1000 / 60 : 1000 / 20);
  }

  #flushMove(): void {
    if (this.#moveTimer) clearTimeout(this.#moveTimer);
    this.#moveTimer = null;
    const move = this.#pendingMove;
    this.#pendingMove = null;
    if (move) this.#deliver(move);
  }

  #deliver(event: DesktopInput): void {
    const channel = "peer" in this.#picture ? this.#picture.peer?.channel : null;
    if (channel?.readyState === "open") {
      channel.send(JSON.stringify(event));
      return;
    }
    this.#send({ type: "input", event });
  }

  // ---- 信令 ----

  #send(message: Record<string, unknown>): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #handle(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case "lease":
        this.#lease(Array.isArray(message.iceServers) ? (message.iceServers as RTCIceServer[]) : []);
        break;
      case "busy":
        this.#show({ kind: "busy", by: typeof message.by === "string" ? message.by : "别的设备" });
        break;
      case "offer":
        if (typeof message.sdp === "string") void this.#answer(message.sdp);
        break;
      case "ice": {
        const peer = this.#peer();
        if (!peer || typeof message.candidate !== "string") return;
        const candidate: RTCIceCandidateInit = {
          candidate: message.candidate,
          sdpMid: typeof message.sdpMid === "string" ? message.sdpMid : null,
          sdpMLineIndex: typeof message.sdpMLineIndex === "number" ? message.sdpMLineIndex : 0
        };
        if (peer.early) peer.early.push(candidate);
        else void peer.connection.addIceCandidate(candidate).catch(() => undefined);
        break;
      }
      case "frame":
        // 视频已经接上以后晚到的 JPEG 不要，免得盖住视频。
        if (this.#picture.kind !== "stills") return;
        if (typeof message.data === "string") this.#events.onImage(`data:image/jpeg;base64,${message.data}`);
        this.#frameArrived();
        break;
      case "control":
        this.#events.onControl(message.on === true, typeof message.message === "string" ? message.message : null);
        break;
      case "ended":
        this.#finish(
          endedText(
            typeof message.reason === "string" ? message.reason : undefined,
            typeof message.message === "string" ? message.message : undefined
          )
        );
        break;
    }
  }

  /** 新租约：心跳从这一拍开始，画面重新协商。电脑那边每次租约都从「能操作」开始。 */
  #lease(servers: RTCIceServer[]): void {
    this.#leased = true;
    if (this.#beat) clearInterval(this.#beat);
    this.#beat = setInterval(() => this.#send({ type: "beat" }), BEAT_MS);
    this.#events.onControl(true, null);
    this.#openPeer(servers);
  }

  #finish(message: string): void {
    if (this.#ended) return;
    this.#ended = true;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000);
    this.#teardown();
    this.#show({ kind: "ended", message });
  }

  #teardown(): void {
    if (this.#beat) clearInterval(this.#beat);
    this.#beat = null;
    if (this.#moveTimer) clearTimeout(this.#moveTimer);
    this.#moveTimer = null;
    this.#setPicture({ kind: "none" });
  }

  // ---- 画面 ----

  #peer(): Peer | null {
    return "peer" in this.#picture ? this.#picture.peer : null;
  }

  /** 画面换一步：上一步的计时器收掉，没带进下一步的点对点连接关掉。 */
  #setPicture(next: Picture, timer: ReturnType<typeof setTimeout> | null = null): void {
    const previous = this.#peer();
    if (this.#timer && this.#timer !== timer) clearTimeout(this.#timer);
    this.#timer = timer;
    this.#picture = next;
    const kept = "peer" in next ? next.peer : null;
    if (previous && previous !== kept) closePeer(previous);
    this.#publish();
  }

  #publish(): void {
    if (this.#ended) return;
    switch (this.#picture.kind) {
      case "live":
        return this.#show({ kind: "live" });
      case "stills":
        return this.#show({ kind: "compatible" });
      case "faltering":
      case "retrying":
        return this.#show({ kind: "recovering" });
      default:
        if (this.#shown !== "busy") this.#show(this.#retries > 0 ? { kind: "recovering" } : { kind: "connecting" });
    }
  }

  #show(state: DesktopState): void {
    if (state.kind === this.#shown && state.kind !== "busy" && state.kind !== "ended") return;
    this.#shown = state.kind;
    this.#events.onState(state);
  }

  #after(ms: number, run: () => void): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (!this.#ended) run();
    }, ms);
  }

  #openPeer(servers: RTCIceServer[]): void {
    let connection: RTCPeerConnection;
    try {
      connection = new RTCPeerConnection({ iceServers: servers });
    } catch {
      this.#askFrame(null);
      return;
    }
    const peer: Peer = { connection, early: [], channel: null, ping: null };
    connection.ontrack = (event) => {
      if (this.#peer() !== peer) return;
      this.#events.onStream(event.streams[0] ?? new MediaStream([event.track]));
    };
    connection.onicecandidate = (event) => {
      if (this.#peer() !== peer || !event.candidate) return;
      const { candidate, sdpMid, sdpMLineIndex } = event.candidate;
      this.#send({ type: "ice", candidate, sdpMid, sdpMLineIndex });
    };
    connection.oniceconnectionstatechange = () => this.#iceChanged(peer);
    connection.ondatachannel = (event) => {
      if (this.#peer() !== peer) return;
      const channel = event.channel;
      peer.channel = channel;
      channel.onmessage = (message) => this.#pong(peer, message.data);
      if (peer.ping) clearInterval(peer.ping);
      peer.ping = setInterval(() => {
        if (channel.readyState === "open") channel.send(JSON.stringify({ t: "ping", c: performance.now() }));
      }, 2_000);
    };
    this.#setPicture({ kind: "negotiating", peer }, this.#after(FALLBACK_MS, () => this.#fallBack()));
  }

  async #answer(sdp: string): Promise<void> {
    const peer = this.#peer();
    if (!peer) return;
    try {
      await peer.connection.setRemoteDescription({ type: "offer", sdp });
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      if (this.#peer() !== peer) return;
      for (const candidate of peer.early ?? []) void peer.connection.addIceCandidate(candidate).catch(() => undefined);
      peer.early = null;
      this.#send({ type: "answer", sdp: answer.sdp ?? "" });
    } catch {
      // 协商失败等 8 秒的兜底。
    }
  }

  #iceChanged(peer: Peer): void {
    if (this.#peer() !== peer) return;
    const state = peer.connection.iceConnectionState;
    if (state === "connected" || state === "completed") {
      if (this.#picture.kind === "live") return;
      this.#setPicture({ kind: "live", peer }, this.#after(30_000, () => (this.#retries = 0)));
    } else if (state === "disconnected") {
      if (this.#picture.kind === "negotiating" || this.#picture.kind === "live") {
        this.#setPicture({ kind: "faltering", peer }, this.#after(GRACE_MS, () => this.#lost()));
      }
    } else if (state === "failed") {
      this.#lost();
    }
  }

  #pong(peer: Peer, data: unknown): void {
    if (typeof data !== "string") return;
    try {
      const message = JSON.parse(data) as { t?: unknown; c?: unknown };
      if (message.t === "pong" && typeof message.c === "number" && this.#peer() === peer) {
        this.#events.onLatency(Math.round(performance.now() - message.c));
      }
    } catch {
      // 不是给我们的。
    }
  }

  /** 8 秒还没通：先出 JPEG，点对点接着协商。 */
  #fallBack(): void {
    if (this.#picture.kind === "negotiating") this.#askFrame(this.#picture.peer);
  }

  /** 点对点断了。还有重试次数就等一会儿重新要租约，用完了出 JPEG。 */
  #lost(): void {
    const picture = this.#picture;
    if (picture.kind === "stills") {
      this.#setPicture({ kind: "stills", peer: null, askedAt: picture.askedAt }, this.#timer);
      return;
    }
    if (picture.kind !== "negotiating" && picture.kind !== "live" && picture.kind !== "faltering") return;
    const delay = RETRY_DELAYS[this.#retries];
    if (delay === undefined) {
      this.#askFrame(null);
      return;
    }
    this.#retries += 1;
    this.#setPicture(
      { kind: "retrying" },
      this.#after(delay, () => {
        if (this.#picture.kind !== "retrying") return;
        this.#setPicture({ kind: "none" });
        if (this.#leased) this.#send({ type: "start", quality: this.#quality, takeover: false });
      })
    );
  }

  /** 要一帧 JPEG。三秒没回当成丢了，再要一次。 */
  #askFrame(peer: Peer | null): void {
    this.#send({ type: "jpeg" });
    this.#setPicture({ kind: "stills", peer, askedAt: performance.now() }, this.#after(3_000, () => this.#askAgain()));
  }

  #askAgain(): void {
    if (this.#picture.kind === "stills") this.#askFrame(this.#picture.peer);
  }

  /** 收到一帧：离上次要满 0.25 秒再要下一帧，最多每秒四帧。 */
  #frameArrived(): void {
    const picture = this.#picture;
    if (picture.kind !== "stills") return;
    const wait = Math.max(0, picture.askedAt + 250 - performance.now());
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = this.#after(wait, () => this.#askAgain());
  }
}

function closePeer(peer: Peer): void {
  if (peer.ping) clearInterval(peer.ping);
  peer.channel?.close();
  peer.connection.close();
}

/** 浏览器的键名对上电脑那边认得的（bridge/desktop/Sources/PupuDesktop/Input.swift 的 `keyCodes`）。 */
const NAMED_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageUp",
  "PageDown"
]);
/** 带 ⌘ 的快捷键只认这几个字母，其余字母照字发。 */
const SHORTCUT_LETTERS = new Set(["a", "c", "v", "x", "z", "s", "f", "w", "q", "t", "n", "r"]);

/**
 * 一次按键要不要当成快捷键发：命名的键、带 ⌘ 或 ⌃ 的那几个字母。返回 null 的交给文字输入（拼音也走那边）。
 */
export function keyOf(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">): DesktopInput | null {
  if (event.isComposing) return null;
  const m = [
    ...(event.metaKey ? ["cmd"] : []),
    ...(event.ctrlKey ? ["ctrl"] : []),
    ...(event.altKey ? ["alt"] : []),
    ...(event.shiftKey ? ["shift"] : [])
  ];
  if (NAMED_KEYS.has(event.key)) return { t: "key", k: event.key, ...(m.length > 0 ? { m } : {}) };
  const letter = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && SHORTCUT_LETTERS.has(letter)) return { t: "key", k: letter, m };
  if (event.key === " " && (event.metaKey || event.ctrlKey)) return { t: "key", k: "Space", m };
  return null;
}
