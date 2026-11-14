import { Spinner } from "@heroui/react";
import { useEffect, useState } from "react";
import type { ComputerActivity } from "../bridge/activity";
import { ago } from "./ago";
import { ChevronDownIcon } from "./icons";

const CHIP = "tap inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-surface-inset px-3 text-footnote text-ink";

/**
 * 会话卡最上面的状态条（规范 SpaceHeader 的状态条）：「正在做 N」胶囊，没有就整行收起，不占位。
 * `rows` 是 `busyComputers` 的结果，停在审批上的电脑已经去掉（审批卡就在下面，同一件事不写两遍）。
 * 规范只画了计数。这里点「正在做」往下摊开每台电脑在做什么，点一行去对话里那台电脑的卡；
 * 屏幕控制开着时状态条上多一个「收回」（规范对照记录：冲突 2）。
 */
export function StatusStrip({
  rows,
  onOpen,
  onTakeback
}: {
  rows: readonly ComputerActivity[];
  onOpen: (activity: ComputerActivity) => void;
  onTakeback: (computerId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [taking, setTaking] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (rows.length === 0) setExpanded(false);
  }, [rows.length]);

  if (rows.length === 0) return null;

  const screens = rows.filter((row) => row.screen);
  const waiting = rows.some((row) => row.state === "waiting");

  async function takeback(ids: readonly string[]) {
    setTaking((current) => new Set([...current, ...ids]));
    setError(null);
    try {
      for (const id of ids) await onTakeback(id);
    } catch (cause) {
      setError(`没收回：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setTaking((current) => new Set([...current].filter((id) => !ids.includes(id))));
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-column flex-col gap-2 px-4 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)} className={CHIP}>
          <span aria-hidden="true" className={`size-2 rounded-full ${waiting ? "bg-warning" : "bg-ink"}`} />
          正在做 {rows.length}
          <ChevronDownIcon aria-hidden="true" className={`text-[12px] text-ink-muted transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
        {screens.length > 0 && !expanded && (
          <button
            type="button"
            aria-label={`收回${screens.map((row) => `「${row.computerName}」`).join("")}的屏幕控制`}
            disabled={screens.some((row) => taking.has(row.computerId))}
            onClick={() => void takeback(screens.map((row) => row.computerId))}
            className={`${CHIP} font-semibold disabled:text-ink-muted`}
          >
            收回
          </button>
        )}
        {error && <span className="text-footnote text-danger-ink">{error}</span>}
      </div>
      {expanded && (
        <ul className="fade-in m-0 flex list-none flex-col overflow-hidden rounded-row bg-surface-inset p-0">
          {rows.map((activity, index) => (
            <li key={activity.computerId} className="flex flex-col">
              {index > 0 && <div aria-hidden="true" className="ml-11 h-px bg-line" />}
              <DoingRow
                activity={activity}
                taking={taking.has(activity.computerId)}
                onOpen={onOpen}
                onTakeback={() => void takeback([activity.computerId])}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DoingRow({
  activity,
  taking,
  onOpen,
  onTakeback
}: {
  activity: ComputerActivity;
  taking: boolean;
  onOpen: (activity: ComputerActivity) => void;
  onTakeback: () => void;
}) {
  const detail = [activity.computerName, activity.project?.name, activity.since ? ago(activity.since) : null].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-13 items-center gap-3 pr-3 pl-4">
      <button type="button" onClick={() => onOpen(activity)} className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left">
        <span className="grid size-4 shrink-0 place-items-center">
          {activity.state === "working" ? (
            <Spinner size="sm" aria-label="在做" />
          ) : activity.state === "waiting" ? (
            <span role="img" aria-label="等你批准" className="size-2 rounded-full bg-warning" />
          ) : (
            <span aria-hidden="true" className="size-2 rounded-full bg-online" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-subheadline">{activity.doing ?? "闲着，屏幕控制还开着"}</span>
          <span className="truncate text-footnote text-ink-muted">{detail}</span>
        </span>
      </button>
      {activity.screen && (
        <button
          type="button"
          disabled={taking}
          onClick={onTakeback}
          className="tap h-8 shrink-0 rounded-full bg-surface px-3.5 text-subheadline font-semibold text-ink disabled:text-ink-muted"
        >
          收回
        </button>
      )}
    </div>
  );
}
