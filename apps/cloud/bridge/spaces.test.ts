import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mayOpen, mayRead, maySeeSpace, seesWork, type Level } from "../src/access.ts";
import { renderPrompt } from "../src/prompt.ts";
import { ProjectStore, type SpaceWriter } from "../src/projects.ts";
import { ReportStore } from "../src/reports.ts";
import { MAIN_SESSION, ThreadStore, type Thread } from "../src/threads.ts";
import { createPupuTools } from "../src/tools.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_800_000_000_000;

/** 测试里没有 pi 的队列，直接写。 */
function writer(sql: SqlStorage): SpaceWriter {
  const run = async (query: string, ...params: SqlStorageValue[]) => sql.exec(query, ...params);
  return { run, transaction: (callback) => callback({ run }) };
}

/** 林夏 m1（私聊 7）、阿周 m2（私聊 8）、小吴 m3（私聊 6）；公开项目「周报」会话 9，林夏和阿周的 L3 空间「定价」会话 10。 */
async function org() {
  const sql = sqlStorage();
  const projects = new ProjectStore(sql);
  const threads = new ThreadStore(sql, projects);
  await threads.ensurePrivateChat("m1", async () => "7", NOW);
  await threads.ensurePrivateChat("m2", async () => "8", NOW);
  await threads.ensurePrivateChat("m3", async () => "6", NOW);
  const open = projects.insertProject({ session: "9", name: "周报", goal: "写周报", background: "" });
  const space = await projects.createSpace(
    writer(sql),
    { session: "10", name: "定价", goal: "定价格", background: "", ownerId: "m1" },
    NOW
  );
  await projects.addMember(writer(sql), space.id, "m2", "m1", NOW);
  return { sql, projects, threads, open, space: projects.getProject(space.id)!, reports: new ReportStore(sql) };
}

