/**
 * Pupu 自己的数据：项目，以及零散的设置。
 * 和 pi 共用这个 Durable Object 的 SQLite。pi 的表都带 `pi_` 前缀，这里用 `pupu_`。
 */

export type Project = {
  readonly id: string;
  /** 这个项目对应的 pi 会话 id。 */
  readonly session: string;
  readonly name: string;
  readonly goal: string;
  /** 建项目时从聊天带过去的背景。 */
  readonly background: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type Row = Record<string, SqlStorageValue>;

function toProject(row: Row): Project {
  return {
    id: String(row.id),
    session: String(row.session),
    name: String(row.name),
    goal: String(row.goal),
    background: String(row.background),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

export class ProjectStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_projects (
        id TEXT PRIMARY KEY,
        session TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        goal TEXT NOT NULL,
        background TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
      this.#ready = true;
    }
    return this.#sql;
  }

  /** 零散的设置，比如当前用的模型。 */
  meta(key: string): string | undefined {
    const [row] = this.#db()
      .exec("SELECT value FROM pupu_meta WHERE key = ?", key)
      .toArray();
    return row ? String(row.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.#db().exec(
      "INSERT INTO pupu_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  listProjects(): Project[] {
    return this.#db()
      .exec("SELECT * FROM pupu_projects ORDER BY updated_at DESC")
      .toArray()
      .map(toProject);
  }

  getProject(id: string): Project | undefined {
    const [row] = this.#db()
      .exec("SELECT * FROM pupu_projects WHERE id = ?", id)
      .toArray();
    return row ? toProject(row) : undefined;
  }

  projectBySession(session: string): Project | undefined {
    const [row] = this.#db()
      .exec("SELECT * FROM pupu_projects WHERE session = ?", session)
      .toArray();
    return row ? toProject(row) : undefined;
  }

  insertProject(input: {
    session: string;
    name: string;
    goal: string;
    background: string;
  }): Project {
    const now = Date.now();
    const id = crypto.randomUUID();
    this.#db().exec(
      `INSERT INTO pupu_projects (id, session, name, goal, background, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.session,
      input.name,
      input.goal,
      input.background,
      now,
      now
    );
    return this.getProject(id)!;
  }

  /** 项目会话里有新消息时调用，项目列表按最近活跃排序。 */
  touchSession(session: string): void {
    this.#db().exec(
      "UPDATE pupu_projects SET updated_at = ? WHERE session = ?",
      Date.now(),
      session
    );
  }
}
