import { Button, Dropdown, Label, Spinner } from "@heroui/react";
import {
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { Streamdown } from "streamdown";
import type { ComputerActivity } from "../bridge/activity";
import type { ApprovalView } from "../bridge/approvals";
import type { ComputerView } from "../bridge/protocol";
import type { MemberView } from "../members";
import { BROWSER_CANCEL_TEXT, quotedMessage, type Sender } from "../messages";
import { MemberAvatar } from "./Avatar";
import type { Project } from "../projects";
import { reportQuote, STATUS_LABELS, type ReportCard, type ReportStatus } from "../reports";
import { openRemoteDesktop, useRemoteDesktop } from "./RemoteDesktop";
import { BrowserCard, type BrowserFrameView } from "./BrowserCard";
import { offerBrowserCancel } from "./BrowserTakeover";
import {
  buildRows,
  stepText,
  type BrowserTask,
  type ChatRow,
  type ComputerTask,
  type StepIcon,
  type StepStatus,
  type ToolStep
} from "./chat-rows";
import { Composer } from "./Composer";
import { desktop, useDesktopComputer } from "./desktop";
import { begin, IDLE, restoreDraft, settle, type Outbox } from "./outbox";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  ComputerIcon,
  CopyIcon,
  CursorIcon,
  FileIcon,
  FolderIcon,
  KeyboardIcon,
  PencilIcon,
  ReplyIcon,
  ScreenshotIcon,
  TerminalIcon
} from "./icons";
import { usePiSession } from "./use-pi-session";

/** 对话里要用到的项目、电脑和请示，以及点项目标签的动作。 */
export type ChatContext = {
  readonly projects: ReadonlyMap<string, Project>;
  /** 只有聊天里才在回复上方画项目标签；项目会话里不建也不转交项目。 */
  readonly projectTags: boolean;
  readonly computers: readonly ComputerView[];
  readonly approvals: readonly ApprovalView[];
  readonly members: readonly MemberView[];
  /** 项目报回聊天的结果。只有聊天里有，项目会话里是 undefined。 */
  readonly reports?: readonly ReportCard[];
  readonly onOpenProject: (projectId: string) => void;
  readonly onProjectsChanged: () => void;
  /** 收到电脑在做什么的更新。 */
  readonly onActivity?: (activity: readonly ComputerActivity[]) => void;
};

type ChatProps = {
  readonly session: string;
  readonly context: ChatContext;
  /** 盖在对话顶上的东西，比如项目名。滚回最新消息时淡出，往回翻时出现。 */
  readonly top?: ReactNode;
  readonly empty: ReactNode;
  readonly placeholder: string;
  readonly starters?: readonly string[];
};

/** 离底部这么近就算在底部，新内容来了跟着滚。 */
const STICK_DISTANCE = 80;

