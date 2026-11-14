import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { mayRead } from "./access.ts";
import { DOC_BODY_LIMIT, docScope, mayPromote, type DocKind, type DocMeta, type DocStore } from "./docs.ts";
import type { Project } from "./projects.ts";
import type { Thread } from "./threads.ts";

function text(value: string) {
  return [{ type: "text" as const, text: value }];
}

function refuse(reason: string) {
  return { output: text(reason), isError: true as const };
}

export const DOC_TOOLS = ["doc_list", "doc_search", "doc_read", "doc_write", "doc_promote"] as const;
/** 协调模式的主会话也能用的：只读的那几个。 */
export const DOC_READ_TOOLS = ["doc_list", "doc_search", "doc_read"] as const;

export type DocActions = {
  readonly docs: DocStore;
  threadOf(session: string): Thread | undefined;
  spaces(): readonly Project[];
  now(): number;
  changed(): void;
};

/**
 * 这条会话能把东西写到哪：写进去的内容来自这条会话，所以目标的受众不能比这条会话宽。
 * `wanted`：undefined 是没指定，null 是组织层，否则是空间 id。
 * - 空间里的会话（主会话、子会话）只写自己的空间，没指定也是。
 * - 大家（全组织）写组织层或全组织档的空间，没指定是组织层。
 * - 个人入口受众只有本人，往哪写都算本人发出去的（协作方案第 2 节第 5 条），只要他读得到那个空间；
 *   但得说清楚存哪，私聊里的东西不默认流到组织层。
 * 返回 undefined 是不能写；null 是组织层。
 */
export function writeTarget(thread: Thread, wanted: string | null | undefined, spaces: readonly Project[]): string | null | undefined {
  if (thread.kind === "project" || thread.kind === "child") {
    return wanted === undefined || wanted === thread.project.id ? thread.project.id : undefined;
  }
  if (wanted === undefined) return thread.kind === "main" ? null : undefined;
  if (wanted === null) return null;
  const spaceId = wanted;
  const space = spaces.find((item) => item.id === spaceId);
  if (!space || !mayRead(thread, space)) return undefined;
  if (thread.kind === "main") return space.level === "L2" || space.level === "L1" ? space.id : undefined;
  return space.id;
}

function line(meta: DocMeta, spaces: readonly Project[]): string {
  const place = meta.spaceId === null ? "组织" : `空间「${spaces.find((space) => space.id === meta.spaceId)?.name ?? "?"}」`;
  const kind = meta.kind === "skill" ? "skill" : "资料";
  return `- ${meta.title}（id: ${meta.id}，${kind}，${place}）${meta.summary ? `：${meta.summary}` : ""}`;
}

