import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { DocStore } from "../src/docs.ts";
import { orgOverview, type OrgSources } from "../src/org.ts";
import { ProjectStore, type SpaceWriter } from "../src/projects.ts";
import { MAIN_SESSION, ThreadStore } from "../src/threads.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_800_000_000_000;

function writer(sql: SqlStorage): SpaceWriter {
  const run = async (query: string, ...params: (string | number | null)[]) => sql.exec(query, ...params);
  return { run, transaction: (callback) => callback({ run }) };
}

/** 林夏 m1（私聊 7）、阿周 m2（私聊 8）、小吴 m3（私聊 6）。「周报」L2 会话 9；「定价」L3 会话 10（林夏、阿周）；「体检」L4 会话 11（林夏）。 */
async function org() {
  const sql = sqlStorage();
  const projects = new ProjectStore(sql);
  const threads = new ThreadStore(sql, projects);
  for (const [member, session] of [["m1", "7"], ["m2", "8"], ["m3", "6"]] as const) await threads.ensurePrivateChat(member, async () => session, NOW);
  projects.insertProject({ session: "9", name: "周报", goal: "每周五发", background: "" });
  const l3 = await projects.createSpace(writer(sql), { session: "10", name: "定价", goal: "定新价格", background: "", ownerId: "m1" }, NOW);
  await projects.addMember(writer(sql), l3.id, "m2", "m1", NOW);
  const l4 = await projects.createSpace(writer(sql), { session: "11", name: "体检", goal: "年度体检", background: "", ownerId: "m1" }, NOW);
  await projects.setLevel(writer(sql), l4.id, "L4", NOW);
  const docs = new DocStore(sql);
  docs.write({ spaceId: l3.id, kind: "doc", title: "底价表", summary: "", body: "80", authorId: null, fromSession: null, operation: "a" }, NOW);
  docs.write({ spaceId: null, kind: "skill", title: "报销流程", summary: "", body: "…", authorId: null, fromSession: null, operation: "b" }, NOW);
  const names: Record<string, string> = { m1: "林夏", m2: "阿周", m3: "小吴" };
  const sources: OrgSources = {
    spaces: () => projects.listProjects(),
    children: () => [],
    docs: (scope) => docs.list(scope),
    waiting: () => new Set(),
    nameOf: (id) => names[id] ?? "?",
    now: () => NOW
  };
  return (session: string, query = "") => orgOverview(threads.of(session)!, sources, query);
}

describe("org_overview：只给这条会话的受众都能看的（协作方案第 8 节）", () => {
  test("大家：只有全组织档的空间和组织层资料", async () => {
    const view = await org();
    const text = view(MAIN_SESSION);
    assert.match(text, /周报/);
    assert.doesNotMatch(text, /定价|体检|底价|林夏/);
    assert.match(text, /报销流程/);
  });

  test("个人入口：本人在的 L3 带成员和资料；别人看不到；L4 不跨读", async () => {
    const view = await org();
    assert.match(view("8"), /定价（id: [^，]+，只有成员：林夏、阿周）/);
    assert.match(view("8"), /资料：底价表/);
    assert.doesNotMatch(view("6"), /定价|底价/);
    assert.doesNotMatch(view("7"), /体检/);
  });

  test("L4 空间里只看到自己和全组织档的", async () => {
    const view = await org();
    const text = view("11");
    assert.match(text, /体检（就是这里）/);
    assert.match(text, /周报/);
    assert.doesNotMatch(text, /定价/);
  });

  test("L3 空间里看不到别的私有空间", async () => {
    const view = await org();
    assert.doesNotMatch(view("10"), /体检/);
  });

  test("按关键词找；读不到的空间就算对得上也不出现", async () => {
    const view = await org();
    assert.match(view("8", "底价"), /定价/);
    assert.match(view("6", "底价"), /没有和「底价」有关的空间/);
    assert.match(view(MAIN_SESSION, "体检"), /没有和「体检」有关的空间/);
  });
});
