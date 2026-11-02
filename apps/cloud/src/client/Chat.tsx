import { Button, Dropdown, Label } from "@heroui/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { Streamdown } from "streamdown";
import { parseHandoff, parseQuote, quotedMessage } from "../messages";
import type { Project } from "../projects";
import type { TranscriptMessage, TranscriptPart } from "../protocol";
import {
  ArrowUpIcon,
  CloseIcon,
  CopyIcon,
  FolderIcon,
  ReplyIcon,
  StopIcon
} from "./icons";
import { usePiSession } from "./use-pi-session";

/** 对话里要用到的项目数据和动作。 */
export type ChatContext = {
  readonly projects: ReadonlyMap<string, Project>;
  /** 只有聊天里才在回复上方画项目标签；项目会话里不建也不转交项目。 */
  readonly projectTags: boolean;
  readonly onOpenProject: (projectId: string) => void;
  readonly onProjectsChanged: () => void;
};

type ChatProps = {
  readonly session: string;
  readonly context: ChatContext;
  /** 固定在对话顶上的东西，比如项目名。 */
  readonly top?: ReactNode;
  readonly empty: ReactNode;
  readonly placeholder: string;
  readonly starters?: readonly string[];
};

const coarsePointer =
  typeof window !== "undefined" &&
  window.matchMedia("(pointer: coarse)").matches;

