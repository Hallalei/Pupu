import { Children, Fragment, isValidElement, type ReactNode } from "react";
import type { ComputerView } from "../bridge/protocol";
import { ago } from "./ago";

/** 设置里几页共用的小件：组、说明、在线圆点、按钮的样子（规范 SettingsSheet、Devices、ModelSettings、ThisComputer）。 */

/** 一台电脑的状态词：在线、在线 · 有人在用、心跳中断、离线 · 3 分钟前。规范要求状态一定写成字。 */
export function computerLabel(computer: ComputerView): string {
  if (computer.online) return computer.inUse ? "在线 · 有人在用" : "在线";
  if (computer.stale) return "心跳中断";
  if (computer.lastSeenAt) return `离线 · ${ago(computer.lastSeenAt)}`;
  return "离线";
}

/** 行和行之间那条 1pt 的线从哪里画起：图标后面、Pupu 头像后面、字的左边、单选圈后面。 */
type Inset = "icon" | "org" | "text" | "radio";
const SEPARATOR: Record<Inset, string> = {
  icon: "ml-12",
  org: "ml-13",
  text: "ml-4",
  radio: "ml-12 pointer-fine:ml-11"
};

/**
 * 一组行（规范 SettingsSheet）：surface-inset 底、radius-row，行之间一条从 `inset` 画起的 line。
 * 上面可以有组标题（离上一组 20、离组 4），下面可以有一句说明或出错（离组 8）。一行都没有时整组不出现。
 */
export function Group({
  title,
  label,
  note,
  error,
  inset = "text",
  radiogroup = false,
  readOnly = false,
  children
}: {
  title?: string;
  /** 没有标题的组，给读屏念的名字。 */
  label?: string;
  note?: ReactNode;
  error?: string | null;
  inset?: Inset;
  /** 一组单选：组本身是 radiogroup，名字给它。 */
  radiogroup?: boolean;
  /** 只能看：整组点不了（不是创建者看模型页）。 */
  readOnly?: boolean;
  children: ReactNode;
}) {
  const rows = Children.toArray(children);
  if (rows.length === 0) return null;
  return (
    <section aria-label={title || radiogroup ? undefined : label} className={`flex shrink-0 flex-col ${title ? "not-first:mt-1.5" : ""}`}>
      {title && <h3 className="m-0 mb-1 px-1 text-footnote text-ink-muted">{title}</h3>}
      <div
        role={radiogroup ? "radiogroup" : undefined}
        aria-label={radiogroup ? label : undefined}
        aria-readonly={radiogroup && readOnly ? true : undefined}
        className={`flex flex-col overflow-hidden rounded-row bg-surface-inset ${readOnly ? "pointer-events-none" : ""}`}
      >
        {rows.map((row, index) => (
          <Fragment key={isValidElement(row) && row.key !== null ? row.key : index}>
            {index > 0 && <div aria-hidden="true" className={`h-px shrink-0 bg-line ${SEPARATOR[inset]}`} />}
            {row}
          </Fragment>
        ))}
      </div>
      {note && <p className="m-0 mt-2 px-1 text-footnote text-ink-muted">{note}</p>}
      {error && <p className="m-0 mt-2 px-1 text-subheadline text-danger-ink">{error}</p>}
    </section>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="m-0 px-1 text-subheadline text-ink-muted">{children}</p>;
}

export function Dot({ online }: { online: boolean }) {
  return <span className={`size-2 shrink-0 rounded-full ${online ? "bg-online" : "bg-offline"}`} aria-hidden="true" />;
}

/** 设置里的几种按钮（规范 Devices、ThisComputer、ModelSettings）。 */
export const PILL = "tap inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full text-subheadline font-semibold disabled:opacity-50";
/** 吊销确认里的两个：「取消」不填底，「吊销」surface 底、danger-ink。高 control-sm（手机浏览器 36，电脑 28）。 */
export const PILL_CANCEL = `${PILL} h-control-sm px-3.5 text-ink pointer-fine:hover:bg-line`;
export const PILL_DANGER = `${PILL} h-control-sm bg-surface px-3.5 text-danger-ink`;
/** 行里的小胶囊（「连接」「去打开」「从 Chrome 导入」）：surface 底、往里收 1pt line，高 32。 */
export const PILL_ROW = `${PILL} h-8 bg-surface px-3 text-ink inset-ring inset-ring-line`;
/** 主操作：action 底，高 control，字 body 600。 */
export const PILL_ACTION =
  "tap inline-flex h-control shrink-0 items-center justify-center gap-1.5 rounded-full bg-action px-4 text-body font-semibold text-on-action disabled:bg-action-off disabled:text-ink-muted";
/** 次要操作：放在 sheet 上的 surface-inset 胶囊。 */
export const PILL_SECONDARY =
  "tap inline-flex h-control shrink-0 items-center justify-center gap-1.5 rounded-full bg-surface-inset px-4 text-body font-semibold text-ink disabled:text-ink-muted";
/** 行尾的文字按钮（「吊销」「移除」「断开」「复制」）：subheadline，和左边的字隔 12。 */
export const TEXT_BUTTON = "shrink-0 text-subheadline pointer-fine:hover:underline disabled:opacity-50";

/** 整行是一个按钮：body 600、ink，不能点时 ink-muted。 */
export const ROW_BUTTON =
  "flex min-h-13 w-full items-center px-4 py-2.5 text-left text-body font-semibold text-ink pointer-fine:min-h-11 enabled:pointer-fine:hover:bg-line disabled:text-ink-muted";
