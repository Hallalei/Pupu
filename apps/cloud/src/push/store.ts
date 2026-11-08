/**
 * 手机的推送 token，以及每条审批推到了哪台手机。和设备表一样放在 Pupu 这个 Durable Object 的 SQLite 里。
 * `pupu_devices` 是设备凭据表，这里只按设备 id 挂上去，不混用。
 * 推送记录按手机记：审批出现之后才登记推送的手机，下一轮对账也会收到。
 * 早先按审批记的 `pupu_push_approvals` 不再读写，留在库里。
 */

import type { ApnsEnv } from "./apns.ts";

/**
 * alert：普通通知的设备 token。start：实时活动的 push-to-start token。
 * activity：手机上正开着的那个实时活动自己的 token，一台手机只留一个。
 */
export type PushTokenType = "alert" | "start" | "activity";

export type PushTokenRow = {
  readonly token: string;
  readonly type: PushTokenType;
  readonly deviceId: string;
  readonly env: ApnsEnv;
  readonly createdAt: number;
  readonly lastSeen: number;
};

/** 一条审批在一台手机上：sent 推了带按钮的那条；cleared 已经换成「已处理」，或者就是在这台上批的。 */
export type ApprovalPushState = "sent" | "cleared";

export interface PushDirectory {
  tokens(type: PushTokenType): PushTokenRow[];
  /** 一台设备每种只留一个 token：换了新的，旧的删掉。同一个 token 换了设备（重新配对）就挂到新设备上。 */
  save(input: { deviceId: string; token: string; type: PushTokenType; env: ApnsEnv }, now: number): void;
  remove(token: string): void;
  /** 只删这台设备自己的。 */
  removeOwn(deviceId: string, token: string): void;
  /** 吊销手机时：它的 token 和推送记录都删掉。 */
  removeDevice(deviceId: string): void;
  /** 这条审批推到过的手机，各到哪一步。 */
  deliveries(approvalId: string): ReadonlyMap<string, ApprovalPushState>;
  markDelivery(approvalId: string, deviceId: string, state: ApprovalPushState, now: number): void;
  /** 有手机还留着带按钮那条的审批。 */
  sentApprovals(): string[];
  /** 删掉这个时间以前的记录。 */
  pruneApprovals(before: number): void;
}

type Row = Record<string, SqlStorageValue>;

function toRow(row: Row): PushTokenRow {
  return {
    token: String(row.token),
    type: row.type === "start" || row.type === "activity" ? row.type : "alert",
    deviceId: String(row.device_id),
    env: row.env === "production" ? "production" : "sandbox",
    createdAt: Number(row.created_at),
    lastSeen: Number(row.last_seen)
  };
}

export class PushStore implements PushDirectory {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_push_tokens (
        token TEXT NOT NULL,
        type TEXT NOT NULL,
        device_id TEXT NOT NULL,
        env TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (type, token)
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_push_deliveries (
        approval_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        state TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (approval_id, device_id)
      )`);
      this.#ready = true;
    }
    return this.#sql;
  }

  tokens(type: PushTokenType): PushTokenRow[] {
    return this.#db()
      .exec("SELECT * FROM pupu_push_tokens WHERE type = ? ORDER BY last_seen DESC", type)
      .toArray()
      .map(toRow);
  }

  save(input: { deviceId: string; token: string; type: PushTokenType; env: ApnsEnv }, now: number): void {
    const db = this.#db();
    db.exec(
      "DELETE FROM pupu_push_tokens WHERE device_id = ? AND type = ? AND token != ?",
      input.deviceId,
      input.type,
      input.token
    );
    db.exec(
      `INSERT INTO pupu_push_tokens (token, type, device_id, env, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(type, token) DO UPDATE SET
         device_id = excluded.device_id, env = excluded.env, last_seen = excluded.last_seen`,
      input.token,
      input.type,
      input.deviceId,
      input.env,
      now,
      now
    );
  }

  remove(token: string): void {
    this.#db().exec("DELETE FROM pupu_push_tokens WHERE token = ?", token);
  }

  removeOwn(deviceId: string, token: string): void {
    this.#db().exec("DELETE FROM pupu_push_tokens WHERE device_id = ? AND token = ?", deviceId, token);
  }

  removeDevice(deviceId: string): void {
    this.#db().exec("DELETE FROM pupu_push_tokens WHERE device_id = ?", deviceId);
    this.#db().exec("DELETE FROM pupu_push_deliveries WHERE device_id = ?", deviceId);
  }

  deliveries(approvalId: string): ReadonlyMap<string, ApprovalPushState> {
    const rows = this.#db()
      .exec("SELECT device_id, state FROM pupu_push_deliveries WHERE approval_id = ?", approvalId)
      .toArray();
    return new Map(rows.map((row) => [String(row.device_id), row.state === "cleared" ? "cleared" : "sent"]));
  }

  markDelivery(approvalId: string, deviceId: string, state: ApprovalPushState, now: number): void {
    this.#db().exec(
      `INSERT INTO pupu_push_deliveries (approval_id, device_id, state, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(approval_id, device_id) DO UPDATE SET state = excluded.state, at = excluded.at`,
      approvalId,
      deviceId,
      state,
      now
    );
  }

  sentApprovals(): string[] {
    return this.#db()
      .exec("SELECT DISTINCT approval_id FROM pupu_push_deliveries WHERE state = 'sent'")
      .toArray()
      .map((row) => String(row.approval_id));
  }

  pruneApprovals(before: number): void {
    this.#db().exec("DELETE FROM pupu_push_deliveries WHERE at < ?", before);
  }
}
