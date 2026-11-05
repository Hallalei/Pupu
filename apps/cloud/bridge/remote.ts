import type {
  DesktopDown,
  DesktopEndReason,
  DesktopInput,
  DesktopQuality,
  DesktopUp,
  IceCandidate,
  IceServer
} from "../src/bridge/desktop.ts";
import { DESKTOP_BEAT_MS, DESKTOP_EXPIRE_MS } from "../src/bridge/desktop.ts";

/** 桥 → 推流窗口。 */
export type CaptureCommand =
  | {
      readonly type: "start";
      readonly session: string;
      readonly iceServers: readonly IceServer[];
      readonly quality: DesktopQuality;
    }
  | { readonly type: "answer"; readonly session: string; readonly sdp: string }
  | ({ readonly type: "ice"; readonly session: string } & IceCandidate)
  | { readonly type: "quality"; readonly session: string; readonly quality: DesktopQuality }
  | { readonly type: "jpeg"; readonly session: string }
  | { readonly type: "stop"; readonly session: string };

/** 推流窗口 → 桥。 */
export type CaptureEvent =
  | { readonly type: "offer"; readonly session: string; readonly sdp: string }
  | ({ readonly type: "ice"; readonly session: string } & IceCandidate)
  | { readonly type: "frame"; readonly session: string; readonly data: string; readonly width: number; readonly height: number }
  | { readonly type: "input"; readonly session: string; readonly event: DesktopInput }
  | { readonly type: "failed"; readonly session: string; readonly message: string };

export type RemoteStatus = "viewing" | "controlling" | null;

export type RemoteOptions = {
  readonly send: (session: string, message: DesktopUp) => void;
  /** 命令行的桥没有推流窗口，是 null。 */
  readonly capture: ((command: CaptureCommand) => void) | null;
  readonly allowScreen: () => boolean;
  readonly input: { send(event: DesktopInput): void; stop(): void };
  readonly onChange: () => void;
  readonly now?: () => number;
};

/** 人最后一次远程输入之后，这么久才轮到 Pupu；最多等这么久。两个数值取自 Cindy 的 inputOwnership.ts。 */
export const HUMAN_QUIET_MS = 300;
export const HUMAN_WAIT_MS = 5_000;

let humanInputAt = 0;

/** Pupu 的屏幕动作在这里让一下：远程桌面的人在操作时等他停手，等不到就告诉模型（技术方案 6.6）。 */
export async function yieldToHuman(now: () => number = Date.now): Promise<void> {
  const started = now();
  while (now() - humanInputAt < HUMAN_QUIET_MS) {
    if (now() - started >= HUMAN_WAIT_MS) throw new Error("用户正在远程操作这台电脑的屏幕，等一会儿再试。");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * 这台电脑这边的远程桌面：一个会话，云端的消息进来，转给推流窗口；推流窗口的 offer、候选发回去。
 * DataChannel 是点对点的，云端拦不住，所以输入在这里把关：只有控制开着、本机允许操作屏幕时才交给输入助手。
 * 心跳过期也在这里判，手机没了就停推流，不靠云端（技术方案 6.4、6.5）。
 */
export class RemoteAgent {
  readonly #options: RemoteOptions;
  readonly #now: () => number;
  #active: { readonly session: string; beatAt: number; control: boolean } | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RemoteOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get status(): RemoteStatus {
    if (!this.#active) return null;
    return this.#active.control ? "controlling" : "viewing";
  }

  handle(session: string, message: DesktopDown): void {
    if (message.type === "start") {
      this.#start(session, message.iceServers, message.quality);
      return;
    }
    const active = this.#active;
    if (active?.session !== session) return;
    switch (message.type) {
      case "beat":
        active.beatAt = this.#now();
        break;
      case "stop":
        this.#finish();
        break;
      case "control":
        active.control = message.on;
        if (!message.on) this.#options.input.stop();
        this.#options.onChange();
        break;
      case "input":
        this.#deliver(active, message.event);
        break;
      case "answer":
        this.#options.capture?.({ type: "answer", session, sdp: message.sdp });
        break;
      case "ice":
        this.#options.capture?.({ ...message, session });
        break;
      case "quality":
        this.#options.capture?.({ type: "quality", session, quality: message.quality });
        break;
      case "jpeg":
        this.#options.capture?.({ type: "jpeg", session });
        break;
    }
  }

  fromCapture(event: CaptureEvent): void {
    const active = this.#active;
    if (active?.session !== event.session) return;
    switch (event.type) {
      case "offer":
        this.#options.send(event.session, { type: "offer", sdp: event.sdp });
        break;
      case "ice": {
        const { session, ...candidate } = event;
        this.#options.send(session, candidate);
        break;
      }
      case "frame":
        this.#options.send(event.session, {
          type: "frame",
          data: event.data,
          width: event.width,
          height: event.height
        });
        break;
      case "input":
        this.#deliver(active, event.event);
        break;
      case "failed":
        this.stop("capture_failed", event.message);
        break;
    }
  }

  /** 键鼠失灵：收回控制，画面继续。 */
  inputFailed(message: string): void {
    const active = this.#active;
    if (!active?.control) return;
    active.control = false;
    this.#options.send(active.session, { type: "control", on: false, message });
    this.#options.onChange();
  }

  /** 这边结束：告诉手机为什么。 */
  stop(reason: DesktopEndReason, message?: string): void {
    const active = this.#active;
    if (!active) return;
    this.#options.send(active.session, { type: "ended", reason, ...(message ? { message } : {}) });
    this.#finish();
  }

  #start(session: string, iceServers: readonly IceServer[], quality: DesktopQuality): void {
    const refuse = (reason: DesktopEndReason) => this.#options.send(session, { type: "ended", reason });
    if (!this.#options.capture) {
      refuse("needs_app");
      return;
    }
    if (!this.#options.allowScreen()) {
      refuse("screen_off");
      return;
    }
    this.#finish();
    this.#active = { session, beatAt: this.#now(), control: true };
    this.#timer = setInterval(() => this.#check(), DESKTOP_BEAT_MS);
    this.#options.capture({ type: "start", session, iceServers, quality });
    this.#options.onChange();
  }

  #deliver(active: { readonly control: boolean }, event: DesktopInput): void {
    if (!active.control || !this.#options.allowScreen()) return;
    humanInputAt = this.#now();
    this.#options.input.send(event);
  }

  #check(): void {
    const active = this.#active;
    if (active && this.#now() - active.beatAt > DESKTOP_EXPIRE_MS) this.stop("expired");
  }

  #finish(): void {
    const active = this.#active;
    if (!active) return;
    this.#active = null;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#options.input.stop();
    this.#options.capture?.({ type: "stop", session: active.session });
    this.#options.onChange();
  }
}
