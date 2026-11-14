import { Dropdown, Label, Spinner } from "@heroui/react";
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
import { SpaceMark, TaskList, type TaskItem } from "./Spaces";
import type { ChildView } from "../server";
import type { Project } from "../projects";
import { reportQuote, STATUS_LABELS, type ReportCard, type ReportStatus } from "../reports";
import { openRemoteDesktop, useRemoteDesktop } from "./RemoteDesktop";
import { BrowserCard, type BrowserFrameView } from "./BrowserCard";
import { offerBrowserCancel } from "./BrowserTakeover";
import {
  buildRows,
  clockTime,
  dividerTime,
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
  CheckIcon,
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
  /** 空间的子会话，按会话 id。任务卡上的状态从这里查。 */
  readonly children?: ReadonlyMap<string, ChildView>;
  readonly onOpenChild?: (session: string) => void;
  /** 转来的第一条上面写的「从哪来」。默认「从聊天转来」。 */
  readonly handoffFrom?: string;
  /** 拉状态出错了（多半是连不上）：输入栏上方那一行写它，不弹 toast。 */
  readonly stateError?: string | null;
  /** 开着的子会话（宽屏开在右边）。任务列表里它那一行铺 surface-inset。 */
  readonly openChild?: string | null;
};

type ChatProps = {
  readonly session: string;
  readonly context: ChatContext;
  readonly empty: ReactNode;
  readonly placeholder: string;
  readonly starters?: readonly string[];
};

/** 离底部这么近就算在底部，新内容来了跟着滚。 */
const STICK_DISTANCE = 80;

