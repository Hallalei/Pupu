/**
 * 最基础的记忆：「记住一句话」（协作方案第 9.2 节）。
 *
 * - 三层，和受众对得上：个人（只装进本人的个人入口）、空间（装进这个空间的会话）、组织（全员，按 L2，装进所有会话）。
 * - 每条很短，每层有字数上限，满了让 Pupu 把几条合并。不做检索：每一轮全量装进上下文。
 * - 装在最新一条用户消息里（接在原文后面），不进系统提示，记忆一变不至于让整段缓存失效。
 *   接在后面而不是前面：转交、回报这些消息靠开头的标记认出来。
 * - 改和删都是把旧的标 `ended_at`，不真删。
 */

import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isOpen } from "./access.ts";
import type { Thread } from "./threads.ts";

export type MemoryLayer = "me" | "space" | "org";

export type Memory = {
  readonly id: string;
  readonly layer: MemoryLayer;
  /** 个人层是成员 id，空间层是空间 id，组织层是空串。 */
  readonly owner: string;
  readonly text: string;
  readonly createdAt: number;
};

/** 一条最多这么长。 */
export const MEMORY_ITEM_LIMIT = 200;
/** 一层（一个人、一个空间、组织）加起来最多这么长。 */
export const MEMORY_LAYER_LIMIT = 1200;

export const MEMORY_TOOLS = ["remember", "forget"] as const;

/** 一层里的一处：哪层、属于谁。 */
type Slot = { readonly layer: MemoryLayer; readonly owner: string };

const LAYER_NAMES: Record<MemoryLayer, string> = { me: "个人", space: "这个空间", org: "组织" };

/** 这条会话每一轮装进哪几处。个人层只在本人的个人入口；空间层只在这个空间的会话。 */
export function memorySlots(thread: Thread): Slot[] {
  const org: Slot = { layer: "org", owner: "" };
  switch (thread.kind) {
    case "private":
      return [{ layer: "me", owner: thread.memberId }, org];
    case "project":
    case "child":
      return [{ layer: "space", owner: thread.project.id }, org];
    case "main":
      return [org];
  }
}

/**
 * 这条会话能往哪一层记。记下的话来自这条会话，目标的受众不能比它宽：
 * - 个人层只在个人入口记；空间层只在空间的会话里记；
 * - 组织层：大家、个人入口（本人说的，算他发出去的）、全组织档空间里能记；私有和机密空间里不能。
 */
export function memoryTarget(thread: Thread, layer: MemoryLayer): Slot | undefined {
  if (layer === "me") return thread.kind === "private" ? { layer, owner: thread.memberId } : undefined;
  if (layer === "space") return thread.kind === "project" || thread.kind === "child" ? { layer, owner: thread.project.id } : undefined;
  if (thread.kind === "project" || thread.kind === "child") return isOpen(thread.project.level) ? { layer, owner: "" } : undefined;
  return { layer, owner: "" };
}

type Row = Record<string, SqlStorageValue>;

function toMemory(row: Row): Memory {
  return {
    id: String(row.id),
    layer: row.layer === "me" || row.layer === "space" ? row.layer : "org",
    owner: String(row.owner ?? ""),
    text: String(row.text),
    createdAt: Number(row.created_at)
  };
}

