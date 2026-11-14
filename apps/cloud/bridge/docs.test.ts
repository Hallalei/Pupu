import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { DocStore, docScope, viewerScope, viewerTarget } from "../src/docs.ts";
import { createDocTools, writeTarget } from "../src/docs-tools.ts";
import { ProjectStore, type SpaceWriter } from "../src/projects.ts";
import { renderPrompt } from "../src/prompt.ts";
import { ReportStore } from "../src/reports.ts";
import { MAIN_SESSION, ThreadStore } from "../src/threads.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_800_000_000_000;

function writer(sql: SqlStorage): SpaceWriter {
  const run = async (query: string, ...params: (string | number | null)[]) => sql.exec(query, ...params);
  return { run, transaction: (callback) => callback({ run }) };
}

/**
 * 林夏 m1（私聊 7）、阿周 m2（私聊 8）、小吴 m3（私聊 6）。
 * 「周报」L2 会话 9；林夏和阿周的 L3「定价」会话 10；林夏一个人的 L4「体检」会话 11。
 */
async function org() {
  const sql = sqlStorage();
  const projects = new ProjectStore(sql);
  const threads = new ThreadStore(sql, projects);
  for (const [member, session] of [["m1", "7"], ["m2", "8"], ["m3", "6"]] as const) {
    await threads.ensurePrivateChat(member, async () => session, NOW);
  }
  const open = projects.insertProject({ session: "9", name: "周报", goal: "", background: "" });
  const l3 = await projects.createSpace(writer(sql), { session: "10", name: "定价", goal: "", background: "", ownerId: "m1" }, NOW);
  await projects.addMember(writer(sql), l3.id, "m2", "m1", NOW);
  const l4 = await projects.createSpace(writer(sql), { session: "11", name: "体检", goal: "", background: "", ownerId: "m1" }, NOW);
  await projects.setLevel(writer(sql), l4.id, "L4", NOW);
  const docs = new DocStore(sql);
  const put = (spaceId: string | null, title: string, kind: "doc" | "skill" = "doc") =>
    docs.write({ spaceId, kind, title, summary: `${title}的说明`, body: `${title}正文`, authorId: null, fromSession: null, operation: `seed:${title}` }, NOW);
  const ids = {
    org: put(null, "公司手册").id,
    open: put(open.id, "周报格式", "skill").id,
    l3: put(l3.id, "定价草案").id,
    l4: put(l4.id, "体检报告").id
  };
  return { sql, projects, threads, docs, ids, open, l3: projects.getProject(l3.id)!, l4: projects.getProject(l4.id)! };
}

function tools(pupu: Awaited<ReturnType<typeof org>>) {
  const list = createDocTools({
    docs: pupu.docs,
    threadOf: (session) => pupu.threads.of(session),
    spaces: () => pupu.projects.listProjects(),
    now: () => NOW + 1,
    changed: () => {}
  });
  let call = 0;
  return async (name: string, args: unknown, session: string) => {
    const tool = list.find((each) => each.name === name) as unknown as {
      execute(args: unknown, api: unknown): Promise<{ output: { text: string }[]; isError?: boolean; details?: Record<string, unknown> }>;
    };
    const result = await tool.execute(args, { conversationId: session, callId: `call-${++call}` });
    return { ...result, text: result.output[0]!.text };
  };
}

