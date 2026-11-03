import { Button, Spinner } from "@heroui/react";
import { useState, type ReactNode } from "react";
import type { ComputerActivity } from "../bridge/activity";
import type { ComputerView } from "../bridge/protocol";
import type { Project } from "../projects";
import { Composer } from "./Composer";
import { ChevronRightIcon, ComputerIcon, FolderIcon, PulseIcon } from "./icons";

/** 主页上最多列这么多个项目，其余的在项目列表里。 */
const HOME_PROJECTS = 5;

export function ago(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 主页：一眼看到 Pupu 手上的事。最上面「正在做」，下面是项目和电脑；对话生成的面板以后接在后面。
 * 底下的输入栏发的话进聊天。
 */
export function Home({
  projects,
  computers,
  activity,
  onOpenProject,
  onOpenChat,
  onOpenAllProjects,
  onOpenSettings,
  onTakeback,
  onSend
}: {
  projects: readonly Project[];
  computers: readonly ComputerView[];
  activity: readonly ComputerActivity[];
  onOpenProject: (id: string) => void;
  onOpenChat: () => void;
  onOpenAllProjects: () => void;
  onOpenSettings: () => void;
  onTakeback: (computerId: string) => Promise<void>;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const busy = activity.filter(isBusy);
  /** 停在哪些项目里等你批。一台电脑只带得出最早那条请示的项目。 */
  const waiting = new Set(
    activity.flatMap((row) => (row.state === "waiting" && row.project ? [row.project.id] : []))
  );

  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onSend(text);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-2xl grid-cols-1 items-start gap-3 px-4 pt-2 pb-8 lg:max-w-240 lg:grid-cols-2 lg:px-6">
          <Panel icon={<PulseIcon />} title="正在做" className="lg:col-span-2">
            {busy.length === 0 ? (
              <p className="text-subheadline text-muted">Pupu 手上没有在跑的事。</p>
            ) : (
              <Rows>
                {busy.map((row) => (
                  <ActivityRow
                    key={row.computerId}
                    activity={row}
                    onOpen={() => (row.project ? onOpenProject(row.project.id) : onOpenChat())}
                    onTakeback={() => onTakeback(row.computerId)}
                  />
                ))}
              </Rows>
            )}
          </Panel>
          <Panel icon={<FolderIcon />} title="项目">
            {projects.length === 0 ? (
              <p className="text-subheadline text-muted">
                还没有项目。在聊天里说要做的事，Pupu 会问你要不要建一个。
              </p>
            ) : (
              <Rows>
                {projects.slice(0, HOME_PROJECTS).map((project) => (
                  <Row
                    key={project.id}
                    title={project.name}
                    detail={project.progress || project.goal || null}
                    trailing={waiting.has(project.id) ? <WaitingChip /> : ago(project.updatedAt)}
                    onPress={() => onOpenProject(project.id)}
                  />
                ))}
                {projects.length > HOME_PROJECTS && (
                  <button
                    type="button"
                    onClick={onOpenAllProjects}
                    className="flex h-11 items-center justify-between px-4 text-left text-subheadline font-medium pointer-fine:h-8 pointer-fine:px-3 lg:hidden"
                  >
                    全部 {projects.length} 个项目
                    <ChevronRightIcon className="text-[16px] text-muted" />
                  </button>
                )}
              </Rows>
            )}
          </Panel>
          <Panel icon={<ComputerIcon />} title="电脑">
            {computers.length === 0 ? (
              <p className="text-subheadline text-muted">
                还没有授权的电脑。在电脑上配对桥之后，这里会显示它在不在线。
              </p>
            ) : (
              <Rows>
                {computers.map((computer) => (
                  <Row
                    key={computer.id}
                    leading={
                      <span
                        className={`size-2 shrink-0 rounded-full ${computer.online ? "bg-online" : "bg-offline"}`}
                        aria-hidden="true"
                      />
                    }
                    title={computer.name}
                    detail={computerLabel(computer) + (computer.screen ? " · 屏幕已授权" : "")}
                    onPress={onOpenSettings}
                  />
                ))}
              </Rows>
            )}
          </Panel>
        </div>
      </div>
      <div className="pb-safe shrink-0">
        <div className="mx-auto w-full max-w-2xl px-4 pb-3 lg:px-6">
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={send}
            placeholder="给 Pupu 发消息"
            canSend={Boolean(draft.trim())}
          />
        </div>
      </div>
    </div>
  );
}

export function computerLabel(computer: ComputerView): string {
  if (computer.online) return "在线";
  if (computer.stale) return "心跳中断";
  if (computer.lastSeenAt) return `离线 · ${ago(computer.lastSeenAt)}`;
  return "离线";
}

/** 「正在做」里列哪些电脑：在做事的、停着等批的，还有闲着但屏幕控制没收回的。 */
function isBusy(row: ComputerActivity): boolean {
  if (row.state === "working" || row.state === "waiting") return true;
  return row.state === "idle" && row.screen;
}

function WaitingChip() {
  return (
    <span className="shrink-0 rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-warning-foreground">
      等你批准
    </span>
  );
}

/**
 * 「正在做」的一行：在做什么，第二行是哪台电脑、哪个项目、做了多久。点开去那个项目，主对话里的去聊天。
 * 屏幕控制还在时右边带「收回」。
 */
function ActivityRow({
  activity,
  onOpen,
  onTakeback
}: {
  activity: ComputerActivity;
  onOpen: () => void;
  onTakeback: () => Promise<void>;
}) {
  const [takingBack, setTakingBack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detail = [activity.computerName, activity.project?.name, activity.since ? ago(activity.since) : null]
    .filter(Boolean)
    .join(" · ");

  async function takeback() {
    setTakingBack(true);
    setError(null);
    try {
      await onTakeback();
    } catch (cause) {
      setError(`没收回：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setTakingBack(false);
    }
  }

  return (
    <div className="strong flex items-center gap-3 rounded-row px-4 py-3 pointer-fine:px-3 pointer-fine:py-2">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        {activity.state === "working" ? (
          <Spinner size="sm" aria-label="在做" className="shrink-0" />
        ) : activity.state === "waiting" ? (
          <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />
        ) : (
          <span className="size-2 shrink-0 rounded-full bg-online" aria-hidden="true" />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-headline">{activity.doing ?? "闲着，屏幕控制还开着"}</span>
          <span className={`truncate text-subheadline ${error ? "text-danger-ink" : "text-muted"}`}>
            {error ?? detail}
          </span>
        </span>
        {activity.state === "waiting" && <WaitingChip />}
      </button>
      {activity.screen && (
        <Button size="sm" variant="secondary" isPending={takingBack} onPress={() => void takeback()}>
          收回
        </Button>
      )}
    </div>
  );
}

function Panel({
  icon,
  title,
  className = "",
  children
}: {
  icon: ReactNode;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`soft bubble flex flex-col gap-3 rounded-panel p-4 ${className}`}>
      <h2 className="m-0 flex items-center gap-2 text-headline">
        <span className="text-[18px] pointer-fine:text-[16px]">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 pointer-fine:gap-1.5">{children}</div>;
}

/** 面板里的一行：名字、第二行、右边的时间。两行字时手机上高 68，电脑上高 56。 */
function Row({
  leading,
  title,
  detail,
  trailing,
  onPress
}: {
  leading?: ReactNode;
  title: string;
  detail: string | null;
  trailing?: ReactNode;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="strong flex items-center gap-3 rounded-row px-4 py-3 text-left pointer-fine:px-3 pointer-fine:py-2"
    >
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-headline">{title}</span>
        {detail && <span className="truncate text-subheadline text-muted">{detail}</span>}
      </span>
      {typeof trailing === "string" ? (
        <span className="shrink-0 text-caption text-muted">{trailing}</span>
      ) : (
        trailing
      )}
    </button>
  );
}