export function Chat({ session, context, top, empty, placeholder, starters = [] }: ChatProps) {
  const pi = usePiSession(session, context.onProjectsChanged, context.onActivity);
  const [draft, setDraft] = useState("");
  const [quote, setQuote] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<Outbox>(IDLE);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  /** 用户往上翻了：右下角出现「回到底部」。 */
  const [away, setAway] = useState(false);
  /** 用户翻回了最新消息，顶上的东西让开。 */
  const [settled, setSettled] = useState(false);
  /** 长按或右键的那条消息的文字，和菜单弹出的位置：鼠标在光标处，长按在消息下沿。 */
  const [menu, setMenu] = useState<{ text: string; x: number; y: number } | null>(null);
  const menuAnchor = useRef<HTMLSpanElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);

  const rows = buildRows(pi, { ...context, toggled });
  const here = useDesktopComputer();
  const cardFrames = CARD_FRAMES;
  const lastCard = [...rows].reverse().find((row) => row.kind === "browser")?.id;
  function frameFor(task: BrowserTask): BrowserFrameView | null {
    // 最后一张卡做完得快，第一帧可能晚到：做完后到的画面也收下，收起的卡片上留着最后的样子。
    if (task.state === "live" || task.state === "waiting" || task.state === "handover" || (task.id === lastCard && !cardFrames.current.has(task.id))) {
      const live = task.computerId
        ? pi.frames.get(task.computerId)
        : pi.frames.size === 1
          ? [...pi.frames.values()][0]
          : undefined;
      if (live) cardFrames.current.set(task.id, live);
    }
    return cardFrames.current.get(task.id) ?? null;
  }
  // 浏览器任务的「取消任务」：这一轮还在跑就停掉；已经停下来等人接手了，就替人说一句不做了。
  // 卡片上的停止按钮和电脑上接手的放大视图里的「取消任务」都用它。
  const browserActive = rows.some(
    (row) => row.kind === "browser" && (row.task.state === "live" || row.task.state === "waiting" || row.task.state === "handover")
  );
  const { running, abort, submit } = pi;
  const cancelBrowser = useMemo(
    () =>
      !browserActive
        ? undefined
        : running
          ? abort
          : () => void submit(BROWSER_CANCEL_TEXT, crypto.randomUUID()).catch(() => undefined),
    [browserActive, running, abort, submit]
  );
  useEffect(() => (cancelBrowser ? offerBrowserCancel(cancelBrowser) : undefined), [cancelBrowser]);
  const browser = {
    frameFor,
    onStop: cancelBrowser,
    takeOver: (task: BrowserTask) => {
      const app = desktop();
      if (!app?.showBrowser || !here?.computerId || here.computerId !== task.computerId) return undefined;
      return () => void app.showBrowser?.();
    }
  };

  // 在底部时跟着新内容往下滚；用户往上翻了就不打扰。
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [rows.length, pi.live, pi.running]);

  async function send(text = draft) {
    const value = text.trim();
    if (!value) return;
    const next = begin(outbox, text, quote, () => crypto.randomUUID());
    if (!next) return;
    const { sent } = next;
    setOutbox(next);
    setDraft("");
    setQuote(null);
    stick.current = true;
    let error: string | null = null;
    try {
      await pi.submit(sent.quote ? quotedMessage(sent.quote, value) : value, sent.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      setDraft((current) => restoreDraft(current, sent));
      setQuote((current) => current ?? sent.quote);
    }
    setOutbox((current) => settle(current, sent.id, error));
  }

  function toggle(id: string) {
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function toBottom() {
    const node = scroller.current;
    if (!node) return;
    stick.current = true;
    setAway(false);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }

  function openMenu(anchor: HTMLElement, text: string, point?: MenuPoint) {
    const box = anchor.getBoundingClientRect();
    setMenu({ text, ...(point ?? { x: box.left + box.width / 2, y: box.bottom }) });
  }

  function onMenuAction(key: string) {
    if (menu === null) return;
    if (key === "copy") void navigator.clipboard?.writeText(menu.text);
    if (key === "reply") {
      setQuote(menu.text);
      input.current?.focus();
    }
    setMenu(null);
  }

  const isEmpty = rows.length === 0 && !pi.running;
  const loading = isEmpty && !pi.synced;
  const canSend = Boolean(draft.trim()) && pi.status === "open" && outbox.status !== "sending";

  return (
    <div className="fade-in relative flex h-full flex-col">
      {top && (
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-4 transition-opacity duration-200 ${settled ? "opacity-0" : ""}`}
        >
          {top}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div className="scroll-fade" aria-hidden="true" />
        <div
          ref={scroller}
          onScroll={(event) => {
            const node = event.currentTarget;
            stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_DISTANCE;
            if (away === stick.current) {
              setAway(!stick.current);
              setSettled(stick.current);
            }
          }}
          className="h-full overflow-y-auto"
        >
          <div
            data-capped={top ? "" : undefined}
            className="scroll-body mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 pb-4 lg:px-6"
          >
            {loading && (
              <div className="my-auto flex justify-center">
                <Spinner size="sm" aria-label="正在打开" />
              </div>
            )}
            {isEmpty && !loading && (
              <div className="my-auto flex flex-col items-center gap-5 py-8">
                {empty}
                {starters.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-2">
                    {starters.map((starter) => (
                      <button
                        key={starter}
                        type="button"
                        onClick={() => void send(starter)}
                        className="soft lift tap rounded-full px-3.5 py-2 text-subheadline"
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {rows.map((row) => (
              <div key={row.id} className={row.gap === 12 ? "mt-3" : row.gap === 8 ? "mt-2" : ""}>
                <Row row={row} context={context} onMenu={openMenu} onToggle={toggle} browser={browser} />
              </div>
            ))}
          </div>
        </div>
        {away && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 mx-auto flex max-w-2xl justify-end px-4 lg:px-6">
            <button
              type="button"
              aria-label="回到底部"
              onClick={toBottom}
              className="glass lift tap pointer-events-auto grid size-9 place-items-center rounded-full text-[18px]"
            >
              <ChevronDownIcon />
            </button>
          </div>
        )}
      </div>

      {/* 引用回复时把对话虚化，只留被引用的那条在输入框上面。 */}
      {quote !== null && (
        <button
          type="button"
          aria-label="取消回复"
          onClick={() => setQuote(null)}
          className="absolute inset-0 z-20 bg-black/5 backdrop-blur-md"
        />
      )}

      <div className="pb-safe relative z-30 shrink-0">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-3 lg:px-6">
          {quote !== null && (
            <div className="flex items-start gap-2">
              <div className="strong bubble max-w-[85%] rounded-bubble px-4 py-2.5 text-message">
                <div className="line-clamp-4 whitespace-pre-wrap">{quote}</div>
              </div>
              <Button
                isIconOnly
                variant="ghost"
                aria-label="取消回复"
                onPress={() => setQuote(null)}
                className="glass lift tap size-9 min-w-9 rounded-full"
              >
                <CloseIcon />
              </Button>
            </div>
          )}
          {pi.status !== "open" && (
            <div className="text-center text-footnote text-ink-sky-muted">
              {pi.status === "connecting" ? "正在连接 Pupu…" : "连接断开，正在重连…"}
            </div>
          )}
          {outbox.status === "failed" && (
            <div className="text-center text-footnote text-danger-ink">{outbox.error}</div>
          )}
          {pi.queued > 0 && (
            <div className="text-center text-footnote text-ink-sky-muted">
              还有 {pi.queued} 条消息排着队，Pupu 说完这轮就处理
            </div>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => void send()}
            placeholder={quote !== null ? "回复消息" : placeholder}
            canSend={canSend}
            sendLabel={pi.running ? "排队发送" : "发送"}
            onStop={pi.running && !draft.trim() ? () => pi.abort() : undefined}
            onEscape={quote !== null ? () => setQuote(null) : undefined}
            inputRef={input}
          />
        </div>
      </div>

      <span ref={menuAnchor} aria-hidden="true" className="fixed size-0" style={{ left: menu?.x, top: menu?.y }} />
      <Dropdown
        isOpen={menu !== null}
        onOpenChange={(open) => {
          if (!open) setMenu(null);
        }}
      >
        <Dropdown.Popover triggerRef={menuAnchor} placement="bottom start" className="w-fit min-w-32">
          <Dropdown.Menu aria-label="消息操作" onAction={(key) => onMenuAction(String(key))}>
            <Dropdown.Item id="copy" textValue="复制">
              <CopyIcon />
              <Label>复制</Label>
            </Dropdown.Item>
            <Dropdown.Item id="reply" textValue="回复">
              <ReplyIcon />
              <Label>回复</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}

/** 手机上长按、电脑上右键，都打开菜单。 */
export function usePressMenu(onMenu: (anchor: HTMLElement, point?: MenuPoint) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** 长按弹了菜单：手指抬起时的那次点击不算数。 */
  const pressed = useRef(false);

  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  }

  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      pressed.current = false;
      if (event.pointerType === "mouse") return;
      const target = event.currentTarget;
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        cancel();
        pressed.current = true;
        navigator.vibrate?.(10);
        onMenu(target);
      }, 450);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const origin = start.current;
      if (!origin) return;
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu(event: ReactMouseEvent<HTMLElement>) {
      event.preventDefault();
      cancel();
      onMenu(event.currentTarget, event.button === 2 ? { x: event.clientX, y: event.clientY } : undefined);
    },
    onClickCapture(event: ReactMouseEvent<HTMLElement>) {
      if (!pressed.current) return;
      pressed.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };
}

/**
 * 每张浏览器卡片最后看到的画面：做完了还留着。放在模块里，切到别的对话再切回来也还在；刷新页面就没了
 * （云端会先补发每台电脑最后一帧，见 server.ts 的 #framesFor）。
 */
const CARD_FRAMES = { current: new Map<string, BrowserFrameView>() };

type MenuPoint = { readonly x: number; readonly y: number };
type MenuOpener = (anchor: HTMLElement, text: string, point?: MenuPoint) => void;

type BrowserHooks = {
  readonly frameFor: (task: BrowserTask) => BrowserFrameView | null;
  readonly onStop?: () => void;
  readonly takeOver: (task: BrowserTask) => (() => void) | undefined;
};

function Row({
  row,
  context,
  onMenu,
  onToggle,
  browser
}: {
  row: ChatRow;
  context: ChatContext;
  onMenu: MenuOpener;
  onToggle: (id: string) => void;
  browser: BrowserHooks;
}) {
  switch (row.kind) {
    case "browser":
      return (
        <BrowserCard
          task={row.task}
          frame={browser.frameFor(row.task)}
          onStop={browser.onStop}
          onTakeOver={browser.takeOver(row.task)}
        />
      );
    case "user":
      return row.sender ? (
        <OtherMessage
          body={row.body}
          quote={row.quote}
          sender={row.sender}
          avatar={context.members.find((member) => member.id === row.sender?.id)?.avatar ?? null}
          onMenu={onMenu}
        />
      ) : (
        <UserMessage body={row.body} quote={row.quote} onMenu={onMenu} />
      );
    case "assistant":
      return <AssistantText text={row.text} onMenu={onMenu} />;
    case "typing":
      return <Typing retrying={row.retrying} />;
    case "project-tag":
      return <ProjectTag name={row.name} projectId={row.projectId} context={context} />;
    case "tool":
      return <ToolCard step={row.step} onToggle={() => onToggle(row.id)} />;
    case "computer":
      return <ComputerCard task={row.task} onToggle={onToggle} />;
    case "notice":
      return (
        <div className="flex justify-center">
          <div className="soft max-w-[85%] rounded-row px-3 py-2 text-center text-footnote text-muted">
            {row.text}
          </div>
        </div>
      );
    case "handoff":
      return (
        <div className="flex justify-center">
          <div className="soft flex max-w-[85%] flex-col gap-0.5 rounded-row px-3 py-2 text-center">
            <span className="text-footnote text-muted">从聊天转来</span>
            <span className="text-subheadline whitespace-pre-wrap">{row.text}</span>
          </div>
        </div>
      );
    case "report":
      return <ReportBubble card={row.card} context={context} onMenu={onMenu} />;
    case "error":
      return (
        <div className="strong w-fit max-w-[85%] rounded-row px-4 py-2.5 text-subheadline [overflow-wrap:anywhere] text-danger-ink">
          {row.text}
        </div>
      );
  }
}

function UserMessage({ body, quote, onMenu }: { body: string; quote: string | null; onMenu: MenuOpener }) {
  const press = usePressMenu((anchor, point) => onMenu(anchor, body, point));
  return (
    <div className="flex flex-col items-end gap-1">
      {quote && <QuoteStrip quote={quote} className="max-w-[85%]" />}
      <div
        {...press}
        className="pressable max-w-[85%] rounded-bubble bg-bubble-user px-4 py-2.5 text-message whitespace-pre-wrap backdrop-blur-xl"
      >
        {body}
      </div>
    </div>
  );
}

function QuoteStrip({ quote, className = "" }: { quote: string; className?: string }) {
  return (
    <div className={`soft flex gap-2 rounded-row px-3 py-2 ${className}`}>
      <span className="w-0.5 shrink-0 rounded-full bg-muted" aria-hidden="true" />
      <span className="line-clamp-2 text-footnote">{quote}</span>
    </div>
  );
}

/** 别人发的：靠左，头像在气泡旁边，名字在气泡里。字不直接写在天空上。 */
function OtherMessage({
  body,
  quote,
  sender,
  avatar,
  onMenu
}: {
  body: string;
  quote: string | null;
  sender: Sender;
  /** 他现在的头像，按成员 id 从名单里查，换了头像旧消息也跟着换。没换过、已经移除了是 null。 */
  avatar: string | null;
  onMenu: MenuOpener;
}) {
  const press = usePressMenu((anchor, point) => onMenu(anchor, body, point));
  return (
    <div className="flex max-w-[85%] items-start gap-2">
      <MemberAvatar name={sender.name} src={avatar} className="strong size-8 text-footnote" />
      <div className="flex min-w-0 flex-col items-start gap-1">
        {quote && <QuoteStrip quote={quote} className="max-w-full" />}
        <div
          {...press}
          className="pressable max-w-full rounded-bubble bg-bubble-user px-4 py-2.5 text-message whitespace-pre-wrap backdrop-blur-xl"
        >
          <div className="text-footnote">{sender.name}</div>
          {body}
        </div>
      </div>
    </div>
  );
}

function AssistantText({ text, onMenu }: { text: string; onMenu: MenuOpener }) {
  const press = usePressMenu((anchor, point) => onMenu(anchor, text, point));
  return (
    <div {...press} className="pressable strong bubble w-fit max-w-[85%] rounded-bubble px-4 py-2.5">
      <Streamdown className="sd-theme text-message" controls={false}>
        {text}
      </Streamdown>
    </div>
  );
}

/** Pupu 还没出字：一个只有三个点的气泡。 */
function Typing({ retrying }: { retrying: boolean }) {
  return (
    <div
      role="status"
      aria-label={retrying ? "模型忙，正在重试" : "Pupu 在想"}
      className="strong bubble flex w-fit items-center gap-2 rounded-bubble px-4 py-[13px] text-muted"
    >
      <span className="inline-flex gap-1">
        {["0ms", "150ms", "300ms"].map((delay) => (
          <span
            key={delay}
            className="size-1.5 animate-pulse rounded-full bg-current"
            style={{ animationDelay: delay }}
          />
        ))}
      </span>
      {retrying && <span className="text-subheadline">模型忙，正在重试…</span>}
    </div>
  );
}

/** 回复上方的项目标签：这件事交给了哪个项目，点一下过去。 */
function ProjectTag({
  name,
  projectId,
  context
}: {
  name: string;
  projectId: string | null;
  context: ChatContext;
}) {
  return (
    <button
      type="button"
      disabled={!projectId}
      onClick={() => projectId && context.onOpenProject(projectId)}
      className="strong bubble flex h-8 items-center gap-2 rounded-tag px-3 text-footnote pointer-fine:h-7"
    >
      <FolderIcon className="text-[15px] pointer-fine:text-[13px]" />
      {name}
    </button>
  );
}

/**
 * 项目报回来的结果：项目名、状态、一句结果，整张卡点过去。同一个项目没看过的几条合成这一张。
 * 长按或右键能引用回复，引用里带着项目名，聊天里的 Pupu 就知道在说哪个项目。
 */
function ReportBubble({ card, context, onMenu }: { card: ReportCard; context: ChatContext; onMenu: MenuOpener }) {
  const press = usePressMenu((anchor, point) => onMenu(anchor, reportQuote(card), point));
  return (
    <button
      type="button"
      {...press}
      onClick={() => context.onOpenProject(card.projectId)}
      className="pressable strong lift flex w-full max-w-[85%] flex-col gap-1 rounded-row px-3 py-2.5 text-left sm:max-w-96"
    >
      <span className="flex w-full items-center gap-2">
        <FolderIcon className="shrink-0 text-[15px] text-muted pointer-fine:text-[13px]" />
        <span className="min-w-0 flex-1 truncate text-footnote font-semibold">{card.projectName}</span>
        <ReportStatusMark status={card.status} />
        <ChevronRightIcon className="shrink-0 text-[14px] text-muted pointer-fine:text-[12px]" />
      </span>
      <span className="text-subheadline [overflow-wrap:anywhere]">{card.summary}</span>
      {card.more > 0 && <span className="text-caption text-muted">还有 {card.more} 条</span>}
    </button>
  );
}

function ReportStatusMark({ status }: { status: ReportStatus }) {
  switch (status) {
    case "blocked":
      return (
        <span className="shrink-0 rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-warning-foreground">
          {STATUS_LABELS[status]}
        </span>
      );
    case "failed":
      return <span className="shrink-0 text-caption text-danger-ink">{STATUS_LABELS[status]}</span>;
    case "done":
      return <span className="shrink-0 text-caption text-muted">{STATUS_LABELS[status]}</span>;
  }
}

const STEP_ICONS: Record<StepIcon, ReactNode> = {
  terminal: <TerminalIcon />,
  keyboard: <KeyboardIcon />,
  file: <FileIcon />,
  pencil: <PencilIcon />,
  folder: <FolderIcon />,
  screenshot: <ScreenshotIcon />,
  cursor: <CursorIcon />
};

/** 一步操作：收起时一行，点开看输出。只能看，不能操作。 */
function ToolCard({ step, onToggle }: { step: ToolStep; onToggle: () => void }) {
  return (
    <StepCard
      icon={STEP_ICONS[step.icon]}
      title={step.title}
      status={step.status}
      failures={0}
      expanded={step.expanded}
      onToggle={step.output ? onToggle : undefined}
    >
      {step.output && (
        <pre className="mx-3 mb-3 max-h-58 overflow-auto rounded-tag bg-surface-inset px-3 py-2 font-mono text-code break-all whitespace-pre-wrap">
          {step.output}
        </pre>
      )}
      {step.outputPath && (
        <div className="mx-3 mb-3 -mt-1 text-caption break-all text-muted">
          完整输出在 <span className="font-mono">{step.outputPath}</span>
        </div>
      )}
    </StepCard>
  );
}

/**
 * 电脑任务卡：在哪台电脑上、在做什么、状态；带回过截图就显示最近的画面，点「步骤」看每一步。
 * 样子学浏览器卡片和原型里的子会话卡，iOS 的 ComputerCardCell 是同一个样子，两边一起改。
 * 「接手」是打开远程桌面，只给主人自己在线的电脑，网页上先按通行密钥，电脑 App 里交给浏览器，见 RemoteDesktop.tsx。
 */
function ComputerCard({ task, onToggle }: { task: ComputerTask; onToggle: (id: string) => void }) {
  const active = task.state === "live" || task.state === "waiting";
  const remote = useRemoteDesktop(task.computerId);
  return (
    <div
      data-computer-card={task.computerId ?? ""}
      data-state={task.state}
      className="strong flex w-full max-w-[420px] flex-col overflow-hidden rounded-bubble"
    >
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-2">
        <ComputerIcon className="shrink-0 text-[17px] pointer-fine:text-[15px]" />
        <span className="min-w-0 flex-1 truncate text-subheadline font-semibold">
          {task.computer ? `在「${task.computer}」上` : "在电脑上"}
        </span>
        <ComputerStatus task={task} />
      </div>
      {task.screen && (
        <img
          src={`data:${task.screen.mimeType};base64,${task.screen.data}`}
          alt={`「${task.computer ?? "电脑"}」上的画面`}
          className={`mx-3.5 max-h-56 rounded-tag object-cover object-top outline outline-1 -outline-offset-1 outline-black/5 ${active ? "" : "opacity-80"}`}
        />
      )}
      <div className="flex items-center gap-2 px-3.5 pt-2 pb-2.5">
        <span className="min-w-0 flex-1 truncate text-footnote text-muted">{task.latest}</span>
        <button
          type="button"
          aria-expanded={task.expanded}
          onClick={() => onToggle(task.id)}
          className="tap flex h-8 shrink-0 items-center gap-1 rounded-full bg-surface-inset px-3 text-footnote font-semibold pointer-fine:h-7"
        >
          步骤
          <ChevronDownIcon className={`text-[11px] ${task.expanded ? "rotate-180" : ""}`} />
        </button>
        {remote && remote !== "phone" && task.computerId && (
          <button
            type="button"
            onClick={() => openRemoteDesktop(task.computerId!, remote)}
            className="tap flex h-8 shrink-0 items-center rounded-full bg-surface-inset px-3 text-footnote font-semibold pointer-fine:h-7"
          >
            接手
          </button>
        )}
      </div>
      {task.expanded && (
        <ol aria-label="步骤" className="flex flex-col border-t border-separator">
          {task.steps.map((step) => (
            <StepLine key={step.callId} step={step} onToggle={() => onToggle(`tool:${step.callId}`)} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ComputerStatus({ task }: { task: ComputerTask }) {
  switch (task.state) {
    case "live":
      return (
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-muted">
          <Spinner size="sm" aria-hidden="true" className="size-3.5" />
          {task.status}
        </span>
      );
    case "waiting":
      return (
        <span className="shrink-0 rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-warning-foreground">
          {task.status}
        </span>
      );
    case "failed":
      return <span className="shrink-0 text-caption text-danger-ink">{task.status}</span>;
    default:
      return <span className="shrink-0 text-caption text-muted">{task.status}</span>;
  }
}

/** 卡片里的一步：一行，有输出的点开看输出。 */
function StepLine({ step, onToggle }: { step: ToolStep; onToggle: () => void }) {
  const header = (
    <>
      <span className="shrink-0 text-[15px] text-muted pointer-fine:text-[13px]">{STEP_ICONS[step.icon]}</span>
      <span className="min-w-0 flex-1 text-left text-footnote break-words">{stepText(step)}</span>
      <StepStatusMark status={step.status} failures={0} />
    </>
  );
  return (
    <li className="flex flex-col">
      {step.output ? (
        <button
          type="button"
          aria-expanded={step.expanded}
          onClick={onToggle}
          className="flex min-h-9 w-full items-center gap-2 px-3.5 py-2 hover:bg-foreground/4"
        >
          {header}
        </button>
      ) : (
        <div className="flex min-h-9 items-center gap-2 px-3.5 py-2">{header}</div>
      )}
      {step.expanded && step.output && (
        <pre className="mx-3.5 mb-2.5 max-h-58 overflow-auto rounded-tag bg-surface-inset px-3 py-2 font-mono text-code break-all whitespace-pre-wrap">
          {step.output}
        </pre>
      )}
      {step.expanded && step.outputPath && (
        <div className="mx-3.5 mb-2.5 text-caption break-all text-muted">
          完整输出在 <span className="font-mono">{step.outputPath}</span>
        </div>
      )}
    </li>
  );
}

function StepCard({
  icon,
  title,
  status,
  failures,
  expanded,
  onToggle,
  children
}: {
  icon: ReactNode;
  title: string;
  status: StepStatus;
  failures: number;
  expanded: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const header = (
    <>
      <span className="shrink-0 text-[16px] pointer-fine:text-[14px]">{icon}</span>
      <span className="min-w-0 flex-1 text-left text-subheadline break-words">{title}</span>
      <StepStatusMark status={status} failures={failures} />
      {onToggle && (
        <span className="shrink-0 text-[14px] text-muted pointer-fine:text-[12px]">
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
      )}
    </>
  );
  return (
    <div className={`strong max-w-[85%] rounded-row ${expanded && children ? "w-full" : "w-fit"}`}>
      {onToggle ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="lift flex min-h-10 w-full items-center gap-2 rounded-row px-3 py-2.5 pointer-fine:min-h-9 pointer-fine:py-2"
        >
          {header}
        </button>
      ) : (
        <div className="flex min-h-10 items-center gap-2 px-3 py-2.5 pointer-fine:min-h-9 pointer-fine:py-2">
          {header}
        </div>
      )}
      {expanded && children}
    </div>
  );
}

function StepStatusMark({ status, failures }: { status: StepStatus; failures: number }) {
  switch (status) {
    case "waiting":
      return (
        <span className="shrink-0 rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-warning-foreground">
          等你批准
        </span>
      );
    case "running":
      return <Spinner size="sm" aria-label="在做" className="shrink-0" />;
    case "done":
      return null;
    case "failed":
      return (
        <span className="shrink-0 text-caption text-danger-ink">
          {failures > 1 ? `${failures} 件没成` : "失败"}
        </span>
      );
    case "denied":
      return <span className="shrink-0 text-caption text-muted">已拒绝</span>;
    case "expired":
      return <span className="shrink-0 text-caption text-muted">没人批，作废了</span>;
    case "unfinished":
      return <span className="shrink-0 text-caption text-muted">没做完</span>;
  }
}