describe("资料：谁读得到（协作方案第 4 节、第 8 节）", () => {
  const titles = (pupu: Awaited<ReturnType<typeof org>>, session: string) =>
    pupu.docs
      .list(docScope(pupu.threads.of(session)!, pupu.projects.listProjects()))
      .map((doc) => doc.title)
      .sort();

  test("大家：组织层和全组织档空间", async () => {
    const pupu = await org();
    assert.deepEqual(titles(pupu, MAIN_SESSION), ["公司手册", "周报格式"]);
  });

  test("个人入口：加上本人在的 L3；L4 不跨读", async () => {
    const pupu = await org();
    assert.deepEqual(titles(pupu, "7"), ["公司手册", "周报格式", "定价草案"]);
    assert.deepEqual(titles(pupu, "8"), ["公司手册", "周报格式", "定价草案"]);
    assert.deepEqual(titles(pupu, "6"), ["公司手册", "周报格式"]);
  });

  test("空间会话：本空间、组织层和全组织档，别的 L3、L4 读不到", async () => {
    const pupu = await org();
    assert.deepEqual(titles(pupu, "10"), ["公司手册", "周报格式", "定价草案"]);
    assert.deepEqual(titles(pupu, "11"), ["体检报告", "公司手册", "周报格式"].sort());
    assert.deepEqual(titles(pupu, "9"), ["公司手册", "周报格式"]);
  });

  test("空间收窄以后，大家里马上读不到", async () => {
    const pupu = await org();
    await pupu.projects.setLevel(writer(pupu.sql), pupu.open.id, "L3", NOW);
    assert.deepEqual(titles(pupu, MAIN_SESSION), ["公司手册"]);
  });

  test("工具：读不到的和不存在一样，搜也搜不出来", async () => {
    const pupu = await org();
    const run = tools(pupu);
    const denied = await run("doc_read", { id: pupu.ids.l3 }, "6");
    assert.equal(denied.isError, true);
    assert.doesNotMatch(denied.text, /定价/);
    assert.match((await run("doc_read", { id: pupu.ids.l3 }, "8")).text, /定价草案正文/);
    assert.doesNotMatch((await run("doc_search", { query: "正文" }, MAIN_SESSION)).text, /定价|体检/);
    assert.match((await run("doc_search", { query: "体检" }, "11")).text, /体检报告/);
    assert.match((await run("doc_search", { query: "体检" }, "7")).text, /没找到/);
    assert.doesNotMatch((await run("doc_list", {}, "10")).text, /体检/);
  });

  test("搜索词里的 % 和 _ 按字面找", async () => {
    const pupu = await org();
    const run = tools(pupu);
    assert.match((await run("doc_search", { query: "%" }, MAIN_SESSION)).text, /没找到/);
  });
});

describe("资料：往哪写", () => {
  test("空间会话只写本空间，指定别处被拒", async () => {
    const pupu = await org();
    const spaces = pupu.projects.listProjects();
    assert.equal(writeTarget(pupu.threads.of("10")!, undefined, spaces), pupu.l3.id);
    assert.equal(writeTarget(pupu.threads.of("10")!, null, spaces), undefined);
    assert.equal(writeTarget(pupu.threads.of("10")!, pupu.open.id, spaces), undefined);
    const run = tools(pupu);
    const refused = await run("doc_write", { title: "x", summary: "", body: "机密", space_id: pupu.open.id }, "10");
    assert.equal(refused.isError, true);
  });

  test("L3 空间改不了组织层的资料：内容会流到更宽的地方", async () => {
    const pupu = await org();
    const run = tools(pupu);
    const refused = await run("doc_write", { id: pupu.ids.org, title: "公司手册", summary: "", body: "定价是 99" }, "10");
    assert.equal(refused.isError, true);
    assert.equal(pupu.docs.current(pupu.ids.org)!.body, "公司手册正文");
  });

  test("大家：写组织层或全组织档空间，写不进 L3", async () => {
    const pupu = await org();
    const spaces = pupu.projects.listProjects();
    assert.equal(writeTarget(pupu.threads.of(MAIN_SESSION)!, undefined, spaces), null);
    assert.equal(writeTarget(pupu.threads.of(MAIN_SESSION)!, null, spaces), null);
    assert.equal(writeTarget(pupu.threads.of(MAIN_SESSION)!, pupu.open.id, spaces), pupu.open.id);
    assert.equal(writeTarget(pupu.threads.of(MAIN_SESSION)!, pupu.l3.id, spaces), undefined);
  });

  test("个人入口：本人读得到的空间都能写，算本人发的；L4 和别人的 L3 不行", async () => {
    const pupu = await org();
    const spaces = pupu.projects.listProjects();
    assert.equal(writeTarget(pupu.threads.of("7")!, pupu.l3.id, spaces), pupu.l3.id);
    assert.equal(writeTarget(pupu.threads.of("6")!, pupu.l3.id, spaces), undefined);
    assert.equal(writeTarget(pupu.threads.of("7")!, pupu.l4.id, spaces), undefined);
    const run = tools(pupu);
    const unsaid = await run("doc_write", { title: "我的想法", summary: "", body: "…" }, "7");
    assert.equal(unsaid.isError, true);
    assert.match(unsaid.text, /说清楚存到哪/);
    assert.equal(writeTarget(pupu.threads.of("7")!, null, spaces), null);
    const saved = await run("doc_write", { title: "我的想法", summary: "", body: "…", space_id: pupu.l3.id }, "7");
    assert.equal(pupu.docs.current(String(saved.details!.id))!.authorId, "m1");
  });

  test("改一份资料：旧版本标结束，id 不变；同一次调用重放不多写", async () => {
    const pupu = await org();
    const run = tools(pupu);
    await run("doc_write", { id: pupu.ids.l3, title: "定价草案", summary: "", body: "第二版" }, "10");
    assert.equal(pupu.docs.current(pupu.ids.l3)!.body, "第二版");
    const versions = pupu.sql.exec("SELECT ended_at FROM pupu_docs WHERE doc_id = ?", pupu.ids.l3).toArray();
    assert.equal(versions.length, 2);
    assert.equal(versions.filter((row) => row.ended_at === null).length, 1);
    const again = pupu.docs.write(
      { spaceId: null, kind: "doc", title: "a", summary: "", body: "b", authorId: null, fromSession: null, operation: "seed:公司手册" },
      NOW + 5
    );
    assert.equal(again.id, pupu.ids.org);
  });
});

