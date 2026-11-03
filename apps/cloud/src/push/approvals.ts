import type { ApprovalDirectory, ApprovalRow, ApprovalStatus } from "../bridge/approvals.ts";
import type { ApnsPush, ApnsResult } from "./apns.ts";
import type { PushDirectory, PushTokenRow } from "./store.ts";

/** 手机上注册的通知类别，带「允许」「拒绝」两个按钮。 */
export const APPROVAL_CATEGORY = "APPROVAL";
/** 审批的通知在通知中心里叠成一组。 */
const THREAD = "approvals";
/** 推送记录留一天。审批 10 分钟就作废，一天足够把「已处理」推完。 */
const KEEP_MS = 24 * 60 * 60_000;
/** 「已处理」那条手机一天内没收到就算了。 */
const SETTLED_TTL_S = 24 * 60 * 60;
/** 锁屏上通知正文显示不了太长，命令只放开头。APNs 一条最多 4 KB。 */
const BODY_CHARS = 300;

const OUTCOMES: Readonly<Record<Exclude<ApprovalStatus, "pending">, string>> = {
  allowed: "已允许",
  denied: "已拒绝",
  expired: "已过期，没有做"
};

export type PushSender = { send(push: ApnsPush): Promise<ApnsResult> };

export type ApprovalPusherOptions = {
  readonly approvals: Pick<ApprovalDirectory, "byId" | "pending">;
  readonly store: PushDirectory;
  /** 没配 APNs 密钥时是 null：什么都不推，也不记，配好以后还在等的那几条照样推出去。 */
  readonly apns: () => PushSender | null;
  readonly now: () => number;
  readonly log?: (message: string) => void;
};

/**
 * 把审批推到手机上。新的推一条带按钮的通知，`apns-collapse-id` 用审批 id；处理完或作废了，
 * 用同一个 collapse id 推一条安静的「已处理」把它替换掉，免得锁屏上留着点了也没用的按钮。
 *
 * 不跟着某一处代码推，而是每次审批变了就对一遍账：还在等的没推过就推，推过的不在等了就换掉。
 * 审批在好几处结束（点了、过期、电脑上收回），这样哪一处都不会漏。
 */
export class ApprovalPusher {
  readonly #options: ApprovalPusherOptions;
  #queue: Promise<void> = Promise.resolve();
  /** 审批 id → 在哪台手机上批的。那台手机上的通知它自己会收掉，不用再给它推「已处理」。 */
  readonly #decidedBy = new Map<string, string>();

  constructor(options: ApprovalPusherOptions) {
    this.#options = options;
  }

  /** 在 `gate.decide` 之前调。 */
  decidedBy(approvalId: string, deviceId: string): void {
    this.#decidedBy.set(approvalId, deviceId);
  }

  /** 审批变了就调。一次只对一轮账，免得同一条推两次。 */
  sync(): Promise<void> {
    const run = this.#queue.then(() => this.#sync());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #sync(): Promise<void> {
    const apns = this.#options.apns();
    if (!apns) return;
    const { approvals, store } = this.#options;
    const now = this.#options.now();
    const pending = approvals.pending(now);
    const live = new Set(pending.map((row) => row.id));
    const tokens = store.tokens("alert");
    const jobs: Promise<void>[] = [];

    for (const row of pending) {
      if (store.approvalState(row.id)) continue;
      // 先记下再发：发的时候又来一轮，也不会再推一次。
      store.markApproval(row.id, "sent", now);
      jobs.push(
        this.#fanOut(apns, tokens, (token) => ({
          token: token.token,
          env: token.env,
          type: "alert",
          priority: 10,
          collapseId: row.id,
          expiration: Math.floor(row.expiresAt / 1000),
          payload: approvalAlert(row)
        }))
      );
    }

    for (const id of store.sentApprovals()) {
      if (live.has(id)) continue;
      store.markApproval(id, "cleared", now);
      const decider = this.#decidedBy.get(id);
      const row = approvals.byId(id);
      jobs.push(
        this.#fanOut(
          apns,
          tokens.filter((token) => token.deviceId !== decider),
          (token) => ({
            token: token.token,
            env: token.env,
            type: "alert",
            priority: 10,
            collapseId: id,
            expiration: Math.floor(now / 1000) + SETTLED_TTL_S,
            payload: approvalSettled(id, row, now)
          })
        )
      );
    }

    for (const id of [...this.#decidedBy.keys()]) {
      if (store.approvalState(id) !== "sent") this.#decidedBy.delete(id);
    }
    store.pruneApprovals(now - KEEP_MS);
    await Promise.all(jobs);
  }

  async #fanOut(
    apns: PushSender,
    tokens: readonly PushTokenRow[],
    build: (token: PushTokenRow) => ApnsPush
  ): Promise<void> {
    await Promise.all(
      tokens.map(async (token) => {
        const result = await apns.send(build(token));
        if (result.gone) {
          this.#options.store.remove(token.token);
          this.#options.log?.(`APNs 说这个 token 用不了了（${result.status} ${result.reason}），已删掉`);
        } else if (result.status !== 200) {
          this.#options.log?.(`APNs 没收这条推送：${result.status} ${result.reason ?? ""}`);
        }
      })
    );
  }
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 带按钮的那条。手机靠 `approvalId` 知道点的是哪一条。 */
export function approvalAlert(row: ApprovalRow): object {
  return {
    aps: {
      alert: {
        title: row.title,
        ...(row.reason ? { subtitle: `高风险：${row.reason}` } : {}),
        body: clip(row.detail, BODY_CHARS)
      },
      category: APPROVAL_CATEGORY,
      sound: "default",
      // 专注模式下也能看到；手机上要有 Time Sensitive 的 entitlement，没有就按普通通知。
      "interruption-level": "time-sensitive",
      "thread-id": THREAD
    },
    approvalId: row.id
  };
}

/** 替换上面那条：不响、不亮屏、没有按钮。审批记录已经清掉了就只说处理过了。 */
export function approvalSettled(id: string, row: ApprovalRow | undefined, now: number): object {
  const status = !row ? null : row.status === "pending" ? (row.expiresAt <= now ? "expired" : null) : row.status;
  const outcome = status ? OUTCOMES[status] : "已处理";
  return {
    aps: {
      alert: row
        ? { title: `${outcome}：${row.title}`, body: row.note ?? clip(row.detail, 120) }
        : { title: "这条请示已经处理过了", body: "" },
      "interruption-level": "passive",
      "relevance-score": 0,
      "thread-id": THREAD
    },
    approvalId: id,
    settled: status ?? "settled"
  };
}
