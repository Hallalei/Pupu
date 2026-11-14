import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ComputerView } from "../bridge/protocol";
import { createPortal } from "react-dom";
import { api } from "./api";
import { desktop, useDesktopComputer } from "./desktop";
import { ChevronLeftIcon } from "./icons";
import { Cancelled, confirm, type ConfirmWhere, type Passkeys } from "./passkey";
import { RemoteDesktopSession, keyOf, type DesktopInput, type DesktopQuality, type DesktopState } from "./remote-desktop";

/**
 * 网页和电脑 App 上的远程桌面：对话里电脑卡的「接手」、设置里电脑页的「远程控制」，和 iOS 一样只给主人自己在线的电脑。
 * 要不要先用通行密钥确认看电脑设置里的「远程控制前确认」（默认不用，见 ../bridge/remote-confirm.ts）。
 * 要确认时电脑 App 的窗口里没有通行密钥，交给系统浏览器，在那里打开 `#/desktop/<电脑 id>`。
 */

/** 这台设备上怎么开这台电脑的远程桌面。null 是不放按钮：不是自己的、离线、或者就是眼前这台。 */
export type RemoteWhere = "here" | "passkey" | "browser" | "phone";

type Where = (computerId: string | null) => RemoteWhere | null;

/** 谁能开哪台，由 App 里挂着的 `RemoteDesktopLayer` 每次渲染时更新，卡片和设置页订阅它。 */
let whereNow: Where = () => null;
const whereListeners = new Set<() => void>();

function subscribeWhere(listener: () => void) {
  whereListeners.add(listener);
  return () => {
    whereListeners.delete(listener);
  };
}

export function useRemoteDesktop(computerId: string | null): RemoteWhere | null {
  return useSyncExternalStore(subscribeWhere, () => whereNow)(computerId);
}

function useWhere(
  computers: readonly ComputerView[],
  memberId: string | null | undefined,
  confirmBy: ConfirmWhere
): Where {
  const here = useDesktopComputer()?.computerId ?? null;
  const where = useMemo<Where>(
    () => (computerId) => {
      const computer = computerId ? computers.find((item) => item.id === computerId) : undefined;
      if (!computer?.online || computer.id === here) return null;
      // 本机开发没带凭据：云端也不拦。
      if (confirmBy === "here") return memberId === undefined || computer.ownerId === memberId ? "here" : null;
      if (computer.ownerId === null || computer.ownerId !== memberId) return null;
      // 设置里的「远程控制前确认」：不用确认、或者这台设备确认过一次，主人登录着直接开，电脑 App 里也在窗口里开。
      const direct = computer.remoteConfirm === "none" || (computer.remoteConfirm === "device" && computer.remoteTrusted === true);
      return direct ? "here" : confirmBy;
    },
    [computers, here, memberId, confirmBy]
  );
  useEffect(() => {
    whereNow = where;
    whereListeners.forEach((listener) => listener());
  }, [where]);
  return where;
}

// ---- 开着哪台：放在模块里，打开不改地址栏的路由；从电脑 App 交过来的是 `#/desktop/<id>`。 ----

type Open = { readonly computerId: string; readonly auto: boolean };
let opened: Open | null = null;
const listeners = new Set<() => void>();
const DEEP_LINK = /^#\/desktop\/(.+)$/;

function setOpened(next: Open | null) {
  opened = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 点了「接手」「远程控制」。网页上马上弹通行密钥（还在这次点击里，Safari 才肯弹）；电脑 App 里打开系统浏览器。
 */
export function openRemoteDesktop(computerId: string, where: RemoteWhere) {
  if (where === "browser") {
    window.open(`${location.origin}/#/desktop/${encodeURIComponent(computerId)}`, "_blank", "noopener");
    return;
  }
  if (where === "phone") return;
  setOpened({ computerId, auto: true });
}

/** 挂在 App 里：开着的远程桌面盖在最上面。也负责告诉卡片和设置页谁能开哪台。 */
export function RemoteDesktopLayer({
  computers,
  memberId,
  confirmBy,
  passkeys
}: {
  computers: readonly ComputerView[];
  /** 这台设备是哪个成员的。本机开发没带凭据是 undefined。 */
  memberId: string | null | undefined;
  confirmBy: ConfirmWhere;
  passkeys: Passkeys | null;
}) {
  const where = useWhere(computers, memberId, confirmBy);
  const current = useSyncExternalStore(subscribe, () => opened);
  // 电脑 App 交过来的链接：读一次就从地址栏去掉，免得刷新又开。
  useEffect(() => {
    const match = location.hash.match(DEEP_LINK);
    if (!match || desktop()) return;
    history.replaceState(null, "", `${location.pathname}${location.search}#/`);
    setOpened({ computerId: decodeURIComponent(match[1] ?? ""), auto: false });
  }, []);
  if (!current) return null;
  const computer = computers.find((item) => item.id === current.computerId);
  return createPortal(
    <Viewer
      key={current.computerId}
      computerId={current.computerId}
      name={computer?.name ?? "电脑"}
      where={where(current.computerId)}
      known={computers.length > 0}
      passkeys={passkeys}
      auto={current.auto}
      onClose={() => setOpened(null)}
    />,
    document.body
  );
}

type Phase =
  | { readonly kind: "confirm"; readonly error: string | null; readonly busy: boolean }
  | { readonly kind: "session"; readonly session: RemoteDesktopSession };

const QUALITY_KEY = "pupu.desktop.quality";
const QUALITIES: readonly { readonly value: DesktopQuality; readonly label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "hd", label: "清晰" },
  { value: "saver", label: "省流" }
];