describe("资料：提升到组织层", () => {
  test("全组织档空间的能提升，原件留着；L3 的不行", async () => {
    const pupu = await org();
    const run = tools(pupu);
    const ok = await run("doc_promote", { id: pupu.ids.open }, MAIN_SESSION);
    assert.notEqual(ok.isError, true);
    const copy = pupu.docs.current(String(ok.details!.id))!;
    assert.equal(copy.spaceId, null);
    assert.equal(copy.copiedFrom, pupu.ids.open);
    assert.ok(pupu.docs.current(pupu.ids.open));
    const refused = await run("doc_promote", { id: pupu.ids.l3 }, "7");
    assert.equal(refused.isError, true);
  });
});

describe("skill 列在提示词里", () => {
  test("只列这条会话读得到的 skill", async () => {
    const pupu = await org();
    pupu.docs.write(
      { spaceId: pupu.l3.id, kind: "skill", title: "报价口径", summary: "给客户报价时用", body: "…", authorId: null, fromSession: null, operation: "seed:报价口径" },
      NOW
    );
    const prompt = (session: string) => {
      const thread = pupu.threads.of(session)!;
      const skills = pupu.docs.list(docScope(thread, pupu.projects.listProjects()), "skill");
      return renderPrompt(thread, pupu.projects, new ReportStore(pupu.sql), [], [], () => "林夏", [], skills);
    };
    assert.match(prompt("10"), /报价口径（id: .*）：给客户报价时用/);
    assert.match(prompt("10"), /周报格式/);
    assert.doesNotMatch(prompt(MAIN_SESSION), /报价口径/);
    assert.doesNotMatch(prompt("6"), /报价口径/);
  });
});

describe("资料：人在界面上看和传（/api/docs）", () => {
  test("看得到的：组织层、自己在的空间（含 L4）、全组织档；别人的 L3、L4 看不到", async () => {
    const pupu = await org();
    const spaces = pupu.projects.listProjects();
    const titles = (viewer: string | null) => pupu.docs.list(viewerScope(viewer, spaces)).map((doc) => doc.title).sort();
    assert.deepEqual(titles("m1"), ["体检报告", "公司手册", "周报格式", "定价草案"].sort());
    assert.deepEqual(titles("m2"), ["公司手册", "周报格式", "定价草案"].sort());
    assert.deepEqual(titles("m3"), ["公司手册", "周报格式"].sort());
    assert.deepEqual(titles(null), ["公司手册", "周报格式"].sort());
    assert.equal(pupu.docs.read(viewerScope("m3", spaces), pupu.ids.l3), undefined);
  });

  test("能放的：组织层和看得到的空间", async () => {
    const pupu = await org();
    const spaces = pupu.projects.listProjects();
    assert.equal(viewerTarget("m3", null, spaces), null);
    assert.equal(viewerTarget("m3", pupu.open.id, spaces), pupu.open.id);
    assert.equal(viewerTarget("m3", pupu.l3.id, spaces), undefined);
    assert.equal(viewerTarget("m2", pupu.l4.id, spaces), undefined);
    assert.equal(viewerTarget("m1", pupu.l4.id, spaces), pupu.l4.id);
    assert.equal(viewerTarget("m1", "没有", spaces), undefined);
  });

  test("被移出空间以后，那里的资料马上看不到", async () => {
    const pupu = await org();
    await pupu.projects.removeMember(writer(pupu.sql), pupu.l3.id, "m2");
    const spaces = pupu.projects.listProjects();
    assert.equal(pupu.docs.read(viewerScope("m2", spaces), pupu.ids.l3), undefined);
  });
});
