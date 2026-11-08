/**
 * 一个 pi 会话是什么：主会话（界面上的「大家」）、某个成员的私聊，还是某个项目。
 * 谁能打开、谁看得到、提示词怎么写，都从这里的 `Thread` 判断，别的地方不比较会话 id。
 */

import type { Project, ProjectStore } from "./projects.ts";

/** pi 的根会话，和 agents/harness/pi 的 ROOT_SESSION 是同一个值。写在这里，网页和测试不用引 pi 的服务端代码。 */
export const MAIN_SESSION = "1";

export type Thread =
  | { readonly kind: "main"; readonly session: string }
  | { readonly kind: "private"; readonly session: string; readonly memberId: string }
  | { readonly kind: "project"; readonly session: string; readonly project: Project };

export type ChatThread = Exclude<Thread, { kind: "project" }>;

export type PrivateChatRow = {
  readonly memberId: string;
  readonly session: string;
  /** Pupu 在这条私聊最后回复的时间。还没回过是 null。 */
  readonly lastReplyAt: number | null;
  readonly createdAt: number;
};

/** `/api/state` 的 `chats`。`lastAt` 是 Pupu 最后回复的时间，客户端拿它和本机记的「看过的时间」比。 */
export type ChatLine = { readonly session: string; readonly lastAt: number | null };
export type ChatsView = { readonly main: ChatLine; readonly private: ChatLine | null };

/** 打开这条会话：主会话和项目谁都行，私聊只有本人。没有成员身份的只进得了公开的。查不到的会话不让开。 */
export function mayOpen(thread: Thread | undefined, viewer: string | null): boolean {
  if (!thread) return false;
  return thread.kind !== "private" || thread.memberId === viewer;
}

/**
 * 这个会话里发起的动作（审批卡、「正在做」）给不给 `viewer` 看。公开会话谁都看；私聊发起的只给发起人和批准这一步的人。
 * 说不准是哪个会话的（`thread` 是 undefined）按私聊算，只给批准的人。
 */
export function seesWork(thread: Thread | undefined, viewer: string | null, approver: string | null): boolean {
  if (thread && thread.kind !== "private") return true;
  if (viewer === null) return false;
  return viewer === approver || (thread?.kind === "private" && thread.memberId === viewer);
}

/** `viewer` 看得到哪些调用。`session` 是 null 时说不准是哪个会话的。 */
export function workFilter(
  threads: Pick<ThreadStore, "of">,
  ownerOf: (computerId: string) => string | null,
  viewer: string | null
): (session: string | null, computerId: string) => boolean {
  return (session, computerId) =>
    seesWork(session === null ? undefined : threads.of(session), viewer, ownerOf(computerId));
}

/** 有这条私聊（`own`）的人看得到的聊天：主会话加他自己的私聊。 */
export function chatSessions(own: Pick<PrivateChatRow, "session"> | null | undefined): string[] {
  return own ? [MAIN_SESSION, own.session] : [MAIN_SESSION];
}

type Row = Record<string, SqlStorageValue>;

const MAIN_LAST_REPLY = "main.last_reply_at";

function toRow(row: Row): PrivateChatRow {
  return {
    memberId: String(row.member_id),
    session: String(row.session),
    lastReplyAt: row.last_reply_at === null ? null : Number(row.last_reply_at),
    createdAt: Number(row.created_at)
  };
}

export class ThreadStore {
  readonly #sql: SqlStorage;
  readonly #projects: Pick<ProjectStore, "projectBySession" | "meta" | "setMeta">;
  /** 正在建的私聊。建会话要等，同一个人的两个请求不能各建一个。 */
  readonly #creating = new Map<string, Promise<PrivateChatRow>>();
  #ready = false;

  constructor(sql: SqlStorage, projects: Pick<ProjectStore, "projectBySession" | "meta" | "setMeta">) {
    this.#sql = sql;
    this.#projects = projects;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_private_chats (
        member_id TEXT PRIMARY KEY,
        session TEXT NOT NULL UNIQUE,
        last_reply_at INTEGER,
        created_at INTEGER NOT NULL
      )`);
      this.#ready = true;
    }
    return this.#sql;
  }

  of(session: string): Thread | undefined {
    if (session === MAIN_SESSION) return { kind: "main", session };
    const [row] = this.#db().exec("SELECT member_id FROM pupu_private_chats WHERE session = ?", session).toArray();
    if (row) return { kind: "private", session, memberId: String(row.member_id) };
    const project = this.#projects.projectBySession(session);
    return project ? { kind: "project", session, project } : undefined;
  }

  byMember(memberId: string): PrivateChatRow | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_private_chats WHERE member_id = ?", memberId).toArray();
    return row ? toRow(row) : undefined;
  }

  /** 这个成员的私聊，没有就建一个。`create` 新开一个 pi 会话，返回它的 id。成员被移除后映射留着，那条私聊谁也打不开。 */
  ensurePrivateChat(memberId: string, create: () => Promise<string>, now: number): Promise<PrivateChatRow> {
    const known = this.byMember(memberId);
    if (known) return Promise.resolve(known);
    const running = this.#creating.get(memberId);
    if (running) return running;
    const creating = create()
      .then((session) => {
        this.#db().exec(
          "INSERT OR IGNORE INTO pupu_private_chats (member_id, session, created_at) VALUES (?, ?, ?)",
          memberId,
          session,
          now
        );
        const row = this.byMember(memberId);
        if (!row) throw new Error("私聊没有写进去");
        return row;
      })
      .finally(() => this.#creating.delete(memberId));
    this.#creating.set(memberId, creating);
    return creating;
  }

  recordReply(thread: ChatThread, at: number): void {
    if (thread.kind === "main") {
      this.#projects.setMeta(MAIN_LAST_REPLY, String(at));
      return;
    }
    this.#db().exec("UPDATE pupu_private_chats SET last_reply_at = ? WHERE session = ?", at, thread.session);
  }

  chats(own: PrivateChatRow | null): ChatsView {
    const main = this.#projects.meta(MAIN_LAST_REPLY);
    return {
      main: { session: MAIN_SESSION, lastAt: main === undefined ? null : Number(main) },
      private: own && { session: own.session, lastAt: own.lastReplyAt }
    };
  }
}
