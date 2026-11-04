/**
 * 项目报给聊天的结果。聊天把一件事转交给项目时记一条，项目那一轮做完（或者卡住、出错）时填上结果，
 * 聊天里按时间穿插成一张张报告卡。只是给人看的记录，不进 pi 的对话，也不叫醒聊天里的 Pupu；
 * 聊天里的 Pupu 从提示词的「当前的项目」里读到最近一次报告。
 *
 * 思路对照过 opencode 的后台子代理（packages/core/src/session/subagent-completion.ts）：做完时给父会话
 * 一条带状态和子会话 id 的记录，用一个通知 id 去重。这里先只做给人看的那一半。
 */

import { progressLine } from "./projects.ts";

/**
 * running：在做，或者排着队，聊天里不显示。waiting：停在一步等用户批准。
 * done：这一轮做完了。asking：做完了，但最后在问用户要怎么办。failed：模型出错，没做完。
 */
export type ReportState = "running" | "waiting" | "done" | "asking" | "failed";

/** 卡片上的三种状态：做完了 / 卡住了要你定 / 出错了。 */
export type ReportStatus = "done" | "blocked" | "failed";

export type ReportRow = {
  /** 转交时的 operationId，同一次转交重放也只记一条。 */
  readonly id: string;
  readonly projectId: string;
  readonly session: string;
  /** 转交过去的事，一行。 */
  readonly task: string;
  readonly state: ReportState;
  /** 一句结果。还在做时是空串。 */
  readonly summary: string;
  /**
   * 替谁做的：发起这件事的人。聊天是大家共用的，报告卡人人都看得到；多人用时卡上写明替谁做、@ 那个人。
   * 现在还没有成员，是 null。
   */
  readonly owner: string | null;
  readonly createdAt: number;
  /** 最后一次变成要给人看的状态的时间，卡片按它排进聊天。还没报过是 null。 */
  readonly reportedAt: number | null;
  /** 用户打开过这个项目。 */
  readonly seenAt: number | null;
};

/** 聊天里的一张报告卡。同一个项目还没看过的几条合成一张，只显示最新的。 */
export type ReportCard = {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly status: ReportStatus;
  readonly summary: string;
  readonly task: string;
  readonly at: number;
  readonly seen: boolean;
  /** 合进来的、更早的几条没看过的报告。 */
  readonly more: number;
};

type Row = Record<string, SqlStorageValue>;

/** 聊天里最多带这么多张看过的卡；没看过的都带上。 */
const SEEN_LIMIT = 50;

const UNFINISHED = "('running', 'waiting')";
const VISIBLE = "('waiting', 'done', 'asking', 'failed')";

export function statusOf(state: ReportState): ReportStatus | null {
  switch (state) {
    case "running":
      return null;
    case "waiting":
    case "asking":
      return "blocked";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

export const STATUS_LABELS: Record<ReportStatus, string> = {
  done: "做完了",
  blocked: "卡住了要你定",
  failed: "出错了"
};

/** 回复的最后一句是问句：Pupu 在等用户拿主意。代码块里的不算。 */
export function asksUser(reply: string): boolean {
  let fenced = false;
  let last = "";
  for (const raw of reply.split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && raw.trim()) last = raw.trim();
  }
  return /[？?][)）」*_\s]*$/.test(last);
}

/** 重试完了还没回上时报告里的那句。模型报的错是 `503: {"message": …}` 这种给程序看的，换成人话。 */
export function failureSummary(error: string): string {
  const status = Number(/^\s*(\d{3})\b/.exec(error)?.[1] ?? 0);
  const lower = error.toLowerCase();
  if (status === 429 || lower.includes("rate limit")) return "模型那边限流了，这件事没做完。";
  if (status === 402 || lower.includes("insufficient balance")) return "模型账户的余额用完了，这件事没做完。";
  if (status === 401 || status === 403) return "模型的 key 用不了了，这件事没做完。";
  if (status >= 500 || lower.includes("overloaded")) return "模型那边太忙，这件事没做完。";
  let detail = error.trim();
  try {
    const body = JSON.parse(error.slice(error.indexOf("{"))) as { message?: unknown; error?: { message?: unknown } };
    const message = body.message ?? body.error?.message;
    if (typeof message === "string" && message.trim()) detail = message.trim();
  } catch {
    // 不是 JSON，用原文。
  }
  detail = progressLine(detail);
  return detail ? `模型出错，这件事没做完：${detail}` : "模型出错，这件事没做完。";
}