export function Chat({
  session,
  context,
  top,
  empty,
  placeholder,
  starters = []
}: ChatProps) {
  const pi = usePiSession(session, context.onProjectsChanged);
  const [draft, setDraft] = useState("");
  const [quote, setQuote] = useState<string | null>(null);
  /** 长按或右键的那条消息的文字；菜单挂在 menuAnchor 上。 */
  const [menuText, setMenuText] = useState<string | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);

  const messages = pi.messages.filter(isVisible);
  const live = pi.live && isVisible(pi.live) ? pi.live : null;
  const thinking = pi.running && !hasText(live);

  // 在底部时跟着新内容往下滚；用户往上翻了就不打扰。
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [messages.length, live, thinking]);

  useEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
    node.style.overflowY = node.scrollHeight > 160 ? "auto" : "hidden";
  }, [draft]);

  function send(text = draft) {
    const value = text.trim();
    if (!value) return;
    const message = quote ? quotedMessage(quote, value) : value;
    if (pi.submit(message)) {
      setDraft("");
      setQuote(null);
      stick.current = true;
    }
  }

  function openMenu(anchor: HTMLElement, text: string) {
    menuAnchor.current = anchor;
    setMenuText(text);
  }

  function onMenuAction(key: string) {
    if (menuText === null) return;
    if (key === "copy") void navigator.clipboard?.writeText(menuText);
    if (key === "reply") {
      setQuote(menuText);
      input.current?.focus();
    }
    setMenuText(null);
  }

  const isEmpty = messages.length === 0 && !live && !pi.running;
  const canSend = Boolean(draft.trim()) && pi.status === "open";

  return (
    <div className="relative flex h-full flex-col">
      {top && (
        <div className="relative z-10 flex shrink-0 justify-center px-4 pb-2">{top}</div>
      )}
      <div
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          stick.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-3 px-4 pt-2 pb-4">
          {isEmpty ? (
            <div className="my-auto flex flex-col items-center gap-5 py-10">
              {empty}
              {starters.length > 0 && (
                <div className="flex flex-wrap justify-center gap-2">
                  {starters.map((starter) => (
                    <button
                      key={starter}
                      type="button"
                      onClick={() => send(starter)}
                      className="glass rounded-full px-3.5 py-1.5 text-sm"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          {messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              context={context}
              onMenu={openMenu}
            />
          ))}
          {live && <Message message={live} context={context} onMenu={openMenu} />}
          {thinking && (
            <div className="flex items-center gap-2 px-1 text-sm text-(--on-sky)">
              <span className="inline-flex gap-1">
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </span>
              {pi.retry ? "模型忙，正在重试…" : "Pupu 在想…"}
            </div>
          )}
          {pi.error && (
            <div className="glass-strong rounded-2xl px-4 py-2.5 text-sm text-danger">
              出错了：{pi.error}
            </div>
          )}
        </div>
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
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-3">
          {quote !== null && (
            <div className="flex items-start gap-2">
              <div className="glass-strong bubble max-w-[85%] rounded-3xl px-4 py-2.5 text-[15px] leading-6">
                <div className="line-clamp-4 whitespace-pre-wrap">{quote}</div>
              </div>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="取消回复"
                onPress={() => setQuote(null)}
                className="glass rounded-full"
              >
                <CloseIcon />
              </Button>
            </div>
          )}
          {pi.status !== "open" && (
            <div className="text-center text-xs text-(--on-sky)">
              {pi.status === "connecting" ? "正在连接 Pupu…" : "连接断开，正在重连…"}
            </div>
          )}
          {pi.queued > 0 && (
            <div className="text-center text-xs text-(--on-sky)">
              还有 {pi.queued} 条消息排着队，Pupu 说完这轮就处理
            </div>
          )}
          <form
            className="glass-strong bubble flex items-end gap-2 rounded-[26px] py-1.5 pr-1.5 pl-4"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <textarea
              ref={input}
              value={draft}
              rows={1}
              placeholder={quote !== null ? "回复消息" : placeholder}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && quote !== null) {
                  setQuote(null);
                  return;
                }
                // 手机上回车换行、点按钮发送；电脑上回车发送，Shift+回车换行。输入法选词时不发送。
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !coarsePointer &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  send();
                }
              }}
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-6 text-foreground outline-none placeholder:text-muted"
            />
            {pi.running && !draft.trim() ? (
              <Button
                isIconOnly
                aria-label="停止"
                onPress={() => pi.abort()}
                className="size-9 min-w-9 rounded-full bg-foreground text-background"
              >
                <StopIcon />
              </Button>
            ) : (
              <Button
                isIconOnly
                type="submit"
                aria-label={pi.running ? "排队发送" : "发送"}
                isDisabled={!canSend}
                className="size-9 min-w-9 rounded-full bg-foreground text-base text-background"
              >
                <ArrowUpIcon />
              </Button>
            )}
          </form>
        </div>
      </div>

      <Dropdown
        isOpen={menuText !== null}
        onOpenChange={(open) => {
          if (!open) setMenuText(null);
        }}
      >
        <Dropdown.Popover triggerRef={menuAnchor} placement="bottom">
          <Dropdown.Menu
            aria-label="消息操作"
            onAction={(key) => onMenuAction(String(key))}
          >
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

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="size-1.5 animate-pulse rounded-full bg-current"
      style={{ animationDelay: delay }}
    />
  );
}

function hasText(message: TranscriptMessage | null): boolean {
  return Boolean(
    message?.parts.some((part) => part.type === "text" && part.text.trim())
  );
}

function textOf(message: TranscriptMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/** 工具结果和系统记录不单独显示：项目标签已经在工具调用那里画出来了。 */
function isVisible(message: TranscriptMessage): boolean {
  if (message.role === "tool") return false;
  if (message.role === "notice") return message.parts.length > 0;
  // 思考过程不显示，跟聊天软件一样只看回复；只有思考的那条整条不出现。
  if (message.role === "assistant") {
    return (
      Boolean(message.error) ||
      message.parts.some((part) => part.type === "tool-call" || (part.type === "text" && part.text.trim()))
    );
  }
  return true;
}

/** 手机上长按、电脑上右键，都打开消息菜单。 */
function usePressMenu(onMenu: (anchor: HTMLElement) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  }

  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerType === "mouse") return;
      const target = event.currentTarget;
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        cancel();
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
      onMenu(event.currentTarget);
    }
  };
}

type MenuOpener = (anchor: HTMLElement, text: string) => void;

