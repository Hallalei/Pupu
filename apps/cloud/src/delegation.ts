/**
 * 空间的主会话只做汇报和委派（docs/协作方案.md 第 5 节）：要做的事派给子会话，子会话做完把结果回投到主会话。
 *
 * - 子会话是普通的顶层 pi 会话，和项目会话一样建、一样提交，靠这张表认出它属于哪个空间。只有一层：子会话不能再派。
 * - 主会话能用的工具在 `mayCall` 里写死，`beforeTool` 先过它，被拦的调用不会生成审批卡。
 * - 委派工具都是 `deferred`：默认不给任何会话，空间切成协调模式时才写进主会话的 `modelTools`。
 *   第 4 步起所有空间默认是协调模式，老空间启动时切过去（server.ts 的 `#coordinateSpaces`）。
 */

import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { handoffMessage, noticeMessage } from "./messages.ts";
import type { Project } from "./projects.ts";
import type { Thread } from "./threads.ts";

export type SpaceChild = {
  readonly session: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: number;
  /** 派了活、还没回报的时间。null 是空着。 */
  readonly busySince: number | null;
  /** 最近一次回投给主会话的时间和第一行。还没回投过是 null 和空串。 */
  readonly reportedAt: number | null;
  readonly summary: string;
};

/** 回投到主会话的结果最多这么长，超出的截掉，人可以点进子会话看全文。 */
export const REPORT_LIMIT = 1500;

import { DOC_TOOLS } from "./docs-tools.ts";
import { MEMORY_TOOLS } from "./memory.ts";

export const DELEGATION_TOOLS = ["delegate", "message_child", "list_children", "stop_child"] as const;

/** 协调模式下主会话只能用这些：委派、只读的组织查询，加上资料和记忆（不动电脑，人在空间里说「存一下」「记住」时用得上）。 */
export const COORDINATOR_TOOLS: readonly string[] = [...DELEGATION_TOOLS, "list_projects", ...DOC_TOOLS, ...MEMORY_TOOLS];
/** 这一版协调模式的工具列表。会话里记的和它不一样，启动时重配。 */
export const COORDINATOR_KEY = COORDINATOR_TOOLS.join(",");

type Row = Record<string, SqlStorageValue>;

