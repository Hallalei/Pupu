/**
 * 待用户批准的动作。和电脑表一样放在 Pupu 这个 Durable Object 的 SQLite 里。
 * 按工具调用的 id 唯一：DO 重启后 pi 会重跑这次调用的 beforeTool，按 id 查回来接着等。
 */

/**
 * step：这一步单独批。screen：批这台电脑的屏幕授权。
 * sign_in：新手机用 Google 登录，等已有手机点允许，不在这张表里，见 src/auth/sign-ins.ts。
 */
export type ApprovalKind = "step" | "screen" | "sign_in";
/** expired：10 分钟没人处理。aborted：还在等的时候这一轮停下了。 */
export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "aborted";

export type ApprovalRow = {
  readonly id: string;
  readonly callId: string;
  /** 这次调用在哪个 pi 会话里。私聊发起的要靠它决定给谁看。新手机登录和早先的记录是 null。 */
  readonly session: string | null;
  readonly computerId: string;
  readonly kind: ApprovalKind;
  /** 批了这一条，也同时开这台电脑的屏幕授权。 */
  readonly screen: boolean;
  readonly title: string;
  readonly detail: string;
  /** 为什么算高风险。只是普通的屏幕授权或每步都问时是 null。 */
  readonly reason: string | null;
  readonly status: ApprovalStatus;
  /** 拒绝的来由，比如在电脑上收回了屏幕控制。 */
  readonly note: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
};

/** 网页上的审批卡片。 */
export type ApprovalView = {
  readonly id: string;
  /** 等批的那次工具调用，对话里那一步靠它显示「等你批准」。新手机登录没有。 */
  readonly callId?: string;
  readonly computerId: string;
  readonly computerName: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly detail: string;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
};

export interface ApprovalDirectory {
  byId(id: string): ApprovalRow | undefined;
  byCall(callId: string): ApprovalRow | undefined;
  insert(input: Omit<ApprovalRow, "id" | "status" | "note" | "decidedAt">): ApprovalRow;
  /** 只改还在等的。改成了返回 true。 */
  settle(id: string, status: Exclude<ApprovalStatus, "pending">, at: number, note?: string): boolean;
  /** 还在等、没过期的，先来的在前。 */
  pending(now: number): ApprovalRow[];
  /** 把过期还在等的改成 expired，再删掉一周前的旧记录。返回改了几条。 */
  sweep(now: number): number;
}

type Row = Record<string, SqlStorageValue>;

const KEEP_MS = 7 * 24 * 60 * 60_000;

function toRow(row: Row): ApprovalRow {
  const status = String(row.status);
  return {
    id: String(row.id),
    callId: String(row.call_id),
    session: row.session === null ? null : String(row.session),
    computerId: String(row.computer_id),
    kind: row.kind === "screen" ? "screen" : "step",
    screen: Number(row.screen) === 1,
    title: String(row.title),
    detail: String(row.detail),
    reason: row.reason === null ? null : String(row.reason),
    status:
      status === "allowed" || status === "denied" || status === "expired" || status === "aborted" ? status : "pending",
    note: row.note === null ? null : String(row.note),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    decidedAt: row.decided_at === null ? null : Number(row.decided_at)
  };
}

export class ApprovalStore implements ApprovalDirectory {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_approvals (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL UNIQUE,
        computer_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        screen INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER
      )`);
      const columns = this.#sql.exec("PRAGMA table_info(pupu_approvals)").toArray();
      if (!columns.some((column) => column.name === "session")) {
        this.#sql.exec("ALTER TABLE pupu_approvals ADD COLUMN session TEXT");
      }
      this.#ready = true;
    }
    return this.#sql;
  }

  byId(id: string): ApprovalRow | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_approvals WHERE id = ?", id).toArray();
    return row ? toRow(row) : undefined;
  }

  byCall(callId: string): ApprovalRow | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_approvals WHERE call_id = ?", callId).toArray();
    return row ? toRow(row) : undefined;
  }

  insert(input: Omit<ApprovalRow, "id" | "status" | "note" | "decidedAt">): ApprovalRow {
    const id = crypto.randomUUID();
    this.#db().exec(
      `INSERT INTO pupu_approvals
        (id, call_id, session, computer_id, kind, screen, title, detail, reason, status, note, created_at, expires_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
      id,
      input.callId,
      input.session,
      input.computerId,
      input.kind,
      input.screen ? 1 : 0,
      input.title,
      input.detail,
      input.reason,
      input.createdAt,
      input.expiresAt
    );
    const created = this.byId(id);
    if (!created) throw new Error("审批没有写进去");
    return created;
  }

  settle(id: string, status: Exclude<ApprovalStatus, "pending">, at: number, note?: string): boolean {
    const cursor = this.#db().exec(
      "UPDATE pupu_approvals SET status = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'",
      status,
      at,
      note ?? null,
      id
    );
    // 读完游标，语句才算跑完，rowsWritten 才准。
    cursor.toArray();
    return cursor.rowsWritten > 0;
  }

  pending(now: number): ApprovalRow[] {
    return this.#db()
      .exec(
        "SELECT * FROM pupu_approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at",
        now
      )
      .toArray()
      .map(toRow);
  }

  sweep(now: number): number {
    const cursor = this.#db().exec(
      "UPDATE pupu_approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ?",
      now,
      now
    );
    cursor.toArray();
    this.#db().exec("DELETE FROM pupu_approvals WHERE status != 'pending' AND created_at < ?", now - KEEP_MS);
    return cursor.rowsWritten;
  }
}