function savedQuality(): DesktopQuality {
  try {
    const value = localStorage.getItem(QUALITY_KEY);
    return value === "hd" || value === "saver" ? value : "auto";
  } catch {
    return "auto";
  }
}

function Viewer({
  computerId,
  name,
  where,
  known,
  passkeys,
  auto,
  onClose
}: {
  computerId: string;
  name: string;
  where: RemoteWhere | null;
  /** 电脑列表到了没有：没到之前不急着说「开不了」。 */
  known: boolean;
  passkeys: Passkeys | null;
  auto: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "confirm", error: null, busy: false });
  const [state, setState] = useState<DesktopState>({ kind: "connecting" });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [still, setStill] = useState<string | null>(null);
  const [control, setControl] = useState<{ on: boolean; message: string | null }>({ on: true, message: null });
  const [latency, setLatency] = useState<number | null>(null);
  const [viewOnly, setViewOnly] = useState(false);
  const [quality, setQuality] = useState<DesktopQuality>(savedQuality);
  const sessionRef = useRef<RemoteDesktopSession | null>(null);

  const connect = useCallback(async () => {
    setPhase({ kind: "confirm", error: null, busy: true });
    try {
      let ticket: string | null = null;
      if (where === "passkey" && passkeys) {
        const proof = await confirm({ kind: "desktop", computerId }, passkeys);
        ticket = (await api.desktopTicket(computerId, proof)).ticket;
      } else if (where !== "here") {
        throw new Error("这台设备上开不了这台电脑的远程桌面。");
      }
      const base = `${location.origin.replace(/^http/, "ws")}/api/desktop/${encodeURIComponent(computerId)}`;
      const session = new RemoteDesktopSession(ticket ? `${base}?ticket=${encodeURIComponent(ticket)}` : base, quality, {
        onState: (next) => {
          setState(next);
          // 视频接上了：盖在上面的那张 JPEG 拿掉。
          if (next.kind === "live") setStill(null);
        },
        onStream: (next) => {
          setStream(next);
          setStill(null);
        },
        onImage: setStill,
        onControl: (on, message) => setControl({ on, message }),
        onLatency: setLatency
      });
      sessionRef.current?.end();
      sessionRef.current = session;
      setStream(null);
      setStill(null);
      setLatency(null);
      setViewOnly(false);
      session.start();
      setPhase({ kind: "session", session });
    } catch (cause) {
      setPhase({
        kind: "confirm",
        busy: false,
        error: cause instanceof Cancelled ? null : cause instanceof Error ? cause.message : String(cause)
      });
    }
  }, [computerId, where, passkeys, quality]);

  // 从「接手」点进来的，接着这次点击弹通行密钥；不用确认的直接连。
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !auto || !where) return;
    started.current = true;
    void connect();
  }, [auto, where, connect]);

  // 卸下时断开。开发时 StrictMode 会先卸一次再挂上：不用确认的已经连上了、被这一下断掉，放开 started 好再连一次；
  // 还在按通行密钥的不动，免得弹两次。
  useEffect(
    () => () => {
      if (!sessionRef.current) return;
      sessionRef.current.end();
      sessionRef.current = null;
      started.current = false;
    },
    []
  );

  const close = () => {
    sessionRef.current?.end();
    sessionRef.current = null;
    onClose();
  };

  if (phase.kind === "confirm") {
    const blocked = known && (where === null || where === "phone" || where === "browser");
    return (
      <Shell onClose={close} title={name}>
        <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center text-white">
          <div className="text-title3 font-semibold">打开「{name}」的远程桌面</div>
          {blocked ? (
            <div className="text-subheadline text-white/70">
              {where === "phone"
                ? "你连过手机，在手机 App 的设置里远程控制。"
                : "只有这台电脑的主人能打开它的远程桌面，电脑要在线。"}
            </div>
          ) : (
            <>
              {where !== "here" && <div className="text-subheadline text-white/70">要用通行密钥确认是你本人。</div>}
              <button
                type="button"
                disabled={phase.busy || !known}
                onClick={() => void connect()}
                className="tap h-bar w-full rounded-full bg-white text-body font-semibold text-black disabled:opacity-60"
              >
                {where === "here" ? (phase.busy ? "正在连接…" : "连接") : phase.busy ? "正在确认…" : "确认并连接"}
              </button>
            </>
          )}
          {phase.error && <div className="text-subheadline text-danger-ink">{phase.error}</div>}
        </div>
      </Shell>
    );
  }

  const session = phase.session;
  const badge =
    state.kind === "connecting"
      ? `正在连接「${name}」…`
      : state.kind === "compatible"
        ? "兼容模式：视频连不上，画面会慢一些"
        : state.kind === "recovering"
          ? "连接断了，正在恢复…"
          : !control.on && !viewOnly
            ? (control.message ?? "这台电脑现在不让操作，只能看")
            : null;

  return (
    <Shell
      onClose={close}
      title={name}
      tools={
        <>
          {latency !== null && <span className="text-caption text-white/60">{latency} ms</span>}
          <select
            aria-label="画质"
            value={quality}
            onChange={(event) => {
              const next = event.target.value as DesktopQuality;
              setQuality(next);
              session.setQuality(next);
              try {
                localStorage.setItem(QUALITY_KEY, next);
              } catch {
                // 不记也能用。
              }
            }}
            className="h-8 rounded-full bg-white/15 px-3 text-footnote text-white"
          >
            {QUALITIES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-pressed={viewOnly}
            onClick={() => {
              session.setViewOnly(!viewOnly);
              setViewOnly(!viewOnly);
            }}
            className={`tap h-8 rounded-full px-3 text-footnote font-semibold ${viewOnly ? "bg-white text-black" : "bg-white/15 text-white"}`}
          >
            只看
          </button>
          <button
            type="button"
            onClick={close}
            className="tap h-8 rounded-full bg-danger-ink px-3 text-footnote font-semibold text-white"
          >
            断开
          </button>
        </>
      }
    >
      <Stage
        stream={stream}
        still={still}
        name={name}
        enabled={control.on && !viewOnly && (state.kind === "live" || state.kind === "compatible")}
        onInput={(event) => session.input(event)}
      />
      {badge && (
        <div
          role="status"
          className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-footnote text-white"
        >
          {badge}
        </div>
      )}
      {state.kind === "busy" && (
        <Dialog
          title={`${state.by}正在看这台电脑`}
          text="接管以后对方会断开。"
          primary="接管"
          onPrimary={() => session.takeOver()}
          onSecondary={close}
        />
      )}
      {state.kind === "ended" && (
        <Dialog
          title="远程桌面断开了"
          text={state.message}
          primary="重新连接"
          onPrimary={() => void connect()}
          secondary="关闭"
          onSecondary={close}
        />
      )}
    </Shell>
  );
}