/** 用户引用回复报告卡时，引用里写的话。带上项目名，聊天里的 Pupu 才知道在说哪个项目。 */
export function reportQuote(card: Pick<ReportCard, "projectName" | "status" | "summary">): string {
  return `项目「${card.projectName}」的报告 · ${STATUS_LABELS[card.status]}：${card.summary}`;
}

/**
 * 看过的一条一张，放在它自己的时间；同一个项目没看过的合成一张，放在最新那条的时间。按时间先后排。
 * `rows` 只给要显示的（不在做的），顺序不限。
 */
export function reportCards(rows: readonly ReportRow[], projectName: (id: string) => string | undefined): ReportCard[] {
  const cards: ReportCard[] = [];
  const unseen = new Map<string, ReportRow[]>();
  for (const row of rows) {
    if (row.reportedAt === null || statusOf(row.state) === null) continue;
    if (projectName(row.projectId) === undefined) continue;
    if (row.seenAt === null) {
      unseen.set(row.projectId, [...(unseen.get(row.projectId) ?? []), row]);
    } else {
      cards.push(card(row, 0, projectName));
    }
  }
  for (const group of unseen.values()) {
    const latest = group.reduce((a, b) => (b.reportedAt! > a.reportedAt! ? b : a));
    cards.push(card(latest, group.length - 1, projectName));
  }
  return cards.sort((a, b) => a.at - b.at);
}

function card(row: ReportRow, more: number, projectName: (id: string) => string | undefined): ReportCard {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: projectName(row.projectId) ?? "",
    status: statusOf(row.state)!,
    summary: row.summary || row.task,
    task: row.task,
    at: row.reportedAt!,
    seen: row.seenAt !== null,
    more
  };
}

function toRow(row: Row): ReportRow {
  const state = String(row.state);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    session: String(row.session),
    task: String(row.task),
    state:
      state === "waiting" || state === "done" || state === "asking" || state === "failed" ? state : "running",
    summary: String(row.summary),
    owner: row.owner === null ? null : String(row.owner),
    createdAt: Number(row.created_at),
    reportedAt: row.reported_at === null ? null : Number(row.reported_at),
    seenAt: row.seen_at === null ? null : Number(row.seen_at)
  };
}