function toChild(row: Row): SpaceChild {
  return {
    session: String(row.session),
    projectId: String(row.project_id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    busySince: row.busy_since === null ? null : Number(row.busy_since),
    reportedAt: row.reported_at === null || row.reported_at === undefined ? null : Number(row.reported_at),
    summary: String(row.summary ?? "")
  };
}

export class SpaceSessionStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_space_sessions (
        session TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        operation TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        busy_since INTEGER,
        reported_at INTEGER
      )`);
      // 早先建的表没有 summary 这一列，补上。
      const columns = this.#sql.exec("PRAGMA table_info(pupu_space_sessions)").toArray();
      if (!columns.some((column) => column.name === "summary")) {
        this.#sql.exec("ALTER TABLE pupu_space_sessions ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
      }
      this.#ready = true;
    }
    return this.#sql;
  }

  bySession(session: string): SpaceChild | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_space_sessions WHERE session = ?", session).toArray();
    return row ? toChild(row) : undefined;
  }

  byOperation(operation: string): SpaceChild | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_space_sessions WHERE operation = ?", operation).toArray();
    return row ? toChild(row) : undefined;
  }

  ofProject(projectId: string): SpaceChild[] {
    return this.#db()
      .exec("SELECT * FROM pupu_space_sessions WHERE project_id = ? ORDER BY created_at", projectId)
      .toArray()
      .map(toChild);
  }

  /** 这个空间还有子会话没回报。 */
  busy(projectId: string): boolean {
    return (
      this.#db().exec("SELECT 1 FROM pupu_space_sessions WHERE project_id = ? AND busy_since IS NOT NULL LIMIT 1", projectId).toArray()
        .length > 0
    );
  }

  add(input: { session: string; projectId: string; title: string; operation: string }, now: number): SpaceChild {
    this.#db().exec(
      "INSERT OR IGNORE INTO pupu_space_sessions (session, project_id, title, operation, created_at, busy_since) VALUES (?, ?, ?, ?, ?, ?)",
      input.session,
      input.projectId,
      input.title,
      input.operation,
      now,
      now
    );
    return this.bySession(input.session)!;
  }

  markBusy(session: string, now: number): void {
    this.#db().exec("UPDATE pupu_space_sessions SET busy_since = ? WHERE session = ?", now, session);
  }

  /**
   * 子会话回完一轮。`upTo` 是这一轮的提问时间：之后又送去的话（排着队的 message_child）还没做，不算空着。
   * 不给 `upTo` 就是不管排队，直接空出来（停下）。
   */
  markIdle(session: string, upTo = Number.MAX_SAFE_INTEGER): void {
    this.#db().exec(
      "UPDATE pupu_space_sessions SET busy_since = NULL WHERE session = ? AND busy_since <= ?",
      session,
      upTo
    );
  }

  /** 记下回投给主会话的时间和结果第一行（界面上任务卡用）。 */
  markReported(session: string, at: number, summary = ""): void {
    this.#db().exec(
      "UPDATE pupu_space_sessions SET reported_at = ?, summary = ? WHERE session = ?",
      at,
      summary,
      session
    );
  }

  /** 这个空间最近一次有子会话回投的时间。 */
  lastReported(projectId: string): number | null {
    const [row] = this.#db()
      .exec("SELECT MAX(reported_at) AS at FROM pupu_space_sessions WHERE project_id = ?", projectId)
      .toArray();
    return row?.at === null || row?.at === undefined ? null : Number(row.at);
  }
}

/** 这个会话能不能调这个工具。不能就返回拦下的理由。 */
export function mayCall(thread: Thread | undefined, tool: string): { block: string } | undefined {
  if (thread?.kind === "project" && thread.project.mode === "coordinator") {
    return COORDINATOR_TOOLS.includes(tool)
      ? undefined
      : { block: "这里是空间的主会话，只做委派和汇报。用 delegate 把这件事派给子会话去做。" };
  }
  if ((DELEGATION_TOOLS as readonly string[]).includes(tool)) {
    return { block: "只有空间的主会话能派子会话。" };
  }
  return undefined;
}

/**
 * 空间主会话回完一轮（`askedAt` 是这一轮的提问时间）时，从聊天转来的事要不要先别报：
 * - 还有子会话在做；
 * - 或者有子会话的回投晚于这一轮的提问：回投排在后面，主会话还没看到，这一轮说的多半只是「派出去了」。
 * 子会话很快做完、回投先到的时候，只看第一条会漏，所以两条都要。
 */
export function reportsWait(
  thread: Thread | undefined,
  children: Pick<SpaceSessionStore, "busy" | "lastReported">,
  askedAt: number
): boolean {
  if (thread?.kind !== "project") return false;
  if (children.busy(thread.project.id)) return true;
  const reported = children.lastReported(thread.project.id);
  return reported !== null && reported > askedAt;
}

/** 子会话回投给主会话的那条消息。 */
export function childReport(title: string, reply: string): string {
  const text = reply.trim() || "（没有写结果）";
  const cut = text.length > REPORT_LIMIT ? `${text.slice(0, REPORT_LIMIT)}…（太长，截断了，全文在子会话里）` : text;
  return noticeMessage(`子会话「${title}」回报：\n${cut}`);
}

export type DelegationActions = {
  threadOf(session: string): Thread | undefined;
  readonly children: SpaceSessionStore;
  /** 新开一个顶层会话，返回它的 id。 */
  createSession(): Promise<string>;
  /** 往会话里送一条消息，忙着就排在后面。同一个 operationId 只送一次。 */
  submit(session: string, text: string, operationId: string): Promise<void>;
  stop(session: string): Promise<boolean>;
  now(): number;
  changed(): void;
};

function text(value: string) {
  return [{ type: "text" as const, text: value }];
}

function refuse(value: string) {
  return { output: text(value), isError: true as const };
}

/** 主会话的委派工具。`deferred`：只有协调模式的主会话会被提供这些工具。 */
export function createDelegationTools(actions: DelegationActions): ToolRegistration[] {
  const { children } = actions;

  const coordinatorOf = (session: string): Project | undefined => {
    const thread = actions.threadOf(session);
    return thread?.kind === "project" && thread.project.mode === "coordinator" ? thread.project : undefined;
  };

  const childOf = (project: Project, id: string) => {
    const child = children.bySession(id);
    return child && child.projectId === project.id ? child : undefined;
  };

  const delegate = defineTool({
    name: "delegate",
    deferred: true,
    description:
      "把一件事派给一个新的子会话去做。子会话在后台做，你马上可以接着回复；做完它的结果会作为一条消息回到这里。一件事派一次，接着说同一件事用 message_child。",
    parameters: Type.Object({
      title: Type.String({ description: "这件事的名字，简短，比如「定价页移动端排版」" }),
      task: Type.String({ description: "要子会话做的事，写清楚、能独立看懂：目标、要求、用户的原话和链接" })
    }),
    replay: "safe",
    async execute(args, api) {
      const project = coordinatorOf(String(api.conversationId));
      if (!project) return refuse("只有空间的主会话能派子会话。");
      const operation = `delegate:${api.callId}`;
      const child =
        children.byOperation(operation) ??
        children.add(
          { session: await actions.createSession(), projectId: project.id, title: args.title.trim() || "没起名的事", operation },
          actions.now()
        );
      await actions.submit(child.session, handoffMessage(args.task), operation);
      actions.changed();
      return {
        output: text(
          `已经派给子会话「${child.title}」（id: ${child.session}），它在后台做，做完结果会回到这里。用一两句话告诉用户派出去了，不要自己再做一遍。`
        ),
        details: { session: child.session, title: child.title }
      };
    }
  });

  const messageChild = defineTool({
    name: "message_child",
    deferred: true,
    description: "给已有的子会话追加一句话：补充要求、改方向、回答它的问题。它忙着就排在当前这件事后面。",
    parameters: Type.Object({
      child_id: Type.String({ description: "子会话的 id，来自「这个空间的子会话」或 list_children" }),
      message: Type.String({ description: "要对它说的话" })
    }),
    replay: "safe",
    async execute(args, api) {
      const project = coordinatorOf(String(api.conversationId));
      if (!project) return refuse("只有空间的主会话能给子会话发话。");
      const child = childOf(project, args.child_id);
      if (!child) return refuse(`这个空间没有 id 为 ${args.child_id} 的子会话。`);
      children.markBusy(child.session, actions.now());
      await actions.submit(child.session, handoffMessage(args.message), `message_child:${api.callId}`);
      actions.changed();
      return { output: text(`已经告诉「${child.title}」，它回了会报到这里。`), details: { session: child.session } };
    }
  });

  const listChildren = defineTool({
    name: "list_children",
    deferred: true,
    description: "列出这个空间的子会话：名字、id、是不是还在做。",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api) {
      const project = coordinatorOf(String(api.conversationId));
      if (!project) return refuse("只有空间的主会话能看子会话。");
      const list = children.ofProject(project.id);
      const lines = list.map((child) => `- ${child.title}（id: ${child.session}）：${child.busySince === null ? "空着" : "正在做"}`);
      return { output: text(lines.length ? lines.join("\n") : "还没有子会话。"), details: { count: list.length } };
    }
  });

  const stopChild = defineTool({
    name: "stop_child",
    deferred: true,
    description: "停下一个子会话正在做的事。它留着，之后还能接着派活。",
    parameters: Type.Object({ child_id: Type.String({ description: "子会话的 id" }) }),
    replay: "unsafe",
    async execute(args, api) {
      const project = coordinatorOf(String(api.conversationId));
      if (!project) return refuse("只有空间的主会话能停子会话。");
      const child = childOf(project, args.child_id);
      if (!child) return refuse(`这个空间没有 id 为 ${args.child_id} 的子会话。`);
      await actions.stop(child.session);
      children.markIdle(child.session);
      actions.changed();
      return { output: text(`「${child.title}」停下了。`), details: { session: child.session } };
    }
  });

  return [delegate, messageChild, listChildren, stopChild];
}
