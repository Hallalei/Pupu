/**
 * 没批准的调用到不了工具：pi-durable 把 gate 给的原因原样记成这一步的结果文字，不带 details。
 * 所以原因怎么写、客户端怎么认放在一处：gate 用 `blockedText` 写，网页用 `blockedOutcome` 认。
 * iOS 的 `ChatRows.blockedOutcome` 照抄这里，改了要一起改；老会话里记下的文字也按这套认。
 */

export type BlockedOutcome = "denied" | "expired" | "aborted";

const NOT_RUN = "，没有执行：";
export const EXPIRED = "已经作废";
export const ABORTED = "这一轮停下了";

export function blockedText(why: string, title: string, advice: string): string {
  return `${why}${NOT_RUN}${title}。${advice}`;
}

export function blockedOutcome(text: string): BlockedOutcome | null {
  const cut = text.indexOf(NOT_RUN);
  if (cut < 0) return null;
  const why = text.slice(0, cut);
  if (why.endsWith(EXPIRED)) return "expired";
  if (why.endsWith(ABORTED)) return "aborted";
  return "denied";
}

/** 卡片上只留原因：「……，这一步没有做。」不是拦下的原样返回。 */
export function blockedReason(text: string): string | null {
  const cut = text.indexOf(NOT_RUN);
  return cut < 0 ? null : `${text.slice(0, cut)}，这一步没有做。`;
}