export function Chat({ session, context, empty, placeholder, starters = [] }: ChatProps) {
  const pi = usePiSession(session, context.onProjectsChanged, context.onActivity);
  const [draft, setDraft] = useState("");
  const [quote, setQuote] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<Outbox>(IDLE);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  /** 用户往上翻了：右下角出现「回到底部」。 */
  const [away, setAway] = useState(false);
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

  // StatusLine：输入栏上方同一时间只写一行，连接比排队要紧。
  const statusLine =
    pi.status === "connecting"
      ? "正在连接 Pupu…"
      : pi.status !== "open"
        ? "连接断开，正在重连…"
        : context.stateError
          ? context.stateError
          : pi.queued > 0
            ? `还有 ${pi.queued} 条消息排着队，Pupu 说完这轮就处理`
            : null;
  // 在底部时跟着新内容往下滚；用户往上翻了就不打扰。
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [rows.length, pi.live, pi.running, statusLine]);

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
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={(event) => {
            const node = event.currentTarget;
            stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_DISTANCE;
            if (away === stick.current) setAway(!stick.current);
          }}
          className="scroll-fade h-full overflow-y-auto"
        >
          <div className="mx-auto flex min-h-full w-full max-w-column flex-col px-4 pt-3 pb-4">
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
                        className="bg-surface-inset tap rounded-full px-3 py-2 text-subheadline text-ink"
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {groupTasks(rows).map((item) =>
              item.kind === "tasks" ? (
                <div key={item.id} className={GAPS[item.gap]}>
                  <TaskList tasks={item.tasks} children={context.children} open={context.openChild ?? null} onOpen={context.onOpenChild} />
                </div>
              ) : (
                <div key={item.row.id} className={GAPS[item.row.gap]}>
                  <Row row={item.row} context={context} onMenu={openMenu} onToggle={toggle} browser={browser} />
                </div>
              )
            )}
            {/* 没发出去：跟在对话最后，写清楚怎么了。字已经放回输入框。 */}
            {outbox.status === "failed" && (
              <div className={rows.length > 0 ? "mt-3" : ""}>
                <ErrorRow text={`这条没发出去：${outbox.error}`} />
              </div>
            )}
          </div>
        </div>
        {away && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 mx-auto flex max-w-column justify-end px-4">
            <button
              type="button"
              aria-label="回到底部"
              onClick={toBottom}
              className="bg-surface shadow-raised tap pointer-events-auto grid size-9 place-items-center rounded-full text-[18px]"
            >
              <ChevronDownIcon />
            </button>
          </div>
        )}
      </div>

      {/* 引用回复时对话压一层 scrim（不模糊），只留被引用的那条在输入框上面。 */}
      {quote !== null && (
        <button
          type="button"
          aria-label="取消回复"
          onClick={() => setQuote(null)}
          className="absolute inset-0 z-20 bg-scrim"
        />
      )}

      <div className="pb-safe relative z-30 shrink-0">
        <div className="mx-auto flex w-full max-w-column flex-col gap-2 px-4 pb-3">
          {quote !== null && (
            <div className="flex items-start gap-2">
              <div className="bg-surface shadow-card min-w-0 flex-1 rounded-bubble px-4 py-2.5 text-message">
                <div className="line-clamp-4 whitespace-pre-wrap">{quote}</div>
              </div>
              <button
                type="button"
                aria-label="取消回复"
                onClick={() => setQuote(null)}
                className="bg-surface-inset tap grid size-control-sm shrink-0 place-items-center rounded-full text-[18px]"
              >
                <CloseIcon />
              </button>
            </div>
          )}
          {statusLine && (
            <div role="status" className="text-center text-footnote text-ink-muted">
              {statusLine}
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

/** 行和上一行的间距：同一条消息里 space-2，消息之间 space-3。 */
const GAPS = { 0: "", 8: "mt-2", 12: "mt-3" } as const;

type ChildRow = Extract<ChatRow, { kind: "child" }>;
type RowItem =
  | { readonly kind: "row"; readonly row: ChatRow }
  | { readonly kind: "tasks"; readonly id: string; readonly gap: ChatRow["gap"]; readonly tasks: TaskItem[] };

/** 连着派出去的几件事（TaskList）列成一块，挂在那条回复下面。 */
function groupTasks(rows: readonly ChatRow[]): RowItem[] {
  const items: RowItem[] = [];
  for (const row of rows) {
    const last = items.at(-1);
    if (row.kind !== "child") items.push({ kind: "row", row });
    else if (last?.kind === "tasks") last.tasks.push(taskItem(row));
    else items.push({ kind: "tasks", id: row.id, gap: row.gap, tasks: [taskItem(row)] });
  }
  return items;
}

function taskItem(row: ChildRow): TaskItem {
  return { id: row.id, title: row.title, session: row.session };
}

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
      // computerCards 已经把每一步合进了卡片，这里只是兜底：画成一步的 ToolCallCard。
      return (
        <div className="bg-surface-inset w-full overflow-hidden rounded-row">
          <ToolHead
            icon={STEP_ICONS[row.step.icon]}
            title={row.step.title}
            result={<StepResult status={row.step.status} />}
            expanded={row.step.expanded}
            onToggle={row.step.output ? () => onToggle(row.id) : undefined}
          />
          {row.step.expanded && <ToolOutput step={row.step} />}
        </div>
      );
    case "computer":
      return row.task.usesScreen ? (
        <ComputerCard task={row.task} onToggle={onToggle} />
      ) : (
        <ToolCallCard task={row.task} onToggle={onToggle} />
      );
    case "time":
      return <TimeDivider at={row.at} />;
    case "notice":
      return (
        <div className="flex justify-center">
          <div className="bg-surface-inset max-w-[85%] rounded-row px-3 py-2 text-center text-footnote text-ink-muted">
            {row.text}
          </div>
        </div>
      );
    case "handoff":
      // SubSession 的「从主会话派来」：对话最上面一块，第一行从哪来，下面是派来时的那段话。
      return (
        <div className="bg-surface-inset flex w-full flex-col gap-0.5 rounded-[14px] px-3.5 py-2.5 text-footnote">
          <span className="font-semibold">{context.handoffFrom ?? "从聊天转来"}</span>
          <span className="whitespace-pre-wrap text-ink-muted">{row.text}</span>
        </div>
      );
    case "report":
      return <ReportBubble card={row.card} context={context} onMenu={onMenu} />;
    case "child":
      // 平常在 groupTasks 里和相邻的几件合成一块，这里只是兜底。
      return <TaskList tasks={[taskItem(row)]} children={context.children} open={context.openChild ?? null} onOpen={context.onOpenChild} />;
    case "error":
      return <ErrorRow text={row.text} />;
  }
}

/**
 * 对话里的出错提示（StatusLine）：靠左，内边距和气泡一样，subheadline、danger-ink。
 * 规范 README 写 surface 底，它的预览用 surface-inset；会话卡本身就是 surface，照预览。
 */
