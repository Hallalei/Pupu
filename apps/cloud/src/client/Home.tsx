import { useState, type ReactNode } from "react";
import type { ComputerView } from "../bridge/protocol";
import type { Project } from "../projects";
import { Composer } from "./Composer";
import { ChevronRightIcon, ComputerIcon, FolderIcon } from "./icons";

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
 * 主页：一眼看到 Pupu 手上的事。现在有项目和电脑两块面板；
 * 「正在做」等云端报上电脑在做什么再加，对话生成的面板接在后面。
 * 底下的输入栏发的话进聊天。
 */
export function Home({
  projects,
  computers,
  onOpenProject,
  onOpenAllProjects,
  onOpenSettings,
  onSend
}: {
  projects: readonly Project[];
  computers: readonly ComputerView[];
  onOpenProject: (id: string) => void;
  onOpenAllProjects: () => void;
  onOpenSettings: () => void;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");

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
                    detail={project.goal || null}
                    trailing={ago(project.updatedAt)}
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

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="soft bubble flex flex-col gap-3 rounded-panel p-4">
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
  trailing?: string;
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
      {trailing && <span className="shrink-0 text-caption text-muted">{trailing}</span>}
    </button>
  );
}