export class MemoryStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_memories (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        owner TEXT NOT NULL,
        text TEXT NOT NULL,
        from_session TEXT,
        operation TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        ended_at INTEGER
      )`);
      this.#sql.exec("CREATE INDEX IF NOT EXISTS pupu_memories_slot ON pupu_memories (layer, owner, ended_at)");
      this.#ready = true;
    }
    return this.#sql;
  }

  /** 一处现有的记忆，先记的在前。 */
  list(slot: Slot): Memory[] {
    return this.#db()
      .exec("SELECT * FROM pupu_memories WHERE layer = ? AND owner = ? AND ended_at IS NULL ORDER BY created_at, id", slot.layer, slot.owner)
      .toArray()
      .map(toMemory);
  }

  get(id: string): Memory | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_memories WHERE id = ? AND ended_at IS NULL", id).toArray();
    return row ? toMemory(row) : undefined;
  }

  /**
   * 记一条。`replace` 给了就是把那几条换成这一条（合并、改正）。超过这一层的上限返回 "full"，什么都不改。
   * `operation` 去重：同一次工具调用重放不多记。
   */
  remember(
    input: { slot: Slot; text: string; replace: readonly string[]; fromSession: string; operation: string },
    now: number
  ): Memory | "full" {
    const db = this.#db();
    const [done] = db.exec("SELECT * FROM pupu_memories WHERE operation = ?", input.operation).toArray();
    if (done) return toMemory(done);
    const kept = this.list(input.slot).filter((item) => !input.replace.includes(item.id));
    const used = kept.reduce((sum, item) => sum + item.text.length, 0);
    if (used + input.text.length > MEMORY_LAYER_LIMIT) return "full";
    for (const id of input.replace) db.exec("UPDATE pupu_memories SET ended_at = ? WHERE id = ? AND ended_at IS NULL", now, id);
    const id = crypto.randomUUID().slice(0, 8);
    db.exec(
      "INSERT INTO pupu_memories (id, layer, owner, text, from_session, operation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      input.slot.layer,
      input.slot.owner,
      input.text,
      input.fromSession,
      input.operation,
      now
    );
    return this.get(id)!;
  }

  forget(id: string, now: number): boolean {
    return this.#db().exec("UPDATE pupu_memories SET ended_at = ? WHERE id = ? AND ended_at IS NULL", now, id).rowsWritten > 0;
  }
}

/** 每一轮装进上下文的那段。没有记忆是 undefined。 */
export function memoryBlock(thread: Thread, store: MemoryStore): string | undefined {
  const sections = memorySlots(thread).flatMap((slot) => {
    const items = store.list(slot);
    return items.length ? [`${LAYER_NAMES[slot.layer]}：\n${items.map((item) => `- ${item.text}（id: ${item.id}）`).join("\n")}`] : [];
  });
  if (!sections.length) return undefined;
  return `[[pupu:memory]]\n记住的事，每一轮都带着。人说不对就用 remember 的 replace 改掉，用 forget 删：\n${sections.join("\n")}\n[[/pupu:memory]]`;
}

/**
 * 把记忆接在这一次请求里最后一条用户消息的后面。只改这次请求的副本，不写进会话记录；
 * 不另加一条消息，免得出现连着两条用户消息。
 */
export function withMemory(messages: readonly Message[], block: string | undefined): readonly Message[] | undefined {
  if (!block) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const content =
      typeof message.content === "string"
        ? `${message.content}\n\n${block}`
        : [...message.content, { type: "text" as const, text: `\n\n${block}` }];
    const next = [...messages];
    next[index] = { ...message, content } as Message;
    return next;
  }
  return undefined;
}

export type MemoryActions = {
  readonly memories: MemoryStore;
  threadOf(session: string): Thread | undefined;
  now(): number;
};

function text(value: string) {
  return [{ type: "text" as const, text: value }];
}

function refuse(reason: string) {
  return { output: text(reason), isError: true as const };
}

export function createMemoryTools(actions: MemoryActions): ToolRegistration[] {
  /** 这条会话能动的一条：在它装得进的地方，而且是它能往那一层记的。 */
  const mine = (thread: Thread, id: string) => {
    const item = actions.memories.get(id);
    if (!item) return undefined;
    const target = memoryTarget(thread, item.layer);
    return target && target.owner === item.owner ? item : undefined;
  };

  const remember = defineTool({
    name: "remember",
    description:
      "记住一句以后每次都用得上的话：偏好、分工、定下的规矩。人说「记住……」时用；自己判断值得记时也可以。要短，一条一件事。" +
      "层：me 是关于这个人的（只在他自己的 Pupu 里）；space 是这个空间定下的事；org 是全员都该知道的。" +
      "人说记错了，用 replace 给出要换掉的 id。这一层满了就把几条合并成一条再记。",
    parameters: Type.Object({
      text: Type.String({ description: `要记的话，不超过 ${MEMORY_ITEM_LIMIT} 字` }),
      layer: Type.Union([Type.Literal("me"), Type.Literal("space"), Type.Literal("org")], { description: "记在哪层" }),
      replace: Type.Optional(Type.Array(Type.String(), { description: "要换掉的记忆 id，改正或合并时给" }))
    }),
    replay: "safe",
    async execute(args, api) {
      const session = String(api.conversationId);
      const thread = actions.threadOf(session);
      if (!thread) return refuse("这条会话记不了东西。");
      // 一条一行：换行和 Pupu 的标记去掉，免得一条记忆冒充别的条目或者提前收尾。
      const value = args.text.replace(/\[\[\/?pupu:[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim();
      if (!value) return refuse("要记的话是空的。");
      if (value.length > MEMORY_ITEM_LIMIT) return refuse(`太长了，一条不超过 ${MEMORY_ITEM_LIMIT} 字，缩短或者存成资料。`);
      const slot = memoryTarget(thread, args.layer);
      if (!slot) {
        return refuse(
          args.layer === "me"
            ? "个人的事只能在他自己的 Pupu 里记。"
            : args.layer === "space"
              ? "这里不是空间，没有空间这一层。用 org 或 me。"
              : "这个空间不是全组织可见的，这里说的事不能记到组织层，记到 space。"
        );
      }
      const replace = args.replace ?? [];
      for (const id of replace) {
        const item = mine(thread, id);
        if (!item || item.layer !== slot.layer || item.owner !== slot.owner) return refuse(`这里没有 id 为 ${id} 的记忆可以换。`);
      }
      const saved = actions.memories.remember(
        { slot, text: value, replace, fromSession: session, operation: `remember:${session}:${api.callId}` },
        actions.now()
      );
      if (saved === "full") {
        return refuse(`「${LAYER_NAMES[slot.layer]}」这一层满了（上限 ${MEMORY_LAYER_LIMIT} 字）。先用 replace 把几条合并成一条，再记。`);
      }
      return {
        output: text(`记好了（${LAYER_NAMES[slot.layer]}，id: ${saved.id}）。在回复里单独写一行「已记住：${saved.text}」，人看到不对能马上改。`),
        details: { id: saved.id, layer: saved.layer, text: saved.text }
      };
    }
  });

  const forget = defineTool({
    name: "forget",
    description: "删掉一条记忆。人说「别记这个」「这条不对，删了」时用。",
    parameters: Type.Object({ id: Type.String() }),
    replay: "safe",
    async execute(args, api) {
      const thread = actions.threadOf(String(api.conversationId));
      const item = thread ? mine(thread, args.id) : undefined;
      if (!item) return refuse(`这里没有 id 为 ${args.id} 的记忆。`);
      actions.memories.forget(item.id, actions.now());
      return { output: text(`删了：${item.text}。在回复里说一声。`), details: { id: item.id } };
    }
  });

  return [remember, forget];
}