function ErrorRow({ text }: { text: string }) {
  return (
    <div className="bg-surface-inset w-fit max-w-bubble rounded-row px-4 py-2.5 text-subheadline [overflow-wrap:anywhere] text-danger-ink">
      {text}
    </div>
  );
}

function UserMessage({ body, quote, onMenu }: { body: string; quote: string | null; onMenu: MenuOpener }) {
  const press = usePressMenu((anchor, point) => onMenu(anchor, body, point));
  return (
    <div className="flex flex-col items-end gap-1">
      {quote && <QuoteStrip quote={quote} className="max-w-[75%]" />}
      <div
        {...press}
        className="pressable max-w-bubble rounded-bubble bg-bubble-user px-4 py-2.5 text-message whitespace-pre-wrap"
      >
        {body}
      </div>
    </div>
  );
}

/** 发出去的引用：surface-inset 底，左边 2pt ink-muted 竖线，footnote、ink-muted，最多两行。 */
function QuoteStrip({ quote, className = "" }: { quote: string; className?: string }) {
  return (
    <div className={`bg-surface-inset flex gap-2 rounded-row px-3 py-1.5 text-ink-muted ${className}`}>
      <span className="w-0.5 shrink-0 rounded-full bg-ink-muted" aria-hidden="true" />
      <span className="line-clamp-2 text-footnote">{quote}</span>
    </div>
  );
}

/** 别人发的：靠左，28 的头像在气泡左下，名字写在气泡里第一行。 */
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
    <div className="flex max-w-bubble items-end gap-2">
      <MemberAvatar name={sender.name} src={avatar} className="bg-surface-inset size-7 text-caption" />
      <div className="flex min-w-0 flex-col items-start gap-1">
        {quote && <QuoteStrip quote={quote} className="max-w-full" />}
        <div
          {...press}
          className="pressable max-w-full rounded-bubble bg-bubble-user px-4 py-2.5 text-message whitespace-pre-wrap"
        >
          <div className="mb-0.5 text-footnote text-ink-muted">{sender.name}</div>
          {body}
        </div>
      </div>
    </div>
  );
}

/** Pupu 的回复不套气泡：没有底色和头像，用 message 直接写在卡片上，占满整列。 */
function AssistantText({ text, onMenu }: { text: string; onMenu: MenuOpener }) {
  const press = usePressMenu((anchor, point) => onMenu(anchor, text, point));
  return (
    <div {...press} className="pressable w-full">
      <Streamdown className="sd-theme text-message" controls={false}>
        {text}
      </Streamdown>
    </div>
  );
}