export function createDocTools(actions: DocActions): ToolRegistration[] {
  const scopeOf = (session: string) => {
    const thread = actions.threadOf(session);
    return thread ? { thread, scope: docScope(thread, actions.spaces()) } : undefined;
  };

  const list = defineTool({
    name: "doc_list",
    description: "列出这里能看的资料和 skill：组织层的，加上这条会话读得到的空间里的。",
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([Type.Literal("doc"), Type.Literal("skill")], { description: "只要资料（doc）或只要 skill，不填是全部" }))
    }),
    replay: "safe",
    async execute(args, api) {
      const here = scopeOf(String(api.conversationId));
      if (!here) return refuse("这条会话读不了资料。");
      const items = actions.docs.list(here.scope, args.kind as DocKind | undefined);
      const spaces = actions.spaces();
      return {
        output: text(items.length ? items.map((item) => line(item, spaces)).join("\n") : "还没有资料。"),
        details: { count: items.length }
      };
    }
  });

  const search = defineTool({
    name: "doc_search",
    description: "按关键词找资料和 skill（标题、说明、正文）。",
    parameters: Type.Object({ query: Type.String({ description: "关键词" }) }),
    replay: "safe",
    async execute(args, api) {
      const here = scopeOf(String(api.conversationId));
      if (!here) return refuse("这条会话读不了资料。");
      const items = actions.docs.search(here.scope, args.query.trim());
      const spaces = actions.spaces();
      return {
        output: text(items.length ? items.map((item) => line(item, spaces)).join("\n") : `没找到和「${args.query}」有关的资料。`),
        details: { count: items.length }
      };
    }
  });

  const read = defineTool({
    name: "doc_read",
    description: "读一份资料或 skill 的正文。id 来自 doc_list、doc_search 或提示词里的 skill 列表。",
    parameters: Type.Object({ id: Type.String() }),
    replay: "safe",
    async execute(args, api) {
      const here = scopeOf(String(api.conversationId));
      const doc = here ? actions.docs.read(here.scope, args.id) : undefined;
      if (!doc) return refuse(`这里没有 id 为 ${args.id} 的资料。`);
      return {
        output: text(`# ${doc.title}\n${doc.summary ? `${doc.summary}\n` : ""}\n${doc.body}`),
        details: { id: doc.id, title: doc.title, kind: doc.kind }
      };
    }
  });

  const write = defineTool({
    name: "doc_write",
    description:
      "存一份资料或 skill，或者改已有的（给 id）。资料是「是什么」（需求、规格、定下的方案）；skill 是「这件事怎么做」（步骤、口径、格式），存之前先问过人。空间里的会话只存到本空间；大家里默认存到组织层；私聊里要问清楚存到组织层还是哪个空间。",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "要改的资料 id，新建不填" })),
      title: Type.String({ description: "标题，简短" }),
      summary: Type.String({ description: "一句话说明。skill 写清楚什么时候用它" }),
      body: Type.String({ description: "正文，Markdown" }),
      kind: Type.Optional(Type.Union([Type.Literal("doc"), Type.Literal("skill")], { description: "doc 或 skill，默认 doc" })),
      space_id: Type.Optional(Type.String({ description: "存进哪个空间的 id，组织层写 org。空间里不用填；私聊里必须写清楚" }))
    }),
    replay: "safe",
    async execute(args, api) {
      const session = String(api.conversationId);
      const thread = actions.threadOf(session);
      if (!thread) return refuse("这条会话存不了资料。");
      if (args.body.length > DOC_BODY_LIMIT) return refuse(`正文太长了（上限 ${DOC_BODY_LIMIT} 字），分几份存。`);
      const spaces = actions.spaces();
      const existing = args.id ? actions.docs.read(docScope(thread, spaces), args.id) : undefined;
      if (args.id && !existing) return refuse(`这里没有 id 为 ${args.id} 的资料。`);
      const wanted = existing ? existing.spaceId : args.space_id === "org" ? null : args.space_id;
      const target = writeTarget(thread, wanted, spaces);
      if (target === undefined && wanted === undefined) {
        return refuse("私聊里存资料要说清楚存到哪：组织层（space_id 写 org），还是哪个空间。先问用户。");
      }
      if (target === undefined) {
        return refuse("这条会话不能往那里存：存进去的东西会被看不到这里的人看到。空间里只存本空间，私密的空间只在成员自己的 Pupu 里存。");
      }
      const meta = actions.docs.write(
        {
          id: existing?.id,
          spaceId: target,
          kind: args.kind ?? "doc",
          title: args.title.trim() || "没起名的资料",
          summary: args.summary.trim(),
          body: args.body,
          authorId: thread.kind === "private" ? thread.memberId : null,
          fromSession: session,
          operation: `doc_write:${api.callId}`
        },
        actions.now()
      );
      actions.changed();
      return {
        output: text(`存好了：${line(meta, spaces).slice(2)}。用一句话告诉人存在哪了。`),
        details: { id: meta.id, title: meta.title, kind: meta.kind, spaceId: meta.spaceId }
      };
    }
  });

  const promote = defineTool({
    name: "doc_promote",
    description: "把全组织档空间里的一份资料提升到组织层：复制一份到组织，原件留在空间里。私有和机密空间的资料不能提升。",
    parameters: Type.Object({ id: Type.String() }),
    replay: "safe",
    async execute(args, api) {
      const session = String(api.conversationId);
      const here = scopeOf(session);
      const doc = here ? actions.docs.read(here.scope, args.id) : undefined;
      if (!doc) return refuse(`这里没有 id 为 ${args.id} 的资料。`);
      if (doc.spaceId === null) return refuse("它已经在组织层了。");
      const spaces = actions.spaces();
      if (!mayPromote(spaces.find((space) => space.id === doc.spaceId))) {
        return refuse("这个空间不是全组织可见的，里面的资料不能提升到组织层。要提升，先请空间的主人把空间开放给全组织。");
      }
      const meta = actions.docs.write(
        {
          spaceId: null,
          kind: doc.kind,
          title: doc.title,
          summary: doc.summary,
          body: doc.body,
          authorId: doc.authorId,
          fromSession: session,
          copiedFrom: doc.id,
          operation: `doc_promote:${api.callId}`
        },
        actions.now()
      );
      actions.changed();
      return { output: text(`已经提升到组织层：${line(meta, spaces).slice(2)}。`), details: { id: meta.id } };
    }
  });

  return [list, search, read, write, promote];
}