describe("老数据迁移", () => {
  function oldSchema() {
    const sql = sqlStorage();
    sql.exec(`CREATE TABLE pupu_projects (
      id TEXT PRIMARY KEY,
      session TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      background TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec(
      "INSERT INTO pupu_projects (id, session, name, goal, background, created_at, updated_at) VALUES ('p1', '5', '周报', '写周报', '背景', 1, 2)"
    );
    return sql;
  }

  test("老项目变成 L2，没有主人和成员，别的字段不变", () => {
    const sql = oldSchema();
    const [project] = new ProjectStore(sql).listProjects();
    assert.deepEqual(project, {
      id: "p1",
      session: "5",
      name: "周报",
      goal: "写周报",
      background: "背景",
      progress: "",
      createdAt: 1,
      updatedAt: 2,
      level: "L2",
      ownerId: null,
      members: []
    });
  });

  test("迁移跑两次结果一样", () => {
    const sql = oldSchema();
    const first = new ProjectStore(sql).listProjects();
    const second = new ProjectStore(sql).listProjects();
    assert.deepEqual(second, first);
  });

  test("新建的项目也是 L2", () => {
    const projects = new ProjectStore(sqlStorage());
    const project = projects.insertProject({ session: "9", name: "周报", goal: "", background: "" });
    assert.equal(project.level, "L2");
    assert.deepEqual(project.members, []);
  });
});

describe("空间成员和密级", () => {
  test("建 L3 空间时只有建的人", async () => {
    const sql = sqlStorage();
    const projects = new ProjectStore(sql);
    const space = await projects.createSpace(
      writer(sql),
      { session: "10", name: "定价", goal: "", background: "", ownerId: "m1" },
      NOW
    );
    assert.equal(space.level, "L3");
    assert.equal(space.ownerId, "m1");
    assert.deepEqual(space.members, ["m1"]);
  });

  test("拉人、重复拉、移出、改密级", async () => {
    const { sql, projects, space } = await org();
    await projects.addMember(writer(sql), space.id, "m2", "m1", NOW);
    assert.deepEqual(projects.getProject(space.id)!.members, ["m1", "m2"]);
    await projects.removeMember(writer(sql), space.id, "m2");
    assert.deepEqual(projects.getProject(space.id)!.members, ["m1"]);
    await projects.setLevel(writer(sql), space.id, "L4", NOW + 1);
    assert.equal(projects.projectBySession("10")!.level, "L4");
  });
});

describe("谁能看什么", () => {
  const space = (level: Level, members: string[] = ["m1", "m2"]) => ({ id: "s", level, members });
  const inSpace = (level: Level, members?: string[]) => ({ kind: "project" as const, project: space(level, members) });
  const main = { kind: "main" as const };
  const lin = { kind: "private" as const, memberId: "m1" };
  const wu = { kind: "private" as const, memberId: "m3" };

  test("打开会话：主会话、L2 谁都行，L3、L4 只有成员，私聊只有本人", () => {
    for (const viewer of ["m1", "m3", null]) assert.equal(mayOpen(main, viewer), true);
    assert.equal(mayOpen(inSpace("L2"), null), true);
    assert.equal(mayOpen(inSpace("L1"), "m3"), true);
    for (const level of ["L3", "L4"] as const) {
      assert.equal(mayOpen(inSpace(level), "m1"), true);
      assert.equal(mayOpen(inSpace(level), "m3"), false);
      assert.equal(mayOpen(inSpace(level), null), false);
    }
    assert.equal(mayOpen(lin, "m1"), true);
    assert.equal(mayOpen(lin, "m2"), false);
    assert.equal(mayOpen(undefined, "m1"), false);
  });

  test("会话里的动作：受众和批准的人看得到", () => {
    assert.equal(seesWork(inSpace("L3"), "m2", null), true);
    assert.equal(seesWork(inSpace("L3"), "m3", null), false);
    assert.equal(seesWork(inSpace("L3"), "m3", "m3"), true);
    assert.equal(seesWork(inSpace("L2"), null, null), true);
    assert.equal(seesWork(undefined, "m1", "m1"), true);
    assert.equal(seesWork(undefined, null, null), false);
  });

  test("列表和状态：L2 谁都看得到，L3、L4 只有成员", () => {
    assert.equal(maySeeSpace(space("L2"), null), true);
    assert.equal(maySeeSpace(space("L3"), "m2"), true);
    assert.equal(maySeeSpace(space("L3"), "m3"), false);
    assert.equal(maySeeSpace(space("L4"), null), false);
  });

  test("从别的会话读：主会话只读得到 L2，成员私聊读得到 L3，L4 只有它自己", () => {
    assert.equal(mayRead(main, space("L2")), true);
    assert.equal(mayRead(main, space("L3")), false);
    assert.equal(mayRead(lin, space("L3")), true);
    assert.equal(mayRead(wu, space("L3")), false);
    assert.equal(mayRead(lin, space("L4")), false);
    assert.equal(mayRead(inSpace("L4"), space("L4")), true);
  });

  test("从一个空间读另一个：这边每个成员都得在那边", () => {
    const target = { ...space("L3", ["m1", "m2", "m3"]), id: "t" };
    assert.equal(mayRead(inSpace("L3", ["m1", "m2"]), target), true);
    assert.equal(mayRead(inSpace("L3", ["m1", "m4"]), target), false);
    assert.equal(mayRead(inSpace("L2"), target), false);
  });

  test("成员都被移出的空间读不到别的 L3", () => {
    assert.equal(mayRead(inSpace("L3", []), { ...space("L3"), id: "t" }), false);
  });
});

describe("出口按会话的受众筛", () => {
  function tools(pupu: Awaited<ReturnType<typeof org>>, handed: string[]) {
    const list = createPupuTools({
      store: pupu.projects,
      threadOf: (session) => pupu.threads.of(session),
      createProject: async () => {
        throw new Error("不该建");
      },
      handOff: async (project) => {
        handed.push(project.name);
      }
    });
    return (name: string, args: unknown, session: string) => {
      const tool = list.find((each) => each.name === name) as unknown as {
        execute(args: unknown, api: unknown): Promise<{ output: { text: string }[]; isError?: boolean }>;
      };
      return tool.execute(args, { conversationId: session, callId: `call-${session}` });
    };
  }

  test("list_projects：主会话和外人只看到公开的，成员私聊看得到 L3", async () => {
    const pupu = await org();
    const run = tools(pupu, []);
    const listed = async (session: string) => (await run("list_projects", {}, session)).output[0]!.text;
    assert.match(await listed(MAIN_SESSION), /周报/);
    assert.doesNotMatch(await listed(MAIN_SESSION), /定价/);
    assert.doesNotMatch(await listed("6"), /定价/);
    assert.match(await listed("7"), /定价/);
  });

  test("hand_off_to_project：主会话交不进 L3，成员私聊可以", async () => {
    const pupu = await org();
    const handed: string[] = [];
    const run = tools(pupu, handed);
    const refused = await run("hand_off_to_project", { project_id: pupu.space.id, task: "算一下" }, MAIN_SESSION);
    assert.equal(refused.isError, true);
    assert.doesNotMatch(refused.output[0]!.text, /定价/);
    await run("hand_off_to_project", { project_id: pupu.space.id, task: "算一下" }, "7");
    assert.deepEqual(handed, ["定价"]);
  });

  test("提示词里的「当前的项目」：主会话没有 L3，成员私聊有", async () => {
    const pupu = await org();
    const prompt = (session: string) =>
      renderPrompt(pupu.threads.of(session) as Thread, pupu.projects, pupu.reports, [], [], () => "某人");
    assert.doesNotMatch(prompt(MAIN_SESSION), /定价/);
    assert.doesNotMatch(prompt("6"), /定价/);
    assert.match(prompt("7"), /定价/);
  });

});
