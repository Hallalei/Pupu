/**
 * 一个 pi 会话是什么：主会话（界面上的「大家」）、某个成员的私聊，还是某个项目。
 * 谁能打开、谁看得到、提示词怎么写，都从这里的 `Thread` 判断，别的地方不比较会话 id。
 */

import { seesWork } from "./access.ts";
import type { Project, ProjectStore } from "./projects.ts";

/** pi 的根会话，和 agents/harness/pi 的 ROOT_SESSION 是同一个值。写在这里，网页和测试不用引 pi 的服务端代码。 */
export const MAIN_SESSION = "1";

export type Thread =
  | { readonly kind: "main"; readonly session: string }
  | { readonly kind: "private"; readonly session: string; readonly memberId: string }
  | { readonly kind: "project"; readonly session: string; readonly project: Project }
  /** 空间的子会话：主会话派来的一件事，见 delegation.ts。受众和它的空间一样。 */
  | { readonly kind: "child"; readonly session: string; readonly project: Project; readonly title: string };

export type ChatThread = Exclude<Thread, { kind: "project" | "child" }>;

/** 子会话属于哪个空间。 */
export type ChildLookup = (session: string) => { readonly project: Project; readonly title: string } | undefined;

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

export { mayOpen, seesWork } from "./access.ts";

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
  readonly #childOf: ChildLookup;
  /** 正在建的私聊。建会话要等，同一个人的两个请求不能各建一个。 */
  readonly #creating = new Map<string, Promise<PrivateChatRow>>();
  #ready = false;

  constructor(
    sql: SqlStorage,
    projects: Pick<ProjectStore, "projectBySession" | "meta" | "setMeta">,
    childOf: ChildLookup = () => undefined
  ) {
    this.#sql = sql;
    this.#projects = projects;
    this.#childOf = childOf;
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
    if (project) return { kind: "project", session, project };
    const child = this.#childOf(session);
    return child ? { kind: "child", session, project: child.project, title: child.title } : undefined;
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