function Message({
  message,
  context,
  onMenu
}: {
  message: TranscriptMessage;
  context: ChatContext;
  onMenu: MenuOpener;
}) {
  if (message.role === "user") {
    const text = textOf(message);
    const task = parseHandoff(text);
    if (task !== null) return <Handoff task={task} />;
    return <UserMessage text={text} onMenu={onMenu} />;
  }
  if (message.role === "notice") {
    return (
      <div className="text-center text-xs text-(--on-sky)">
        {message.parts.map((part) => (part.type === "text" ? part.text : "")).join(" ")}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      {message.parts.map((part, index) => (
        <Part key={index} part={part} context={context} onMenu={onMenu} />
      ))}
      {message.error && (
        <div className="glass-strong rounded-2xl px-4 py-2 text-sm text-danger">
          模型出错：{message.error}
        </div>
      )}
    </div>
  );
}

function UserMessage({ text, onMenu }: { text: string; onMenu: MenuOpener }) {
  const { quote, body } = parseQuote(text);
  const press = usePressMenu((anchor) => onMenu(anchor, body));
  return (
    <div className="flex flex-col items-end gap-1">
      {quote && (
        <div className="line-clamp-2 max-w-[75%] border-r-2 border-(--on-sky) pr-2 text-right text-[13px] leading-5 text-(--on-sky)">
          {quote}
        </div>
      )}
      <div
        {...press}
        className="pressable max-w-[85%] rounded-3xl bg-(--bubble-user) px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap backdrop-blur-xl"
      >
        {body}
      </div>
    </div>
  );
}

/** 项目会话里，从聊天转过来的事。 */
function Handoff({ task }: { task: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-1">
      <div className="text-xs text-(--on-sky)">从聊天转来</div>
      <div className="glass max-w-[85%] rounded-2xl px-4 py-2 text-[13px] leading-5 whitespace-pre-wrap text-muted">
        {task}
      </div>
    </div>
  );
}

function Part({
  part,
  context,
  onMenu
}: {
  part: TranscriptPart;
  context: ChatContext;
  onMenu: MenuOpener;
}) {
  switch (part.type) {
    case "text":
      return part.text.trim() ? (
        <AssistantText text={part.text} onMenu={onMenu} />
      ) : null;
    case "tool-call":
      return <ToolCall part={part} context={context} />;
    default:
      return null;
  }
}

function AssistantText({ text, onMenu }: { text: string; onMenu: MenuOpener }) {
  const press = usePressMenu((anchor) => onMenu(anchor, text));
  return (
    <div
      {...press}
      className="pressable glass-strong bubble max-w-[85%] rounded-3xl px-4 py-2.5"
    >
      <Streamdown className="sd-theme text-[15px] leading-6" controls={false}>
        {text}
      </Streamdown>
    </div>
  );
}

type ToolCallPart = Extract<TranscriptPart, { type: "tool-call" }>;

/** 建项目、转交项目画成项目标签；其余工具调用不显示。 */
function ToolCall({ part, context }: { part: ToolCallPart; context: ChatContext }) {
  if (!context.projectTags) return null;
  const args = (part.arguments ?? {}) as Record<string, unknown>;
  if (part.name === "create_project") {
    const name = String(args.name ?? "");
    const project = [...context.projects.values()].find(
      (candidate) => candidate.name === name
    );
    return <ProjectTag name={name} project={project} context={context} />;
  }
  if (part.name === "hand_off_to_project") {
    const project = context.projects.get(String(args.project_id ?? ""));
    if (!project) return null;
    return <ProjectTag name={project.name} project={project} context={context} />;
  }
  return null;
}

/** 回复上方的项目标签：这件事交给了哪个项目，点一下过去。 */
function ProjectTag({
  name,
  project,
  context
}: {
  name: string;
  project: Project | undefined;
  context: ChatContext;
}) {
  return (
    <button
      type="button"
      disabled={!project}
      onClick={() => project && context.onOpenProject(project.id)}
      className="glass-strong bubble flex items-center gap-2 rounded-xl px-3 py-1.5 text-[13px] font-medium"
    >
      <FolderIcon className="text-[15px]" />
      {name}
    </button>
  );
}
