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
  /** 最新进展一句：Pupu 在这个项目里最后一次回复的第一行。还没回复过是空串。 */
  readonly progress: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type Row = Record<string, SqlStorageValue>;

/** 列表里一行放得下的长度。 */
const PROGRESS_CHARS = 80;

/**
 * Pupu 的一段回复取成「最新进展一句」：代码块和表格以外第一行有字的，去掉 Markdown 的标题、列表、
 * 引用、粗体、行内代码和链接记号，太长就截断。没有字时是空串。
 */
export function progressLine(reply: string): string {
  let fenced = false;
  for (const raw of reply.split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*(\||-{3,}\s*$)/.test(raw)) continue;
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|\*|`)(\S(?:.*?\S)?)\1/g, "$2")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    return line.length > PROGRESS_CHARS ? `${line.slice(0, PROGRESS_CHARS)}…` : line;
  }
  return "";
}

function toProject(row: Row): Project {
  return {
    id: String(row.id),
    session: String(row.session),
    name: String(row.name),
    goal: String(row.goal),
    background: String(row.background),
    progress: String(row.progress ?? ""),
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
        progress TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      // 早先建的表没有 progress 这一列，补上。
      const columns = this.#sql.exec("PRAGMA table_info(pupu_projects)").toArray();
      if (!columns.some((column) => column.name === "progress")) {
        this.#sql.exec("ALTER TABLE pupu_projects ADD COLUMN progress TEXT NOT NULL DEFAULT ''");
      }
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

  /**
   * Pupu 在项目会话里回完一轮时调用：记下最新进展，项目也算刚动过。
   * 不是项目的会话（主对话）返回 false。
   */
  recordReply(session: string, reply: string): boolean {
    const progress = progressLine(reply);
    if (!progress || !this.projectBySession(session)) return false;
    this.#db().exec(
      "UPDATE pupu_projects SET progress = ?, updated_at = ? WHERE session = ?",
      progress,
      Date.now(),
      session
    );
    return true;
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
