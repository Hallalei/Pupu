/**
 * 电脑那边晚些才有的消息，要回到发起的那条对话：
 * - 交出去的命令（后台命令、前台到时间转后台）退出了；
 * - 对话里要用的电脑当时离线，现在连上了。
 * 那次调用早就结束了，Durable Object 也可能已经回收过，所以记在 SQLite 里。
 * 消息怎么写、怎么送进对话，见 server.ts 的 `#notify`。
 */

/** 等电脑的记录留这么久。过了还没连上，就不再提醒。 */
export const WAIT_TTL_MS = 24 * 60 * 60_000;
/** 后台命令的记录留这么久。跑得更久的，退出时不再回到对话。 */
export const DETACHED_TTL_MS = 7 * 24 * 60 * 60_000;
/** 没指定电脑、一台都不在线时等的是「随便哪台」。 */
export const ANY_COMPUTER = "*";

export type DetachedCall = {
  readonly requestId: string;
  readonly session: string;
  readonly computerId: string;
  readonly command: string;
  readonly startedAt: number;
};

export class FollowUpStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_computer_waits (
        computer_id TEXT NOT NULL,
        session TEXT NOT NULL,
        since INTEGER NOT NULL,
        PRIMARY KEY (computer_id, session)
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_detached_calls (
        request_id TEXT PRIMARY KEY,
        session TEXT NOT NULL,
        computer_id TEXT NOT NULL,
        command TEXT NOT NULL,
        started_at INTEGER NOT NULL
      )`);
      this.#ready = true;
    }
    return this.#sql;
  }

  /** 这条对话要用的电脑不在线。同一条对话等同一台电脑只记一条，时间按第一次算。 */
  wait(computerId: string, session: string, now: number): void {
    this.#db().exec(
      "INSERT OR IGNORE INTO pupu_computer_waits (computer_id, session, since) VALUES (?, ?, ?)",
      computerId,
      session,
      now
    );
  }

  /** 这台电脑连上了：取走等它的、和等随便哪台的对话。过期的一起清掉。 */
  arrived(computerId: string, now: number): string[] {
    const db = this.#db();
    db.exec("DELETE FROM pupu_computer_waits WHERE since < ?", now - WAIT_TTL_MS);
    const sessions = db
      .exec(
        "DELETE FROM pupu_computer_waits WHERE computer_id IN (?, ?) RETURNING session",
        computerId,
        ANY_COMPUTER
      )
      .toArray()
      .map((row) => String(row.session));
    return [...new Set(sessions)];
  }

  detached(call: DetachedCall): void {
    this.#db().exec(
      `INSERT OR REPLACE INTO pupu_detached_calls (request_id, session, computer_id, command, started_at)
       VALUES (?, ?, ?, ?, ?)`,
      call.requestId,
      call.session,
      call.computerId,
      call.command,
      call.startedAt
    );
  }

  /** 交出去的命令退出了：取走记录。电脑对不上、没记过、太久了，都是 null。 */
  finished(requestId: string, computerId: string, now: number): DetachedCall | null {
    const db = this.#db();
    db.exec("DELETE FROM pupu_detached_calls WHERE started_at < ?", now - DETACHED_TTL_MS);
    const row = db
      .exec("DELETE FROM pupu_detached_calls WHERE request_id = ? AND computer_id = ? RETURNING *", requestId, computerId)
      .toArray()[0];
    if (!row) return null;
    return {
      requestId: String(row.request_id),
      session: String(row.session),
      computerId: String(row.computer_id),
      command: String(row.command),
      startedAt: Number(row.started_at)
    };
  }

  /** 电脑吊销了，等它的、它上面的后台命令都不用再管。 */
  forgetComputer(computerId: string): void {
    const db = this.#db();
    db.exec("DELETE FROM pupu_computer_waits WHERE computer_id = ?", computerId);
    db.exec("DELETE FROM pupu_detached_calls WHERE computer_id = ?", computerId);
  }

  /** 对话没了（项目删了）。 */
  forgetSession(session: string): void {
    const db = this.#db();
    db.exec("DELETE FROM pupu_computer_waits WHERE session = ?", session);
    db.exec("DELETE FROM pupu_detached_calls WHERE session = ?", session);
  }
}
