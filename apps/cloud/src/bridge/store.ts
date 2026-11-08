import type { ScreenGrant } from "./gate.ts";
import { DEFAULT_POLICY, isComputerPolicy, type ComputerPolicy } from "./policy.ts";

/**
 * 授权电脑和设备凭据。和项目表一样放在 Pupu 这个 Durable Object 的 SQLite 里。
 * 凭据只存哈希。吊销后行还在，同一份凭据不能再连。
 */

export type ComputerRow = {
  readonly id: string;
  readonly name: string;
  /** 这台电脑是谁的：用谁的账号登录电脑 App、谁的设备生成的配对码，就是谁的。还没主人是 null。 */
  readonly ownerId: string | null;
  readonly tokenHash: string;
  readonly localRoot: string;
  readonly terminalsFolder: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastSeenAt: number | null;
  /** 这台电脑的审批分级。 */
  readonly policy: ComputerPolicy;
  /** 屏幕授权，怎么变见 gate.ts 的 `nextScreen`。 */
  readonly screen: ScreenGrant;
};

export interface ComputerDirectory {
  byTokenHash(hash: string): ComputerRow | undefined;
  list(): ComputerRow[];
  insert(input: { name: string; tokenHash: string; ownerId?: string | null }): ComputerRow;
  revoke(id: string): ComputerRow | undefined;
  markSeen(
    id: string,
    patch: { name?: string; localRoot?: string; terminalsFolder?: string; seenAt: number }
  ): void;
  setPolicy(id: string, policy: ComputerPolicy): boolean;
  setScreen(id: string, grant: ScreenGrant): void;
}

type Row = Record<string, SqlStorageValue>;

function toRow(row: Row): ComputerRow {
  return {
    id: String(row.id),
    name: String(row.name),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    tokenHash: String(row.token_hash),
    localRoot: String(row.local_root),
    terminalsFolder: String(row.terminals_folder),
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
    policy: isComputerPolicy(row.policy) ? row.policy : DEFAULT_POLICY,
    screen: screenOf(row)
  };
}

/**
 * screen_state 是授权的状态，screen_until 是它的时间：有效时是到期的时间，收回了是收回的时间。
 * 早先只有 screen_until 一列，state 是空的：有时间就当有效，过没过期读的时候再看。
 */
function screenOf(row: Row): ScreenGrant {
  const at = row.screen_until === null || row.screen_until === undefined ? null : Number(row.screen_until);
  if (at === null || row.screen_state === "none") return { kind: "none" };
  return row.screen_state === "revoked" ? { kind: "revoked", at } : { kind: "active", until: at };
}

export class ComputerStore implements ComputerDirectory {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_computers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        local_root TEXT NOT NULL DEFAULT '',
        terminals_folder TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_seen_at INTEGER
      )`);
      // 后加的列。已经有了的话 ALTER 会报错，忽略就行。
      for (const column of [
        `policy TEXT NOT NULL DEFAULT '${DEFAULT_POLICY}'`,
        "screen_until INTEGER",
        "owner_id TEXT",
        "screen_state TEXT"
      ]) {
        try {
          this.#sql.exec(`ALTER TABLE pupu_computers ADD COLUMN ${column}`);
        } catch {
          // 列已经在了。
        }
      }
      this.#ready = true;
    }
    return this.#sql;
  }

  byTokenHash(hash: string): ComputerRow | undefined {
    const [row] = this.#db()
      .exec("SELECT * FROM pupu_computers WHERE token_hash = ?", hash)
      .toArray();
    return row ? toRow(row) : undefined;
  }

  /** 没吊销的，新配对的在前。 */
  list(): ComputerRow[] {
    return this.#db()
      .exec("SELECT * FROM pupu_computers WHERE revoked_at IS NULL ORDER BY created_at DESC")
      .toArray()
      .map(toRow);
  }

  insert(input: { name: string; tokenHash: string; ownerId?: string | null }): ComputerRow {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.#db().exec(
      `INSERT INTO pupu_computers
        (id, name, owner_id, token_hash, local_root, terminals_folder, created_at, revoked_at, last_seen_at)
       VALUES (?, ?, ?, ?, '', '', ?, NULL, NULL)`,
      id,
      input.name,
      input.ownerId ?? null,
      input.tokenHash,
      now
    );
    const created = this.byTokenHash(input.tokenHash);
    if (!created) throw new Error("电脑没有写进去");
    return created;
  }

  revoke(id: string): ComputerRow | undefined {
    const now = Date.now();
    this.#db().exec(
      "UPDATE pupu_computers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      now,
      id
    );
    const [row] = this.#db().exec("SELECT * FROM pupu_computers WHERE id = ?", id).toArray();
    return row ? toRow(row) : undefined;
  }

  markSeen(
    id: string,
    patch: { name?: string; localRoot?: string; terminalsFolder?: string; seenAt: number }
  ): void {
    const [current] = this.#db().exec("SELECT * FROM pupu_computers WHERE id = ?", id).toArray();
    if (!current) return;
    const row = toRow(current);
    this.#db().exec(
      `UPDATE pupu_computers
       SET name = ?, local_root = ?, terminals_folder = ?, last_seen_at = ?
       WHERE id = ?`,
      patch.name?.trim() || row.name,
      patch.localRoot ?? row.localRoot,
      patch.terminalsFolder ?? row.terminalsFolder,
      patch.seenAt,
      id
    );
  }

  setPolicy(id: string, policy: ComputerPolicy): boolean {
    const [row] = this.#db()
      .exec("SELECT id FROM pupu_computers WHERE id = ? AND revoked_at IS NULL", id)
      .toArray();
    if (!row) return false;
    this.#db().exec("UPDATE pupu_computers SET policy = ? WHERE id = ?", policy, id);
    return true;
  }

  /** 还没有主人的电脑都归这个成员。创建者第一次登录时用。 */
  claimUnowned(ownerId: string): void {
    this.#db().exec("UPDATE pupu_computers SET owner_id = ? WHERE owner_id IS NULL", ownerId);
  }

  setScreen(id: string, grant: ScreenGrant): void {
    const at = grant.kind === "active" ? grant.until : grant.kind === "revoked" ? grant.at : null;
    this.#db().exec("UPDATE pupu_computers SET screen_state = ?, screen_until = ? WHERE id = ?", grant.kind, at, id);
  }
}
