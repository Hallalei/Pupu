/**
 * /api/state 的几次拉取和 socket 推来的 activity，谁新谁旧。定时、切回窗口、socket 通知、操作之后都会拉，
 * 慢的那次可能比快的晚回来；activity 还有推送这第二个来源。按发起的先后排号：拉取在发出时拿号，推送在收到时拿号。
 * 内容只用比已经用上的更新的；成败（错误提示、要不要登录）只看最近发起、已经回来的那次。
 */
export type SnapshotOrder = {
  /** 发出一次拉取，拿到它的号。 */
  start(): number;
  /** 这次拉取成功回来了：整份内容、里面的 activity、成败，各自用不用。 */
  arrived(ticket: number): { readonly state: boolean; readonly activity: boolean; readonly outcome: boolean };
  /** 这次拉取失败了：错误要不要显示。 */
  failed(ticket: number): boolean;
  /** 收到推来的 activity。它比所有已经发出的拉取都新。 */
  pushed(): void;
};

export function createSnapshotOrder(): SnapshotOrder {
  let clock = 0;
  let state = 0;
  let activity = 0;
  let outcome = 0;
  return {
    start: () => ++clock,
    arrived(ticket) {
      const use = { state: ticket > state, activity: ticket > activity, outcome: ticket > outcome };
      if (use.state) state = ticket;
      if (use.activity) activity = ticket;
      if (use.outcome) outcome = ticket;
      return use;
    },
    failed(ticket) {
      if (ticket <= outcome) return false;
      outcome = ticket;
      return true;
    },
    pushed() {
      activity = ++clock;
    }
  };
}
