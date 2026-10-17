import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { Project, Proposal } from "../projects";
import type { TranscriptMessage, TranscriptPart } from "../protocol";
import { usePiSession } from "./use-pi-session";

/** 对话里卡片要用到的项目数据和动作。 */
export type CardContext = {
  readonly projects: ReadonlyMap<string, Project>;
  readonly proposals: ReadonlyMap<string, Proposal>;
  readonly onAccept: (proposalId: string) => Promise<void>;
  readonly onDismiss: (proposalId: string) => Promise<void>;
  readonly onOpenProject: (projectId: string) => void;
  readonly onProjectsChanged: () => void;
};

type ChatProps = {
  readonly session: string;
  readonly cards: CardContext;
  /** 会话顶部的说明，比如项目目标。 */
  readonly header?: ReactNode;
  readonly empty: ReactNode;
  readonly placeholder: string;
  readonly starters?: readonly string[];
};

const coarsePointer =
  typeof window !== "undefined" &&
  window.matchMedia("(pointer: coarse)").matches;

export function Chat({
  session,
  cards,
  header,
  empty,
  placeholder,
  starters = []
}: ChatProps) {
  const pi = usePiSession(session, cards.onProjectsChanged);
  const [draft, setDraft] = useState("");
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
    if (pi.submit(value)) {
      setDraft("");
      stick.current = true;
    }
  }

  const empty_ = messages.length === 0 && !live && !pi.running;

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          stick.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-4 pb-6">
          {header}
          {empty_ ? (
            <div className="flex flex-col gap-3 py-8">
              {empty}
              {starters.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-2">
                  {starters.map((starter) => (
                    <button
                      key={starter}
                      type="button"
                      onClick={() => send(starter)}
                      className="rounded-full border border-(--border) bg-(--surface) px-3 py-1.5 text-sm text-(--fg) active:bg-(--sunken)"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          {messages.map((message) => (
            <Message key={message.id} message={message} cards={cards} />
          ))}
          {live && <Message message={live} cards={cards} />}
          {thinking && (
            <div className="flex items-center gap-2 text-sm text-(--muted)">
              <span className="inline-flex gap-1">
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </span>
              {pi.retry ? "模型忙，正在重试…" : "Pupu 在想…"}
            </div>
          )}
          {pi.error && (
            <div className="rounded-lg border border-(--danger)/30 px-3 py-2 text-sm text-(--danger)">
              出错了：{pi.error}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-(--border) bg-(--bg)">
        {pi.status !== "open" && (
          <div className="px-4 pt-2 text-center text-xs text-(--muted)">
            {pi.status === "connecting" ? "正在连接 Pupu…" : "连接断开，正在重连…"}
          </div>
        )}
        <form
          className="mx-auto flex w-full max-w-2xl items-end gap-2 px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <textarea
            ref={input}
            value={draft}
            rows={1}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
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
            className="max-h-40 min-h-11 flex-1 resize-none rounded-2xl border border-(--border) bg-(--surface) px-4 py-2.5 text-[16px] leading-6 text-(--fg) outline-none placeholder:text-(--muted) focus:border-(--accent)"
          />
          {pi.running && !draft.trim() ? (
            <button
              type="button"
              onClick={() => pi.abort()}
              className="h-11 shrink-0 rounded-full border border-(--border) bg-(--surface) px-4 text-sm text-(--fg) active:bg-(--sunken)"
            >
              停止
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim() || pi.status !== "open"}
              className="h-11 shrink-0 rounded-full bg-(--accent) px-4 text-sm font-medium text-(--accent-fg) disabled:opacity-40"
            >
              {pi.running ? "排队" : "发送"}
            </button>
          )}
        </form>
        {pi.queued > 0 && (
          <div className="pb-2 text-center text-xs text-(--muted)">
            还有 {pi.queued} 条消息排着队，Pupu 说完这轮就处理
          </div>
        )}
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="size-1.5 animate-pulse rounded-full bg-(--muted)"
      style={{ animationDelay: delay }}
    />
  );
}

function hasText(message: TranscriptMessage | null): boolean {
  return Boolean(
    message?.parts.some((part) => part.type === "text" && part.text.trim())
  );
}

/** 工具结果和系统记录不单独显示：卡片已经在工具调用那里画出来了。 */
function isVisible(message: TranscriptMessage): boolean {
  if (message.role === "tool") return false;
  if (message.role === "notice") return message.parts.length > 0;
  return true;
}

function Message({
  message,
  cards
}: {
  message: TranscriptMessage;
  cards: CardContext;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-(--fg) px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-(--bg)">
          {message.parts.map((part, index) =>
            part.type === "text" ? <span key={index}>{part.text}</span> : null
          )}
        </div>
      </div>
    );
  }
  if (message.role === "notice") {
    return (
      <div className="text-center text-xs text-(--muted)">
        {message.parts.map((part) => (part.type === "text" ? part.text : "")).join(" ")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, index) => (
        <Part key={index} part={part} cards={cards} />
      ))}
      {message.error && (
        <div className="text-sm text-(--danger)">模型出错：{message.error}</div>
      )}
    </div>
  );
}

function Part({ part, cards }: { part: TranscriptPart; cards: CardContext }) {
  switch (part.type) {
    case "text":
      return part.text.trim() ? (
        <Streamdown className="sd-theme text-[15px] leading-7" controls={false}>
          {part.text}
        </Streamdown>
      ) : null;
    case "thinking":
      return part.text.trim() ? (
        <details className="text-sm text-(--muted)">
          <summary className="cursor-pointer select-none">思考过程</summary>
          <div className="mt-1 border-l-2 border-(--border) pl-3 whitespace-pre-wrap">
            {part.text}
          </div>
        </details>
      ) : null;
    case "tool-call":
      return <ToolCall part={part} cards={cards} />;
    default:
      return null;
  }
}

type ToolCallPart = Extract<TranscriptPart, { type: "tool-call" }>;

function ToolCall({ part, cards }: { part: ToolCallPart; cards: CardContext }) {
  const args = (part.arguments ?? {}) as Record<string, unknown>;
  if (part.name === "propose_project") {
    return (
      <ProposalCard
        id={part.id}
        name={String(args.name ?? "")}
        goal={String(args.goal ?? "")}
        cards={cards}
      />
    );
  }
  if (part.name === "suggest_existing_project") {
    const project = cards.projects.get(String(args.project_id ?? ""));
    if (!project) return null;
    return (
      <Card label="这件事属于已有项目">
        <div className="font-medium">{project.name}</div>
        {args.reason ? (
          <div className="text-sm text-(--muted)">{String(args.reason)}</div>
        ) : null}
        <div className="pt-1">
          <PrimaryButton onClick={() => cards.onOpenProject(project.id)}>
            去「{project.name}」里聊
          </PrimaryButton>
        </div>
      </Card>
    );
  }
  if (part.name === "list_projects") {
    return <Chip>看了一眼项目列表</Chip>;
  }
  return <Chip>用了工具 {part.name}</Chip>;
}

function ProposalCard({
  id,
  name,
  goal,
  cards
}: {
  id: string;
  name: string;
  goal: string;
  cards: CardContext;
}) {
  const proposal = cards.proposals.get(id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card label="建议新建项目">
      <div className="font-medium">{name || "（未命名）"}</div>
      {goal && <div className="text-sm text-(--muted)">{goal}</div>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {!proposal || proposal.status === "pending" ? (
          <>
            <PrimaryButton
              disabled={!proposal || busy}
              onClick={() => run(() => cards.onAccept(id))}
            >
              {busy ? "正在建立…" : "建立项目"}
            </PrimaryButton>
            <button
              type="button"
              disabled={!proposal || busy}
              onClick={() => run(() => cards.onDismiss(id))}
              className="rounded-full px-3 py-1.5 text-sm text-(--muted) disabled:opacity-40"
            >
              先不用
            </button>
          </>
        ) : proposal.status === "accepted" ? (
          <>
            <span className="text-sm text-(--accent)">已建立</span>
            {proposal.projectId && (
              <PrimaryButton onClick={() => cards.onOpenProject(proposal.projectId!)}>
                打开项目
              </PrimaryButton>
            )}
          </>
        ) : (
          <span className="text-sm text-(--muted)">已忽略</span>
        )}
      </div>
      {error && <div className="text-sm text-(--danger)">{error}</div>}
    </Card>
  );
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-(--border) bg-(--surface) px-4 py-3">
      <div className="text-xs text-(--accent)">{label}</div>
      {children}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <div className="self-start rounded-full bg-(--sunken) px-2.5 py-1 text-xs text-(--muted)">
      {children}
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-full bg-(--accent) px-3.5 py-1.5 text-sm font-medium text-(--accent-fg) disabled:opacity-40"
    >
      {children}
    </button>
  );
}