function Shell({
  title,
  tools,
  onClose,
  children
}: {
  title: string;
  tools?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 没在看画面时 Esc 关掉；看着画面时 Esc 发给电脑。
      if (event.key === "Escape" && !tools) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, tools]);
  return (
    <div role="dialog" aria-label={`「${title}」的远程桌面`} className="fixed inset-0 z-[1000] flex flex-col bg-black">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3 [-webkit-app-region:drag]">
        <button
          type="button"
          aria-label="返回"
          onClick={onClose}
          className="tap grid size-8 place-items-center rounded-full bg-white/15 text-white [-webkit-app-region:no-drag]"
        >
          <ChevronLeftIcon />
        </button>
        <span className="min-w-0 flex-1 truncate text-subheadline font-semibold text-white">{title}</span>
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">{tools}</div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center">{children}</div>
    </div>
  );
}

function Dialog({
  title,
  text,
  primary,
  onPrimary,
  secondary = "取消",
  onSecondary
}: {
  title: string;
  text: string;
  primary: string;
  onPrimary: () => void;
  secondary?: string;
  onSecondary: () => void;
}) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/50">
      <div role="alertdialog" aria-label={title} className="strong flex w-80 flex-col gap-3 rounded-bubble p-5">
        <div className="text-headline font-semibold">{title}</div>
        <div className="text-subheadline text-muted">{text}</div>
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onSecondary} className="tap h-control flex-1 rounded-full bg-surface-inset text-body">
            {secondary}
          </button>
          <button
            type="button"
            onClick={onPrimary}
            className="tap h-control flex-1 rounded-full bg-foreground text-body font-semibold text-background"
          >
            {primary}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 画面和输入。画面按比例放进可用区域，鼠标位置换算成在画面里的 0 到 1；画面外的不发。
 * 键盘：点一下画面就把焦点给一个看不见的输入框。命名键和 ⌘ 快捷键在 keydown 里发，其余的等文字落定再发，拼音选完字才走。
 */