export class ReportStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_reports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session TEXT NOT NULL,
        task TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'running',
        summary TEXT NOT NULL DEFAULT '',
        owner TEXT,
        errors INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        reported_at INTEGER,
        seen_at INTEGER
      )`);
      this.#sql.exec("CREATE INDEX IF NOT EXISTS pupu_reports_session ON pupu_reports (session, state)");
      this.#ready = true;
    }
    return this.#sql;
  }

  /** 转交时记一条在做的。要在提交到项目会话之前记，时间才早于那条消息。 */
  open(input: { id: string; projectId: string; session: string; task: string; owner?: string | null }, now: number): void {
    const task = input.task.trim().split("\n")[0]?.trim() ?? "";
    this.#db().exec(
      `INSERT OR IGNORE INTO pupu_reports (id, project_id, session, task, owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.id,
      input.projectId,
      input.session,
      progressLine(task) || task.slice(0, 80),
      input.owner ?? null,
      now
    );
  }

  /** 这个会话里还没做完的、在 `upTo` 之前转交的。`upTo` 之后的还排在队里，不归这一轮。 */
  unfinished(session: string, upTo: number): ReportRow[] {
    return this.#db()
      .exec(
        `SELECT * FROM pupu_reports WHERE session = ? AND state IN ${UNFINISHED} AND created_at <= ?`,
        session,
        upTo
      )
      .toArray()
      .map(toRow);
  }

  /** 这一轮结束：填上结果。改了返回 true。 */
  settle(session: string, upTo: number, state: "done" | "asking" | "failed", summary: string, now: number): boolean {
    const cursor = this.#db().exec(
      `UPDATE pupu_reports SET state = ?, summary = ?, errors = 0, reported_at = ?
       WHERE session = ? AND state IN ${UNFINISHED} AND created_at <= ?`,
      state,
      summary,
      now,
      session,
      upTo
    );
    return cursor.rowsWritten > 0;
  }

  /** 模型出错、会自动重试：记一次，返回这一轮已经错了几次。 */
  countError(session: string, upTo: number): number {
    const [row] = this.#db()
      .exec(
        `UPDATE pupu_reports SET errors = errors + 1
         WHERE session = ? AND state IN ${UNFINISHED} AND created_at <= ?
         RETURNING errors`,
        session,
        upTo
      )
      .toArray();
    return row ? Number(row.errors) : 0;
  }

  /** 模型回上了：重试的次数从头算。 */
  clearErrors(session: string): void {
    this.#db().exec(
      `UPDATE pupu_reports SET errors = 0 WHERE session = ? AND state IN ${UNFINISHED} AND errors > 0`,
      session
    );
  }

  /**
   * 按现在等批的会话改状态：有请示在等的，在做的改成等批（带上等批的那一步）；
   * 没有请示在等了的，改回在做，等这一轮结束再报。改了返回 true。
   */
  syncWaiting(waiting: ReadonlyMap<string, { readonly summary: string; readonly upTo: number }>, now: number): boolean {
    let changed = false;
    const rows = this.#db()
      .exec(`SELECT * FROM pupu_reports WHERE state IN ${UNFINISHED}`)
      .toArray()
      .map(toRow);
    for (const row of rows) {
      const wait = waiting.get(row.session);
      if (wait && row.createdAt <= wait.upTo) {
        if (row.state === "waiting" && row.summary === wait.summary) continue;
        this.#db().exec(
          "UPDATE pupu_reports SET state = 'waiting', summary = ?, reported_at = ? WHERE id = ?",
          wait.summary,
          row.state === "waiting" ? row.reportedAt : now,
          row.id
        );
        changed = true;
      } else if (row.state === "waiting") {
        this.#db().exec("UPDATE pupu_reports SET state = 'running', summary = '' WHERE id = ?", row.id);
        changed = true;
      }
    }
    return changed;
  }

  /** 用户打开了这个项目：报给他的都算看过了。改了返回 true。 */
  markSeen(projectId: string, now: number): boolean {
    const cursor = this.#db().exec(
      `UPDATE pupu_reports SET seen_at = ? WHERE project_id = ? AND seen_at IS NULL AND state IN ${VISIBLE}`,
      now,
      projectId
    );
    return cursor.rowsWritten > 0;
  }

  /** 聊天里要显示的：没看过的全部，加上最近看过的几十条。 */
  visible(): ReportRow[] {
    return this.#db()
      .exec(
        `SELECT * FROM pupu_reports WHERE state IN ${VISIBLE} AND (
           seen_at IS NULL OR id IN (
             SELECT id FROM pupu_reports WHERE state IN ${VISIBLE} AND seen_at IS NOT NULL
             ORDER BY reported_at DESC LIMIT ${SEEN_LIMIT}
           )
         )`
      )
      .toArray()
      .map(toRow);
  }

  /** 每个项目最近一次报告，提示词里用。 */
  latestByProject(): Map<string, ReportRow> {
    const rows = this.#db()
      .exec(
        `SELECT * FROM pupu_reports AS report WHERE state IN ${VISIBLE} AND reported_at = (
           SELECT MAX(reported_at) FROM pupu_reports
           WHERE project_id = report.project_id AND state IN ${VISIBLE}
         )`
      )
      .toArray()
      .map(toRow);
    return new Map(rows.map((row) => [row.projectId, row]));
  }
}
