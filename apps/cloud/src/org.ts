/**
 * 组织大脑的第一块：`org_overview`（协作方案第 7 节第 5 步）。
 *
 * 只读，给 Pupu 看组织里在发生什么，好判断一件事该交给哪个空间、要不要建新空间。
 * 背后没有一份混在一起的全组织总结：每次按这条会话的受众现查，读不到的空间不出现，连数量也不透露。
 */

import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { mayRead } from "./access.ts";
import type { SpaceChild } from "./delegation.ts";
import type { DocMeta } from "./docs.ts";
import { docScope } from "./docs.ts";
import type { Project } from "./projects.ts";
import type { Thread } from "./threads.ts";

export type OrgSources = {
  spaces(): readonly Project[];
  children(projectId: string): readonly SpaceChild[];
  /** 这条会话读得到的资料。 */
  docs(scope: ReturnType<typeof docScope>): readonly DocMeta[];
  /** 有电脑动作在等批准的会话。 */
  waiting(): ReadonlySet<string>;
  nameOf(memberId: string): string;
  now(): number;
};

const LEVEL_NAMES: Record<string, string> = { L1: "对外", L2: "全组织", L3: "只有成员", L4: "机密" };

function since(now: number, at: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/** 一个空间一段。只用调用者读得到的东西。 */
function describe(space: Project, sources: OrgSources, docs: readonly DocMeta[], here: string | undefined): string {
  const children = sources.children(space.id);
  const waiting = sources.waiting();
  const working = children.filter((child) => child.busySince !== null).length;
  const asking = children.filter((child) => waiting.has(child.session)).length + (waiting.has(space.session) ? 1 : 0);
  const people = space.level === "L3" || space.level === "L4" ? `：${space.members.map((id) => sources.nameOf(id)).join("、") || "还没有人"}` : "";
  const ownDocs = docs.filter((doc) => doc.spaceId === space.id);
  const lines = [
    `- ${space.name}${space.id === here ? "（就是这里）" : ""}（id: ${space.id}，${LEVEL_NAMES[space.level] ?? space.level}${people}）`,
    space.goal ? `  目标：${space.goal}` : "",
    space.progress ? `  最新：${space.progress}` : "",
    working || asking ? `  在做：${[working ? `${working} 件事在做` : "", asking ? `${asking} 处等批准` : ""].filter(Boolean).join("，")}` : "",
    children.length ? `  子会话：${children.slice(0, 5).map((child) => child.title).join("、")}${children.length > 5 ? " 等" : ""}` : "",
    ownDocs.length ? `  资料：${ownDocs.slice(0, 5).map((doc) => doc.title).join("、")}${ownDocs.length > 5 ? ` 等 ${ownDocs.length} 份` : ""}` : "",
    `  最近动过：${since(sources.now(), space.updatedAt)}`
  ];
  return lines.filter(Boolean).join("\n");
}

function matches(space: Project, docs: readonly DocMeta[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [space.name, space.goal, space.progress, ...docs.filter((doc) => doc.spaceId === space.id).map((doc) => `${doc.title} ${doc.summary}`)]
    .join(" ")
    .toLowerCase();
  return words.some((word) => hay.includes(word));
}

/** 这条会话看到的组织概况。 */
export function orgOverview(thread: Thread, sources: OrgSources, query = ""): string {
  const all = sources.spaces();
  const readable = all.filter((space) => mayRead(thread, space));
  const docs = sources.docs(docScope(thread, all));
  const here = thread.kind === "project" || thread.kind === "child" ? thread.project.id : undefined;
  const picked = readable.filter((space) => matches(space, docs, query)).sort((a, b) => b.updatedAt - a.updatedAt);
  const orgDocs = docs.filter((doc) => doc.spaceId === null);
  const head = query.trim()
    ? picked.length
      ? `和「${query.trim()}」有关的空间：`
      : `没有和「${query.trim()}」有关的空间。这件事要持续推进的话，可以问人要不要建一个新空间。`
    : readable.length
      ? "这里看得到的空间（最近动过的在前）："
      : "这里还看不到任何空间。";
  const tail = orgDocs.length ? `\n\n组织层的资料和 skill：${orgDocs.slice(0, 8).map((doc) => doc.title).join("、")}${orgDocs.length > 8 ? " 等" : ""}` : "";
  return `${head}\n${picked.slice(0, 20).map((space) => describe(space, sources, docs, here)).join("\n")}${tail}`.trim();
}

export function createOrgTools(sources: OrgSources & { threadOf(session: string): Thread | undefined }): ToolRegistration[] {
  const overview = defineTool({
    name: "org_overview",
    description:
      "看组织里在发生什么：这里看得到的每个空间的目标、最新进展、谁在里面、在做的事、资料。一件事不确定该交给哪个空间、要不要建新空间时，先用它看一眼。给 query 只看相关的。",
    parameters: Type.Object({ query: Type.Optional(Type.String({ description: "关键词，空格隔开，比如「定价 官网」" })) }),
    replay: "safe",
    async execute(args, api) {
      const thread = sources.threadOf(String(api.conversationId));
      if (!thread) return { output: [{ type: "text" as const, text: "这条会话看不了组织概况。" }], isError: true as const };
      return { output: [{ type: "text" as const, text: orgOverview(thread, sources, args.query ?? "") }], details: {} };
    }
  });
  return [overview];
}