function Stage({
  stream,
  still,
  name,
  enabled,
  onInput
}: {
  stream: MediaStream | null;
  still: string | null;
  name: string;
  enabled: boolean;
  onInput: (event: DesktopInput) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const typing = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const live = useRef({ enabled, onInput });
  live.current = { enabled, onInput };

  useEffect(() => {
    if (video.current && video.current.srcObject !== stream) video.current.srcObject = stream;
  }, [stream]);

  /** 画面实际画在哪：object-contain 留了黑边，按画面自己的宽高比算。 */
  const ratio = (clientX: number, clientY: number, clamp = false): { x: number; y: number } | null => {
    const showing = still ? image.current : video.current;
    if (!showing) return null;
    const box = showing.getBoundingClientRect();
    const width = still ? (image.current?.naturalWidth ?? 0) : (video.current?.videoWidth ?? 0);
    const height = still ? (image.current?.naturalHeight ?? 0) : (video.current?.videoHeight ?? 0);
    if (width === 0 || height === 0 || box.width === 0) return null;
    const scale = Math.min(box.width / width, box.height / height);
    const shownWidth = width * scale;
    const shownHeight = height * scale;
    const left = box.left + (box.width - shownWidth) / 2;
    const top = box.top + (box.height - shownHeight) / 2;
    const x = (clientX - left) / shownWidth;
    const y = (clientY - top) / shownHeight;
    if (clamp) return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  };

  // 滚轮要能 preventDefault，React 的 onWheel 是被动的，自己挂。
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!live.current.enabled) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const dx = Math.max(-2000, Math.min(2000, Math.round(event.deltaX * unit)));
      const dy = Math.max(-2000, Math.min(2000, Math.round(event.deltaY * unit)));
      if (dx !== 0 || dy !== 0) live.current.onInput({ t: "scroll", dx, dy });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  // 停止操作时，按着的键鼠松开。
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (wasEnabled.current && !enabled) live.current.onInput({ t: "release" });
    wasEnabled.current = enabled;
  }, [enabled]);

  /** 按下的那颗键还没松：拖到画面外也照样跟着，松开一定发 up，免得电脑上一直按着。 */
  const pressed = useRef(false);
  const pointer = (kind: "move" | "down" | "up") => (event: React.PointerEvent) => {
    if (!enabled) return;
    const at = ratio(event.clientX, event.clientY, pressed.current);
    if (kind === "down") {
      typing.current?.focus({ preventScroll: true });
      surface.current?.setPointerCapture(event.pointerId);
    }
    if (!at) return;
    if (kind === "down") pressed.current = true;
    if (kind === "up") pressed.current = false;
    if (kind === "move") onInput({ t: "move", ...at });
    else onInput({ t: kind, ...at, b: event.button === 2 ? 2 : event.button === 1 ? 1 : 0 });
  };

  const sendText = () => {
    const node = typing.current;
    if (!node || composing.current || !node.value) return;
    if (live.current.enabled) onInput({ t: "text", s: node.value.slice(0, 2000) });
    node.value = "";
  };

  return (
    <div
      ref={surface}
      aria-label={`「${name}」的画面`}
      className={`absolute inset-0 flex touch-none items-center justify-center select-none ${enabled ? "cursor-default" : "cursor-not-allowed"}`}
      onPointerMove={pointer("move")}
      onPointerDown={pointer("down")}
      onPointerUp={pointer("up")}
      onPointerCancel={() => {
        pressed.current = false;
        onInput({ t: "release" });
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        data-remote-video=""
        className={`max-h-full max-w-full object-contain ${still || !stream ? "hidden" : ""}`}
      />
      {still && (
        <img ref={image} src={still} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
      )}
      <textarea
        ref={typing}
        aria-label="打字发到电脑"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="absolute bottom-0 left-0 size-px opacity-0"
        onKeyDown={(event) => {
          const key = keyOf(event.nativeEvent);
          if (!key) return;
          event.preventDefault();
          if (live.current.enabled) onInput(key);
        }}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => {
          composing.current = false;
          sendText();
        }}
        onInput={(event) => {
          if (!(event.nativeEvent as InputEvent).isComposing) sendText();
        }}
      />
    </div>
  );
}
