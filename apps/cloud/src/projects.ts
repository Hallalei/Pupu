/**
 * Pupu 自己的数据：项目，和 Pupu 在主对话里提出的「新建项目」建议。
 * 和 pi 共用这个 Durable Object 的 SQLite。pi 的表都带 `pi_` 前缀，这里用 `pupu_`。
 */

export type Project = {
  readonly id: string;
  /** 这个项目对应的 pi 会话 id。 */
  readonly session: string;
  readonly name: string;
  readonly goal: string;
  /** 建项目时从主对话带过去的背景。 */
  readonly background: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ProposalStatus = "pending" | "accepted" | "dismissed";

export type Proposal = {
  /** 就是 Pupu 调用 propose_project 时的 tool call id，界面靠它把卡片和状态对上。 */
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly background: string;
  readonly status: ProposalStatus;
  readonly projectId: string | null;
  readonly createdAt: number;
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

function toProposal(row: Row): Proposal {
  return {
    id: String(row.id),
    name: String(row.name),
    goal: String(row.goal),
    background: String(row.background),
    status: String(row.status) as ProposalStatus,
    projectId: row.project_id === null ? null : String(row.project_id),
    createdAt: Number(row.created_at)
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
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_proposals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        goal TEXT NOT NULL,
        background TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        project_id TEXT,
        created_at INTEGER NOT NULL
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

  /** 同一个 tool call 重放时不会重复插入。 */
  addProposal(input: {
    id: string;
    name: string;
    goal: string;
    background: string;
  }): Proposal {
    this.#db().exec(
      `INSERT OR IGNORE INTO pupu_proposals (id, name, goal, background, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      input.id,
      input.name,
      input.goal,
      input.background,
      Date.now()
    );
    return this.getProposal(input.id)!;
  }

  getProposal(id: string): Proposal | undefined {
    const [row] = this.#db()
      .exec("SELECT * FROM pupu_proposals WHERE id = ?", id)
      .toArray();
    return row ? toProposal(row) : undefined;
  }

  listProposals(): Proposal[] {
    return this.#db()
      .exec("SELECT * FROM pupu_proposals ORDER BY created_at DESC")
      .toArray()
      .map(toProposal);
  }

  setProposal(
    id: string,
    status: ProposalStatus,
    projectId: string | null = null
  ): void {
    this.#db().exec(
      "UPDATE pupu_proposals SET status = ?, project_id = ? WHERE id = ?",
      status,
      projectId,
      id
    );
  }
}
