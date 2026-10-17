import { useState } from "react";
import type { Project, Proposal } from "../projects";
import { PrimaryButton } from "./Chat";

type ProjectsProps = {
  readonly projects: readonly Project[];
  readonly proposals: readonly Proposal[];
  readonly onOpen: (projectId: string) => void;
  readonly onCreate: (name: string, goal: string) => Promise<void>;
  readonly onAccept: (proposalId: string) => Promise<void>;
  readonly onDismiss: (proposalId: string) => Promise<void>;
};

function ago(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function Projects({
  projects,
  proposals,
  onOpen,
  onCreate,
  onAccept,
  onDismiss
}: ProjectsProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = proposals.filter((proposal) => proposal.status === "pending");

  async function create() {
    if (!name.trim()) {
      setError("先给项目起个名字");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim(), goal.trim());
      setName("");
      setGoal("");
      setCreating(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">项目</h1>
          {!creating && (
            <PrimaryButton onClick={() => setCreating(true)}>新建项目</PrimaryButton>
          )}
        </div>

        {creating && (
          <div className="flex flex-col gap-3 rounded-xl border border-(--border) bg-(--surface) p-4">
            <input
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder="项目名，比如「登录改版」"
              className="rounded-lg border border-(--border) bg-(--bg) px-3 py-2 text-[16px] outline-none focus:border-(--accent)"
            />
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={2}
              placeholder="一句话说明要达成什么（可选）"
              className="resize-none rounded-lg border border-(--border) bg-(--bg) px-3 py-2 text-[16px] outline-none focus:border-(--accent)"
            />
            {error && <div className="text-sm text-(--danger)">{error}</div>}
            <div className="flex gap-2">
              <PrimaryButton disabled={busy} onClick={() => void create()}>
                {busy ? "正在建立…" : "建立"}
              </PrimaryButton>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setError(null);
                }}
                className="rounded-full px-3 py-1.5 text-sm text-(--muted)"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {pending.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm text-(--muted)">Pupu 建议的项目</h2>
            {pending.map((proposal) => (
              <div
                key={proposal.id}
                className="flex flex-col gap-1 rounded-xl border border-dashed border-(--accent)/50 bg-(--accent-soft) px-4 py-3"
              >
                <div className="font-medium">{proposal.name}</div>
                {proposal.goal && (
                  <div className="text-sm text-(--muted)">{proposal.goal}</div>
                )}
                <div className="flex gap-2 pt-1">
                  <PrimaryButton onClick={() => void onAccept(proposal.id)}>
                    建立项目
                  </PrimaryButton>
                  <button
                    type="button"
                    onClick={() => void onDismiss(proposal.id)}
                    className="rounded-full px-3 py-1.5 text-sm text-(--muted)"
                  >
                    先不用
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {projects.length === 0 && !creating ? (
          <div className="py-12 text-center text-sm leading-6 text-(--muted)">
            还没有项目。
            <br />
            在主对话里聊到要持续推进的事，Pupu 会建议你建一个；也可以直接点「新建项目」。
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => onOpen(project.id)}
                  className="flex w-full flex-col gap-1 rounded-xl border border-(--border) bg-(--surface) px-4 py-3 text-left active:bg-(--sunken)"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{project.name}</span>
                    <span className="shrink-0 text-xs text-(--muted)">
                      {ago(project.updatedAt)}
                    </span>
                  </div>
                  {project.goal && (
                    <span className="line-clamp-2 text-sm text-(--muted)">
                      {project.goal}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
