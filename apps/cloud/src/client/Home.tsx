import type { ReactNode } from "react";
import type { Project } from "../projects";
import { ComputerIcon, FolderIcon } from "./icons";

function ago(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 主页：一眼看到 Pupu 手上的事。现在只有项目和电脑两块面板，
 * 以后由对话生成更多面板。
 */
export function Home({
  projects,
  onOpenProject
}: {
  projects: readonly Project[];
  onOpenProject: (id: string) => void;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="pb-safe mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 pt-2 pb-8">
        <Panel icon={<FolderIcon />} title="项目">
          {projects.length === 0 ? (
            <div className="text-sm text-muted">
              还没有项目。在聊天里说要做的事，Pupu 会问你要不要建一个。
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {projects.slice(0, 6).map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => onOpenProject(project.id)}
                  className="flex items-center gap-3 rounded-2xl bg-(--glass-strong) px-4 py-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{project.name}</div>
                    {project.goal && (
                      <div className="truncate text-sm text-muted">
                        {project.goal}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-xs text-muted">
                    {ago(project.updatedAt)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Panel>
        <Panel icon={<ComputerIcon />} title="电脑">
          <div className="text-sm leading-6 text-muted">
            还没有连上电脑。连上之后，这里会显示每台电脑在不在线、Pupu 正在上面做什么。
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Panel({
  icon,
  title,
  children
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="glass bubble flex flex-col gap-3 rounded-[28px] p-4">
      <div className="flex items-center gap-2 text-[15px] font-medium">
        <span className="text-lg">{icon}</span>
        {title}
      </div>
      {children}
    </section>
  );
}
