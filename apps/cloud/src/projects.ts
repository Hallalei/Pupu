/**
 * Pupu 自己的数据：项目，以及零散的设置。
 * 和 pi 共用这个 Durable Object 的 SQLite。pi 的表都带 `pi_` 前缀，这里用 `pupu_`。
 *
 * 项目就是协作方案里的「空间」：带密级（见 access.ts）和成员。早先的项目都是 L2，全组织可见。
 */

import type { Level } from "./access.ts";

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
  /** 密级，见 access.ts。 */
  readonly level: Level;
  /** 建这个空间的成员。早先的项目和本机开发建的没有。 */
  readonly ownerId: string | null;
  /** 空间成员。L2、L1 全组织可见，这张名单只在 L3、L4 决定谁能看。 */
  readonly members: readonly string[];
  /** `direct`：主会话自己动手，和以前的项目一样。`coordinator`：主会话只委派和汇报，见 delegation.ts。 */
  readonly mode: SpaceMode;
};

export type SpaceMode = "direct" | "coordinator";

/**
 * 「全员」空间：原来的「大家」，会话还是 root。不在 pupu_projects 表里，全组织档、没有主人，
 * 模式存在 pupu_meta（默认自己动手）。`getProject(EVERYONE_ID)` 拿得到它，`listProjects()` 里没有。
 */
export const EVERYONE_ID = "everyone";
const EVERYONE_SESSION = "1";
const EVERYONE_MODE_META = "everyone-mode";

export function everyoneSpace(mode: SpaceMode): Project {
  return {
    id: EVERYONE_ID,
    session: EVERYONE_SESSION,
    name: "全员",
    goal: "",
    background: "",
    progress: "",
    createdAt: 0,
    updatedAt: 0,
    level: "L2",
    ownerId: null,
    members: [],
    mode
  };
}

/** 写空间的密级和成员，走 pi 的同一个写队列（`DurableObjectSqliteDatabase`），不会被卷进 pi 正开着的事务。 */
type SpaceValue = string | number | null;

export type SpaceWriter = {
  run(sql: string, ...params: SpaceValue[]): Promise<unknown>;
  transaction<T>(callback: (tx: { run(sql: string, ...params: SpaceValue[]): Promise<unknown> }) => Promise<T>): Promise<T>;
};

const LEVELS: readonly Level[] = ["L1", "L2", "L3", "L4"];

function levelOf(value: SqlStorageValue): Level {
  return LEVELS.find((level) => level === value) ?? "L2";
}

/** 每行带上成员名单，逗号分隔。 */
const SELECT_PROJECTS = `SELECT p.*, (SELECT group_concat(member_id) FROM pupu_project_members m WHERE m.project_id = p.id) AS members
  FROM pupu_projects p`;

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
    updatedAt: Number(row.updated_at),
    level: levelOf(row.level ?? null),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    members: row.members ? String(row.members).split(",").sort() : [],
    mode: row.mode === "coordinator" ? "coordinator" : "direct"
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
      // 协作版：项目成了空间，补上密级和主人。老项目都是 L2，和原来一样全组织可见。
      if (!columns.some((column) => column.name === "level")) {
        this.#sql.exec("ALTER TABLE pupu_projects ADD COLUMN level TEXT NOT NULL DEFAULT 'L2'");
      }
      if (!columns.some((column) => column.name === "owner_id")) {
        this.#sql.exec("ALTER TABLE pupu_projects ADD COLUMN owner_id TEXT");
      }
      if (!columns.some((column) => column.name === "mode")) {
        this.#sql.exec("ALTER TABLE pupu_projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'direct'");
      }
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_project_members (
        project_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        added_by TEXT,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, member_id)
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
      .exec(`${SELECT_PROJECTS} ORDER BY p.updated_at DESC`)
      .toArray()
      .map(toProject);
  }

  /** 全员空间，模式是现在存着的。 */
  everyone(): Project {
    return everyoneSpace(this.meta(EVERYONE_MODE_META) === "coordinator" ? "coordinator" : "direct");
  }

  setEveryoneMode(mode: SpaceMode): void {
    this.setMeta(EVERYONE_MODE_META, mode);
  }

  getProject(id: string): Project | undefined {
    if (id === EVERYONE_ID) return this.everyone();
    const [row] = this.#db()
      .exec(`${SELECT_PROJECTS} WHERE p.id = ?`, id)
      .toArray();
    return row ? toProject(row) : undefined;
  }

  projectBySession(session: string): Project | undefined {
    const [row] = this.#db()
      .exec(`${SELECT_PROJECTS} WHERE p.session = ?`, session)
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

  /**
   * 建一个 L3 空间：只有建的人和 Pupu。会话要先建好。
   * 第一步只写好、测好，还没有接到任何工具和接口上（协作方案第 7 节：上线后先不能有 L3 空间）。
   */
  async createSpace(
    writer: SpaceWriter,
    input: { session: string; name: string; goal: string; background: string; ownerId: string },
    now: number
  ): Promise<Project> {
    this.#db();
    const id = crypto.randomUUID();
    await writer.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO pupu_projects (id, session, name, goal, background, created_at, updated_at, level, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'L3', ?)`,
        id,
        input.session,
        input.name,
        input.goal,
        input.background,
        now,
        now,
        input.ownerId
      );
      await tx.run(
        "INSERT INTO pupu_project_members (project_id, member_id, added_by, added_at) VALUES (?, ?, ?, ?)",
        id,
        input.ownerId,
        input.ownerId,
        now
      );
    });
    return this.getProject(id)!;
  }

  /** 拉一个组织成员进空间。已经在里面就什么都不做。 */
  async addMember(writer: SpaceWriter, projectId: string, memberId: string, by: string, now: number): Promise<void> {
    this.#db();
    await writer.run(
      "INSERT OR IGNORE INTO pupu_project_members (project_id, member_id, added_by, added_at) VALUES (?, ?, ?, ?)",
      projectId,
      memberId,
      by,
      now
    );
  }

  async removeMember(writer: SpaceWriter, projectId: string, memberId: string): Promise<void> {
    this.#db();
    await writer.run("DELETE FROM pupu_project_members WHERE project_id = ? AND member_id = ?", projectId, memberId);
  }

  async setLevel(writer: SpaceWriter, projectId: string, level: Level, now: number): Promise<void> {
    this.#db();
    await writer.run("UPDATE pupu_projects SET level = ?, updated_at = ? WHERE id = ?", level, now, projectId);
  }

  /** 切换主会话的模式。这一版没有接到任何入口。 */
  async setMode(writer: SpaceWriter, projectId: string, mode: SpaceMode, now: number): Promise<void> {
    this.#db();
    await writer.run("UPDATE pupu_projects SET mode = ?, updated_at = ? WHERE id = ?", mode, now, projectId);
  }
}