/** Pupu 还没出字：一个只有三个点的 bubble-user 小气泡，点依次明暗。 */
function Typing({ retrying }: { retrying: boolean }) {
  return (
    <div
      role="status"
      aria-label={retrying ? "模型忙，正在重试" : "Pupu 在想"}
      className="flex w-fit items-center gap-2 rounded-bubble bg-bubble-user px-4 py-3 text-ink-muted"
    >
      <span className="inline-flex gap-[5px]">
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

/**
 * 回复上方的项目标签：这件事交给了哪个空间，点一下过去。规范没画，照 SpaceMark 加名字：
 * surface-inset 底，标记方块离边 6，外圆角跟着方块（6 加 6）。
 */
function ProjectTag({
  name,
  projectId,
  context
}: {
  name: string;
  projectId: string | null;
  context: ChatContext;
}) {
  const space = (projectId ? context.projects.get(projectId) : undefined) ?? { name };
  return (
    <button
      type="button"
      disabled={!projectId}
      onClick={() => projectId && context.onOpenProject(projectId)}
      className="bg-surface-inset tap flex h-8 items-center gap-2 rounded-[12px] pr-3 pl-1.5 text-footnote pointer-fine:h-7 pointer-fine:rounded-[10px] pointer-fine:pl-1"
    >
      <SpaceMark space={space} />
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
      className="pressable bg-surface-inset flex w-full max-w-[85%] flex-col gap-1 rounded-row px-3 py-2.5 text-left sm:max-w-96"
    >
      <span className="flex w-full items-center gap-2">
        <SpaceMark space={context.projects.get(card.projectId) ?? { name: card.projectName }} />
        <span className="min-w-0 flex-1 truncate text-footnote font-semibold">{card.projectName}</span>
        <ReportStatusMark status={card.status} />
        <ChevronRightIcon className="shrink-0 text-[14px] text-ink-faint pointer-fine:text-[12px]" />
      </span>
      <span className="text-subheadline [overflow-wrap:anywhere]">{card.summary}</span>
      {card.more > 0 && <span className="text-caption text-ink-muted">还有 {card.more} 条</span>}
    </button>
  );
}

function ReportStatusMark({ status }: { status: ReportStatus }) {
  switch (status) {
    case "blocked":
      return (
        <span className="shrink-0 rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-on-warning">
          {STATUS_LABELS[status]}
        </span>
      );
    case "failed":
      return <span className="shrink-0 text-caption text-danger-ink">{STATUS_LABELS[status]}</span>;
    case "done":
      return <span className="shrink-0 text-caption text-ink-muted">{STATUS_LABELS[status]}</span>;
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

/** 时间分隔线：隔了一段时间才出现，居中的 footnote、ink-muted，两边 line 细线。 */
function TimeDivider({ at }: { at: number }) {
  return (
    <div role="separator" className="flex items-center gap-2 text-footnote text-ink-muted">
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
      <time dateTime={new Date(at).toISOString()}>{dividerTime(at)}</time>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * 只跑命令、读写文件的那几步（ToolCallCard）：surface-inset 底、radius-row，占满内容列，不加阴影。
 * 一步一张「在「mbpro」上跑了 npm test」，有输出的点开看；连着几步合成一组「在「mbpro」上做了 3 件事」，点开再看每一件。
 * 失败的默认展开。只能看，停止在输入栏。用过屏幕的那几步是上面的 ComputerCard。
 */
function ToolCallCard({ task, onToggle }: { task: ComputerTask; onToggle: (id: string) => void }) {
  const only = task.steps.length === 1 ? task.steps[0]! : null;
  const where = task.computer ? `在「${task.computer}」上` : "在电脑上";
  return (
    <div data-tool-card={task.computerId ?? ""} data-state={task.state} className="bg-surface-inset w-full overflow-hidden rounded-row">
      {only ? (
        <>
          <ToolHead
            icon={STEP_ICONS[only.icon]}
            title={only.title}
            result={<StepResult status={only.status} />}
            expanded={only.expanded}
            onToggle={only.output ? () => onToggle(`tool:${only.callId}`) : undefined}
          />
          {only.expanded && <ToolOutput step={only} />}
        </>
      ) : (
        <>
          <ToolHead
            icon={<TerminalIcon />}
            title={`${where}做了 ${task.steps.length} 件事`}
            result={<GroupResult task={task} />}
            expanded={task.expanded}
            onToggle={() => onToggle(task.id)}
          />
          {task.expanded && (
            <ol aria-label="每一件" className="flex flex-col pb-1">
              {task.steps.map((step) => (
                <li key={step.callId} className="flex flex-col">
                  <ToolHead
                    nested
                    icon={STEP_ICONS[step.icon]}
                    title={stepText(step)}
                    result={<StepResult status={step.status} />}
                    expanded={step.expanded}
                    onToggle={step.output ? () => onToggle(`tool:${step.callId}`) : undefined}
                  />
                  {step.expanded && <ToolOutput step={step} />}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

/** ToolCallCard 的一行：动作图标（ink-muted）、一句话（subheadline，截成一行）、结果、chevron（ink-faint，展开时转 90°）。 */
function ToolHead({
  icon,
  title,
  result,
  expanded,
  onToggle,
  nested = false
}: {
  icon: ReactNode;
  title: string;
  result: ReactNode;
  expanded: boolean;
  onToggle?: () => void;
  /** 组里的一件：上下收一点。 */
  nested?: boolean;
}) {
  const body = (
    <>
      <span className="shrink-0 text-[18px] text-ink-muted pointer-fine:text-[15px]">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left text-subheadline">{title}</span>
      {result}
      {onToggle && (
        <ChevronRightIcon
          className={`shrink-0 text-[14px] text-ink-faint transition-transform pointer-fine:text-[12px] ${expanded ? "rotate-90" : ""}`}
        />
      )}
    </>
  );
  const box = `flex w-full items-center gap-2 pr-3 pl-4 ${nested ? "py-2" : "py-3"}`;
  return onToggle ? (
    <button type="button" aria-expanded={expanded} onClick={onToggle} className={`${box} pointer-fine:hover:bg-line`}>
      {body}
    </button>
  ) : (
    <div className={box}>{body}</div>
  );
}

/** 展开后的输出：code 字、surface 底（嵌在卡片的 surface-inset 里），最多 12 行，超出在块里滚；最后写完整输出在哪。 */
function ToolOutput({ step }: { step: ToolStep }) {
  if (!step.output && !step.outputPath) return null;
  return (
    <div className="px-3 pb-3">
      {step.output && (
        <pre className="m-0 max-h-58 overflow-auto rounded-tag bg-surface px-3 py-2 font-mono text-code break-all whitespace-pre-wrap">
          {step.output}
        </pre>
      )}
      {step.outputPath && (
        <div className="mt-2 text-caption break-all text-ink-muted">
          完整输出：<span className="font-mono">{step.outputPath}</span>
        </div>
      )}
    </div>
  );
}

/** 一步的结果：成功不写字，失败 danger-ink，等批是 warning 小胶囊，进行中是小转圈。 */
function StepResult({ status }: { status: StepStatus }) {
  if (status === "running") return <Spinner size="sm" aria-label="在做" className="size-3.5 shrink-0" />;
  if (status === "waiting") return <WaitingMark />;
  const note = STEP_NOTES[status];
  if (!note) return null;
  return <span className={`shrink-0 text-caption ${status === "failed" ? "text-danger-ink" : "text-ink-muted"}`}>{note}</span>;
}

/** 一组的结果：还在做是转圈，等批是小胶囊，有没成的写几件没成。 */
function GroupResult({ task }: { task: ComputerTask }) {
  if (task.state === "live") return <Spinner size="sm" aria-label="在做" className="size-3.5 shrink-0" />;
  if (task.state === "waiting") return <WaitingMark />;
  if (!task.status) return null;
  const failed = task.steps.some((step) => step.status === "failed");
  return <span className={`shrink-0 text-caption ${failed ? "text-danger-ink" : "text-ink-muted"}`}>{task.status}</span>;
}

function WaitingMark() {
  return (
    <span className="shrink-0 rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-on-warning">等你批准</span>
  );
}

/**
 * 电脑任务卡（ComputerCard）：在哪台电脑上、状态；带回过截图就显示最近的画面，最新一步，点「步骤」看每一步。
 * 1pt line 外框、圆角 radius-row 加 2，不填底、不加阴影。iOS 的 ComputerCardCell 是同一个样子，两边一起改。
 * 「接手」是打开远程桌面，只给主人自己在线的电脑，网页上先按通行密钥，电脑 App 里交给浏览器，见 RemoteDesktop.tsx。
 */
function ComputerCard({ task, onToggle }: { task: ComputerTask; onToggle: (id: string) => void }) {
  const active = task.state === "live" || task.state === "waiting";
  const remote = useRemoteDesktop(task.computerId);
  return (
    <div
      data-computer-card={task.computerId ?? ""}
      data-state={task.state}
      className="rounded-row-outer flex w-full max-w-[420px] flex-col overflow-hidden inset-ring inset-ring-line"
    >
      <div className="flex items-center gap-2 px-3.5 pt-[11px] pb-[9px]">
        <ComputerIcon className="shrink-0 text-[17px] pointer-fine:text-[15px]" />
        <span className="min-w-0 flex-1 truncate text-subheadline font-semibold">
          {task.computer ? `在「${task.computer}」上` : "在电脑上"}
        </span>
        <ComputerStatus task={task} />
      </div>
      {task.screen && (
        <div className="rounded-row-inner relative mx-3.5 h-35 overflow-hidden bg-surface-inset">
          <img
            src={`data:${task.screen.mimeType};base64,${task.screen.data}`}
            alt={`「${task.computer ?? "电脑"}」上的画面`}
            className={`size-full object-cover object-top ${active ? "" : "opacity-90"}`}
          />
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] inset-ring inset-ring-line" />
        </div>
      )}
      <div className="flex items-center gap-2 pt-2.5 pr-2.5 pb-3 pl-3.5">
        <span className="min-w-0 flex-1 truncate text-footnote text-ink-muted">{task.latest}</span>
        <button
          type="button"
          aria-expanded={task.expanded}
          onClick={() => onToggle(task.id)}
          className={`${CARD_PILL} gap-1`}
        >
          步骤
          <ChevronDownIcon className={`text-[11px] ${task.expanded ? "rotate-180" : ""}`} />
        </button>
        {remote && remote !== "phone" && task.computerId && (
          <button type="button" onClick={() => openRemoteDesktop(task.computerId!, remote)} className={CARD_PILL}>
            接手
          </button>
        )}
      </div>
      {task.expanded && (
        <ol aria-label="步骤" className="flex flex-col gap-0.5 px-2 pb-2.5">
          {task.steps.map((step) => (
            <StepLine key={step.callId} step={step} onToggle={() => onToggle(`tool:${step.callId}`)} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** 电脑卡底行的「步骤」「接手」：surface-inset 胶囊，高 32，字 14 加粗；电脑上小一号。 */
const CARD_PILL =
  "bg-surface-inset tap flex h-8 shrink-0 items-center rounded-full px-[13px] text-[14px] font-semibold pointer-fine:h-7 pointer-fine:px-3 pointer-fine:text-footnote";

function ComputerStatus({ task }: { task: ComputerTask }) {
  switch (task.state) {
    case "live":
      return (
        <span className="flex shrink-0 items-center gap-1.5 text-footnote text-ink-muted">
          <Spinner size="sm" aria-hidden="true" className="size-3.5" />
          {task.status}
        </span>
      );
    case "waiting":
      return (
        <span className="shrink-0 rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-on-warning">
          {task.status}
        </span>
      );
    case "failed":
      return <span className="shrink-0 text-footnote text-danger-ink">{task.status}</span>;
    default:
      return <span className="shrink-0 text-footnote text-ink-muted">{task.status}</span>;
  }
}

/** 一步后面那一行小字。做完了和正在做靠左边的勾和转圈说明，不再写字。 */
const STEP_NOTES: Record<StepStatus, string | null> = {
  running: null,
  done: null,
  waiting: "等你批准",
  failed: "失败",
  denied: "已拒绝",
  expired: "没人批，作废了",
  unfinished: "没做完"
};

/** 每一步左边的记号：做完的 online 勾，正在做的转圈，等批的 warning 点，失败的 danger-ink 叉。 */
function StepMark({ status }: { status: StepStatus }) {
  return (
    <span aria-hidden="true" className="flex h-(--text-subheadline--line-height) w-4 shrink-0 items-center justify-center">
      {status === "done" ? (
        <CheckIcon className="text-[14px] text-online pointer-fine:text-[12px]" />
      ) : status === "running" ? (
        <Spinner size="sm" className="size-3.5" />
      ) : status === "failed" ? (
        <CloseIcon className="text-[12px] text-danger-ink pointer-fine:text-[11px]" />
      ) : (
        <span className={`size-2 rounded-full ${status === "waiting" ? "bg-warning" : "bg-offline"}`} />
      )}
    </span>
  );
}

/** 卡片里的一步（StepLine）：记号、subheadline 的一句话，下一行 caption 写时间，没做成的跟上原因；有输出的点开看。 */
function StepLine({ step, onToggle }: { step: ToolStep; onToggle: () => void }) {
  const note = STEP_NOTES[step.status];
  const time = step.at > 0 ? clockTime(step.at) : null;
  const header = (
    <>
      <StepMark status={step.status} />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span className="text-subheadline break-words">{stepText(step)}</span>
        {(time || note) && (
          <span className="text-caption text-ink-muted">
            {time}
            {time && note && " · "}
            {note && <span className={step.status === "failed" ? "text-danger-ink" : ""}>{note}</span>}
          </span>
        )}
      </span>
    </>
  );
  return (
    <li className="flex flex-col">
      {step.output ? (
        <button
          type="button"
          aria-expanded={step.expanded}
          onClick={onToggle}
          className="flex w-full items-start gap-2.5 rounded-tag px-1.5 py-1 pointer-fine:hover:bg-surface-inset"
        >
          {header}
        </button>
      ) : (
        <div className="flex items-start gap-2.5 px-1.5 py-1">{header}</div>
      )}
      {step.expanded && step.output && (
        <pre className="mx-1.5 mt-0.5 mb-1 max-h-58 overflow-auto rounded-tag bg-surface-inset px-3 py-2 font-mono text-code break-all whitespace-pre-wrap">
          {step.output}
        </pre>
      )}
      {step.expanded && step.outputPath && (
        <div className="mx-1.5 mb-1 text-caption break-all text-ink-muted">
          完整输出在 <span className="font-mono">{step.outputPath}</span>
        </div>
      )}
    </li>
  );
}
