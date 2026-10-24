/**
 * 授权电脑和设备凭据。和项目表一样放在 Pupu 这个 Durable Object 的 SQLite 里。
 * 凭据只存哈希。吊销后行还在，同一份凭据不能再连。
 */

export type ComputerRow = {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly localRoot: string;
  readonly terminalsFolder: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly lastSeenAt: number | null;
};

export interface ComputerDirectory {
  byTokenHash(hash: string): ComputerRow | undefined;
  list(): ComputerRow[];
  insert(input: { name: string; tokenHash: string }): ComputerRow;
  revoke(id: string): ComputerRow | undefined;
  markSeen(
    id: string,
    patch: { name?: string; localRoot?: string; terminalsFolder?: string; seenAt: number }
  ): void;
}

type Row = Record<string, SqlStorageValue>;

function toRow(row: Row): ComputerRow {
  return {
    id: String(row.id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    localRoot: String(row.local_root),
    terminalsFolder: String(row.terminals_folder),
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at)
  };
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

  insert(input: { name: string; tokenHash: string }): ComputerRow {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.#db().exec(
      `INSERT INTO pupu_computers
        (id, name, token_hash, local_root, terminals_folder, created_at, revoked_at, last_seen_at)
       VALUES (?, ?, ?, '', '', ?, NULL, NULL)`,
      id,
      input.name,
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
}
