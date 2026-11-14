import { Button, Spinner } from "@heroui/react";
import { useEffect, useState, type ReactNode } from "react";
import type { ComputerActivity } from "../bridge/activity";
import { ago } from "./ago";
import { ChevronDownIcon } from "./icons";

/**
 * 聊天顶上的「正在做」，`rows` 是 `busyComputers` 的结果。把内容往下挤，不盖住对话。
 * 默认只摊开第一行：屏幕控制开着的排最前，收起时「收回」也露在外面。点一行去对话里那台电脑的任务卡。
 */
export function Doing({
  rows,
  onOpen,
  onTakeback
}: {
  rows: readonly ComputerActivity[];
  onOpen: (activity: ComputerActivity) => void;
  onTakeback: (computerId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (rows.length < 2) setExpanded(false);
  }, [rows.length]);

  if (rows.length === 0) return null;

  return (
    <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-3 lg:px-6">
      {(expanded ? rows : rows.slice(0, 1)).map((activity, index) => (
        <DoingRow
          key={activity.computerId}
          activity={activity}
          onOpen={onOpen}
          onTakeback={onTakeback}
          trailing={
            index === 0 &&
            rows.length > 1 && (
              <button
                type="button"
                aria-label={expanded ? "收起" : "展开全部电脑"}
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
                className="grid h-control-sm min-w-control-sm shrink-0 place-items-center rounded-full bg-surface-inset px-1.5 text-caption font-semibold"
              >
                {expanded ? <ChevronDownIcon className="rotate-180 text-[14px]" /> : `+${rows.length - 1}`}
              </button>
            )
          }
        />
      ))}
    </div>
  );
}

function DoingRow({
  activity,
  onOpen,
  onTakeback,
  trailing
}: {
  activity: ComputerActivity;
  onOpen: (activity: ComputerActivity) => void;
  onTakeback: (computerId: string) => Promise<void>;
  trailing?: ReactNode;
}) {
  const [takingBack, setTakingBack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { project } = activity;
  const detail = [activity.computerName, project?.name, activity.since ? ago(activity.since) : null]
    .filter(Boolean)
    .join(" · ");

  async function takeback() {
    setTakingBack(true);
    setError(null);
    try {
      await onTakeback(activity.computerId);
    } catch (cause) {
      setError(`没收回：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setTakingBack(false);
    }
  }

  const summary = (
    <>
      <span className="grid size-4 shrink-0 place-items-center">
        {activity.state === "working" ? (
          <Spinner size="sm" aria-label="在做" />
        ) : activity.state === "waiting" ? (
          <span role="img" aria-label="等你批准" className="size-2 rounded-full bg-warning" />
        ) : (
          <span className="size-2 rounded-full bg-online" aria-hidden="true" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-subheadline font-medium">{activity.doing ?? "闲着，屏幕控制还开着"}</span>
        <span className={`truncate text-caption ${error ? "text-danger-ink" : "text-ink-muted"}`}>{error ?? detail}</span>
      </span>
    </>
  );
  const main = "flex min-w-0 flex-1 items-center gap-3 text-left enabled:hover:opacity-75";

  return (
    <div className="bg-surface-inset flex items-center gap-3 rounded-row px-4 py-2">
      <button type="button" onClick={() => onOpen(activity)} className={main}>
        {summary}
      </button>
      {activity.screen && (
        <Button size="sm" variant="secondary" isPending={takingBack} onPress={() => void takeback()}>
          收回
        </Button>
      )}
      {trailing}
    </div>
  );
}
