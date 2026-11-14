import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mayOpen, mayRead, maySeeSpace, seesWork, type Level } from "../src/access.ts";
import { MemberStore, removeMember } from "../src/members.ts";
import { renderPrompt } from "../src/prompt.ts";
import { ProjectStore, type SpaceWriter } from "../src/projects.ts";
import { ReportStore } from "../src/reports.ts";
import { MAIN_SESSION, ThreadStore, type Thread } from "../src/threads.ts";
import { createPupuTools } from "../src/tools.ts";
import { checkSpaceChange, parseSpaceChange, readableReports } from "../src/spaces.ts";
import { docScope, viewerScope } from "../src/docs.ts";
import { sqlStorage } from "./sql-memory.ts";
import { pickSpaceIcon } from "../src/space-look.ts";

const NOW = 1_800_000_000_000;

/** 测试里没有 pi 的队列，直接写。 */
function writer(sql: SqlStorage): SpaceWriter {
  const run = async (query: string, ...params: (string | number | null)[]) => sql.exec(query, ...params);
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
      members: [],
      mode: "direct",
      color: "mist",
      icon: "chart"
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

  test("从一个空间读另一个：只读得到全组织的，成员再多也读不到别的 L3", () => {
    const target = { ...space("L3", ["m1", "m2", "m3"]), id: "t" };
    assert.equal(mayRead(inSpace("L3", ["m1", "m2"]), target), false);
    assert.equal(mayRead(inSpace("L3", ["m1", "m2"]), { ...space("L2"), id: "o" }), true);
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

describe("被移出组织的人（第 8 节的身份）", () => {
  test("移出组织：从空间里拿掉，个人入口谁都打不开；再邀请回来用回原来的 id，个人入口回来，空间要重新拉", async () => {
    const { sql, projects, threads, space } = await org();
    const members = new MemberStore(sql);
    const lin = members.addCreator("lin@example.com", NOW)!;
    const zhou = members.invite("zhou@example.com", lin.id, NOW)!;
    await threads.ensurePrivateChat(zhou.id, async () => "20", NOW);
    await projects.addMember(writer(sql), space.id, zhou.id, lin.id, NOW);
    const entry = threads.of("20");
    assert.equal(mayOpen(entry, zhou.id), true);

    await removeMember(
      zhou,
      {
        members,
        devices: { ofMember: () => [], cancelCodes: () => {} },
        computers: { list: () => [] },
        connectors: { list: () => [] },
        revokeDevice: () => {},
        revokeComputer: () => {},
        disconnect: async () => true,
        leaveSpaces: async (memberId) => {
          await projects.leaveAll(writer(sql), memberId, NOW + 1);
        },
        release: async () => {}
      },
      NOW + 1
    );
    // 被移出的人发请求时认不出是谁（设备吊销了），viewer 是 null。
    const removedViewer = members.byId(zhou.id)?.id ?? null;
    assert.equal(removedViewer, null);
    assert.equal(mayOpen(threads.of("20"), removedViewer), false, "他自己打不开");
    assert.equal(mayOpen(threads.of("20"), lin.id), false, "创建者也打不开");
    const after = projects.getProject(space.id)!;
    assert.equal(after.members.includes(zhou.id), false, "从空间里拿掉了");
    assert.equal(maySeeSpace(after, removedViewer), false);
    assert.equal(mayRead({ kind: "private", memberId: "m1" }, after), true, "剩下的成员照样读得到，不被空出来的 id 卡住");

    const back = members.invite("zhou@example.com", lin.id, NOW + 2)!;
    assert.equal(back.id, zhou.id);
    assert.equal(mayOpen(threads.of("20"), back.id), true, "个人入口回来了");
    assert.equal(maySeeSpace(projects.getProject(space.id)!, back.id), false, "L3 空间没有自动回来");
  });
});

describe("权限矩阵：界面上改空间（协作方案第 8 节）", () => {
  // 林夏 m1 建了 L3「定价」，拉了阿周 m2；小吴 m3 是组织成员但不在空间里；阿梅 m4 被移出了空间；
  // 创建者 c 不在空间里；老项目「周报」没有主人；m9 已经不在组织里。
  const org = new Set(["m1", "m2", "m3", "m4", "c"]);
  const isOrg = (id: string) => org.has(id);
  const l3 = { id: "s", level: "L3" as Level, members: ["m1", "m2"], ownerId: "m1" };
  const legacy = { id: "w", level: "L2" as Level, members: [] as string[], ownerId: null };
  const changes = [
    { kind: "add", memberId: "m3" },
    { kind: "remove", memberId: "m2" },
    { kind: "level", level: "L2" },
    { kind: "mode", mode: "coordinator" },
    { kind: "color", color: "sage" },
    { kind: "icon", icon: "globe" }
  ] as const;

  test("主人什么都能改", () => {
    for (const change of changes) assert.equal(checkSpaceChange(l3, "m1", change, isOrg), "ok", change.kind);
  });

  test("空间成员不是主人：看得到，改不了", () => {
    for (const change of changes) assert.equal(checkSpaceChange(l3, "m2", change, isOrg), "forbidden", change.kind);
  });

  test("非成员、被移出空间的人、创建者、没登录的：和空间不存在一样", () => {
    for (const viewer of ["m3", "m4", "c", "m9", null]) {
      for (const change of changes) assert.equal(checkSpaceChange(l3, viewer, change, isOrg), "missing", `${viewer} ${change.kind}`);
    }
    assert.equal(checkSpaceChange(undefined, "m1", changes[0], isOrg), "missing");
  });

  test("全组织档：谁都看得到，只有主人能改", () => {
    const open = { ...l3, level: "L2" as Level };
    assert.equal(checkSpaceChange(open, "m3", changes[2], isOrg), "forbidden");
    assert.equal(checkSpaceChange(open, "c", changes[0], isOrg), "forbidden");
    assert.equal(checkSpaceChange(open, "m1", { kind: "level", level: "L3" }, isOrg), "ok");
  });

  test("老项目没有主人：谁都改不了，创建者也不行", () => {
    for (const viewer of ["m1", "c", null]) {
      for (const change of changes) assert.equal(checkSpaceChange(legacy, viewer, change, isOrg), "forbidden");
    }
  });

  test("只能拉组织里的人；主人移不出去；L1 不做", () => {
    assert.equal(checkSpaceChange(l3, "m1", { kind: "add", memberId: "m9" }, isOrg), "invalid");
    assert.equal(checkSpaceChange(l3, "m1", { kind: "remove", memberId: "m1" }, isOrg), "invalid");
    assert.equal(checkSpaceChange(l3, "m1", { kind: "level", level: "L1" }, isOrg), "invalid");
  });

  test("请求体：认不出来的是 null", () => {
    assert.deepEqual(parseSpaceChange({ kind: "add", memberId: "m3" }), { kind: "add", memberId: "m3" });
    assert.deepEqual(parseSpaceChange({ kind: "level", level: "L4" }), { kind: "level", level: "L4" });
    assert.equal(parseSpaceChange({ kind: "level", level: "L5" }), null);
    assert.equal(parseSpaceChange({ kind: "add" }), null);
    assert.equal(parseSpaceChange({ kind: "owner", memberId: "m2" }), null);
    assert.equal(parseSpaceChange(null), null);
    assert.deepEqual(parseSpaceChange({ kind: "color", color: "lilac" }), { kind: "color", color: "lilac" });
    assert.deepEqual(parseSpaceChange({ kind: "icon", icon: "paw" }), { kind: "icon", icon: "paw" });
    assert.equal(parseSpaceChange({ kind: "color", color: "red" }), null);
    assert.equal(parseSpaceChange({ kind: "icon", icon: "building" }), null);
    assert.equal(parseSpaceChange({ kind: "icon", icon: null }), null);
  });
});

describe("空间的颜色和图标（设计规范 SpaceColor、SpaceMark）", () => {
  test("老空间迁移：都是雾蓝，图标按名字挑一次，挑不出来留空写第一个字", () => {
    const sql = sqlStorage();
    sql.exec(`CREATE TABLE pupu_projects (
      id TEXT PRIMARY KEY, session TEXT NOT NULL UNIQUE, name TEXT NOT NULL, goal TEXT NOT NULL,
      background TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    sql.exec("INSERT INTO pupu_projects (id, session, name, goal, created_at, updated_at) VALUES ('a', '5', '官网改版', '', 1, 3)");
    sql.exec("INSERT INTO pupu_projects (id, session, name, goal, created_at, updated_at) VALUES ('b', '6', '阿周的事', '', 1, 2)");
    const looks = new ProjectStore(sql).listProjects().map(({ name, color, icon }) => ({ name, color, icon }));
    assert.deepEqual(looks, [
      { name: "官网改版", color: "mist", icon: "globe" },
      { name: "阿周的事", color: "mist", icon: null }
    ]);
  });

  test("线上现在的库（main 2b294ea 的表，已经有密级、主人、模式、存档和成员）升上来：别的都不动，补上颜色和图标", async () => {
    const sql = sqlStorage();
    // 照 2b294ea 的 projects.ts 跑完它自己的迁移以后的样子。
    sql.exec(`CREATE TABLE pupu_projects (
      id TEXT PRIMARY KEY, session TEXT NOT NULL UNIQUE, name TEXT NOT NULL, goal TEXT NOT NULL,
      background TEXT NOT NULL DEFAULT '', progress TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    sql.exec("ALTER TABLE pupu_projects ADD COLUMN level TEXT NOT NULL DEFAULT 'L2'");
    sql.exec("ALTER TABLE pupu_projects ADD COLUMN owner_id TEXT");
    sql.exec("ALTER TABLE pupu_projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'direct'");
    sql.exec("ALTER TABLE pupu_projects ADD COLUMN archived_at INTEGER");
    sql.exec(`CREATE TABLE pupu_project_members (
      project_id TEXT NOT NULL, member_id TEXT NOT NULL, added_by TEXT, added_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, member_id)
    )`);
    sql.exec("CREATE TABLE pupu_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insert = `INSERT INTO pupu_projects (id, session, name, goal, background, progress, created_at, updated_at, level, owner_id, mode, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    sql.exec(insert, "pricing", "10", "定价", "定价格", "背景", "做到一半", 1, 5, "L3", "m1", "coordinator", null);
    sql.exec(insert, "weekly", "9", "周报", "写周报", "", "", 1, 4, "L2", null, "direct", null);
    sql.exec(insert, "gone", "11", "官网改版", "", "", "", 1, 3, "L3", "m9", "direct", 2);
    sql.exec("INSERT INTO pupu_project_members (project_id, member_id, added_by, added_at) VALUES ('pricing', 'm1', NULL, 1), ('pricing', 'm2', 'm1', 2)");
    sql.exec("INSERT INTO pupu_meta (key, value) VALUES ('everyone-mode', 'coordinator')");

    const projects = new ProjectStore(sql);
    assert.deepEqual(projects.listProjects(), [
      {
        id: "pricing", session: "10", name: "定价", goal: "定价格", background: "背景", progress: "做到一半",
        createdAt: 1, updatedAt: 5, level: "L3", ownerId: "m1", members: ["m1", "m2"], mode: "coordinator",
        color: "mist", icon: null
      },
      {
        id: "weekly", session: "9", name: "周报", goal: "写周报", background: "", progress: "",
        createdAt: 1, updatedAt: 4, level: "L2", ownerId: null, members: [], mode: "direct",
        color: "mist", icon: "chart"
      }
    ]);
    const everyone = projects.everyone();
    assert.deepEqual([everyone.mode, everyone.color, everyone.icon], ["coordinator", "mist", "house"]);

    // 存档的空间也补上了，主人回来以后照样有颜色和图标。
    assert.equal(projects.getProject("gone"), undefined);
    await projects.restoreOwnedBy(writer(sql), "m9");
    const back = projects.getProject("gone")!;
    assert.deepEqual([back.color, back.icon], ["mist", "globe"]);

    // 升上来以后能换，再开一次库也不会重挑图标。
    await projects.setLook(writer(sql), "pricing", { color: "apricot", icon: "rocket" });
    const reopened = new ProjectStore(sql).getProject("pricing")!;
    assert.deepEqual([reopened.color, reopened.icon, reopened.level, reopened.mode], ["apricot", "rocket", "L3", "coordinator"]);
  });

  test("新空间：没给图标按名字挑，给了用给的，颜色先用雾蓝", async () => {
    const sql = sqlStorage();
    const projects = new ProjectStore(sql);
    const named = await projects.createSpace(writer(sql), { session: "10", name: "Q4 招聘", goal: "", background: "", ownerId: "m1" }, NOW);
    assert.deepEqual([named.color, named.icon], ["mist", "briefcase"]);
    const chosen = projects.insertProject({ session: "11", name: "随便", goal: "", background: "", icon: "rocket" });
    assert.equal(chosen.icon, "rocket");
  });

  test("换颜色和图标：没给的那样不动，列表顺序不变", async () => {
    const { sql, projects, space, open } = await org();
    const before = projects.listProjects().map((project) => project.id);
    await projects.setLook(writer(sql), space.id, { color: "apricot" });
    await projects.setLook(writer(sql), space.id, { icon: "paw" });
    const changed = projects.getProject(space.id)!;
    assert.deepEqual([changed.color, changed.icon], ["apricot", "paw"]);
    assert.equal(projects.getProject(open.id)!.color, "mist");
    assert.deepEqual(projects.listProjects().map((project) => project.id), before);
  });

  test("全员：默认雾蓝加房子，换了存在 pupu_meta", () => {
    const projects = new ProjectStore(sqlStorage());
    assert.deepEqual([projects.everyone().color, projects.everyone().icon], ["mist", "house"]);
    projects.setEveryoneLook({ color: "graphite" });
    projects.setEveryoneLook({ icon: "flag" });
    assert.deepEqual([projects.everyone().color, projects.everyone().icon], ["graphite", "flag"]);
  });

  test("按名字挑图标：中文按字面，英文要整个词", () => {
    assert.equal(pickSpaceIcon("官网改版"), "globe");
    assert.equal(pickSpaceIcon("周报"), "chart");
    assert.equal(pickSpaceIcon("我的读书笔记"), "book");
    assert.equal(pickSpaceIcon("Build pipeline"), null);
    assert.equal(pickSpaceIcon("new UI"), "palette");
    assert.equal(pickSpaceIcon("大家的事"), null);
  });
});

describe("权限矩阵：改了以后各出口跟着变", () => {
  test("改成 L3 以后，不在名单上的人看不到、打不开；移出的人也一样", async () => {
    const { sql, projects, threads } = await org();
    const project = projects.insertProject({ session: "11", name: "官网", goal: "", background: "" });
    // 老项目没有主人；这里模拟一个有主人的全组织空间收窄。
    sql.exec("UPDATE pupu_projects SET owner_id = 'm1' WHERE id = ?", project.id);
    await projects.addMember(writer(sql), project.id, "m1", "m1", NOW);
    await projects.addMember(writer(sql), project.id, "m2", "m1", NOW);
    assert.equal(mayOpen(threads.of("11"), "m3"), true);
    await projects.setLevel(writer(sql), project.id, "L3", NOW);
    assert.equal(maySeeSpace(projects.getProject(project.id)!, "m3"), false);
    assert.equal(mayOpen(threads.of("11"), "m3"), false);
    assert.equal(mayOpen(threads.of("11"), "m2"), true);
    await projects.removeMember(writer(sql), project.id, "m2");
    assert.equal(mayOpen(threads.of("11"), "m2"), false);
    assert.equal(maySeeSpace(projects.getProject(project.id)!, "m2"), false);
  });

  test("报告卡：空间收窄以后，以前报到主会话的卡不再给；本人私聊里的还在", async () => {
    const { sql, projects, threads } = await org();
    const project = projects.insertProject({ session: "11", name: "官网", goal: "", background: "" });
    await projects.addMember(writer(sql), project.id, "m1", "m1", NOW);
    const rows = [
      { id: "r1", projectId: project.id, origin: MAIN_SESSION },
      { id: "r2", projectId: project.id, origin: "7" }
    ];
    const current = () => new Map(projects.listProjects().map((item) => [item.id, item]));
    assert.deepEqual(readableReports(rows, current(), (session) => threads.of(session)).map((row) => row.id), ["r1", "r2"]);
    await projects.setLevel(writer(sql), project.id, "L3", NOW);
    assert.deepEqual(readableReports(rows, current(), (session) => threads.of(session)).map((row) => row.id), ["r2"]);
    await projects.setLevel(writer(sql), project.id, "L4", NOW);
    assert.deepEqual(readableReports(rows, current(), (session) => threads.of(session)), []);
  });
});

describe("空间主人被移出组织：空间解散（存档），再邀请回来原样恢复", () => {
  /** 林夏是创建者；阿周建了 L3「定价」（拉了林夏）和全组织档的「周报」，各有一个子会话在跑。 */
  async function setup() {
    const pupu = await org();
    const { sql, projects, threads } = pupu;
    const members = new MemberStore(sql);
    const lin = members.addCreator("lin@example.com", NOW)!;
    const zhou = members.invite("zhou@example.com", lin.id, NOW)!;
    await threads.ensurePrivateChat(lin.id, async () => "40", NOW);
    const secret = await projects.createSpace(writer(sql), { session: "30", name: "保密定价", goal: "", background: "", ownerId: zhou.id }, NOW);
    await projects.addMember(writer(sql), secret.id, lin.id, zhou.id, NOW);
    const open = await projects.createSpace(writer(sql), { session: "31", name: "公开周会", goal: "", background: "", ownerId: zhou.id }, NOW);
    await projects.setLevel(writer(sql), open.id, "L2", NOW);
    const remove = () =>
      removeMember(
        zhou,
        {
          members,
          devices: { ofMember: () => [], cancelCodes: () => {} },
          computers: { list: () => [] },
          connectors: { list: () => [] },
          revokeDevice: () => {},
          revokeComputer: () => {},
          disconnect: async () => true,
          leaveSpaces: async (memberId) => {
            archived.push(...(await projects.leaveAll(writer(sql), memberId, NOW + 1)));
          },
          release: async () => {}
        },
        NOW + 1
      );
    const archived: { id: string }[] = [];
    return { ...pupu, members, lin, zhou, secret, open, remove, archived };
  }

  test("他建的空间都解散，里面有别人也一样；别人建的空间只把他拿掉", async () => {
    const { projects, secret, open, remove, archived, space, zhou, sql } = await setup();
    await projects.addMember(writer(sql), space.id, zhou.id, "m1", NOW);
    await remove();
    assert.deepEqual(archived.map((p) => p.id).sort(), [secret.id, open.id].sort(), "返回解散的空间，好停掉里面在跑的");
    assert.equal(projects.getProject(secret.id), undefined);
    assert.equal(projects.getProject(open.id), undefined, "全组织档的也解散");
    const kept = projects.getProject(space.id)!;
    assert.equal(kept.members.includes(zhou.id), false, "别人建的空间还在，只是没有他了");
  });

  test("每个出口都没有它：列表、会话、工具、提示词、汇报、资料，创建者也看不到", async () => {
    const pupu = await setup();
    const { projects, threads, secret, open, remove, lin, reports } = pupu;
    const rows = [
      { id: "r1", projectId: secret.id, origin: "40" },
      { id: "r2", projectId: open.id, origin: MAIN_SESSION }
    ];
    await remove();
    const listed = projects.listProjects().map((p) => p.name);
    assert.equal(listed.includes("保密定价") || listed.includes("公开周会"), false, "状态和广播都从这张列表出");
    assert.equal(projects.projectBySession("30"), undefined);
    assert.equal(mayOpen(threads.of("30"), lin.id), false, "创建者打不开");
    assert.equal(mayOpen(threads.of("31"), lin.id), false, "全组织档的也打不开");
    assert.equal(mayOpen(threads.of("31"), null), false);
    const map = new Map(projects.listProjects().map((p) => [p.id, p]));
    assert.deepEqual(readableReports(rows, map, (session) => threads.of(session)), [], "汇报卡没了");
    const scope = viewerScope(lin.id, projects.listProjects()).spaceIds;
    assert.equal(scope.includes(secret.id) || scope.includes(open.id), false, "资料看不到");
    assert.equal(docScope(threads.of("40")!, projects.listProjects()).spaceIds.includes(secret.id), false);
    const list = createPupuTools({
      store: projects,
      threadOf: (session) => threads.of(session),
      createProject: async () => {
        throw new Error("不该建");
      },
      handOff: async () => {
        throw new Error("不该交");
      }
    });
    const run = (name: string, args: unknown, session: string) =>
      (list.find((each) => each.name === name) as unknown as {
        execute(args: unknown, api: unknown): Promise<{ output: { text: string }[]; isError?: boolean }>;
      }).execute(args, { conversationId: session, callId: `call-${session}` });
    const text = (await run("list_projects", {}, "40")).output[0]!.text;
    assert.doesNotMatch(text, /保密定价|公开周会/, "工具列不出来");
    assert.equal((await run("hand_off_to_project", { project_id: secret.id, task: "x" }, "40")).isError, true, "交不进去");
    const prompt = renderPrompt(threads.of("40") as Thread, projects, reports, [], [], () => "某人");
    assert.doesNotMatch(prompt, /保密定价|公开周会/, "提示词里没有");
  });

  test("数据不删：空间、成员名单（含主人）都还在库里", async () => {
    const { sql, secret, remove, lin, zhou } = await setup();
    await remove();
    const [row] = sql.exec("SELECT name, archived_at FROM pupu_projects WHERE id = ?", secret.id).toArray();
    assert.equal(row?.name, "保密定价");
    assert.equal(row?.archived_at, NOW + 1);
    const members = sql.exec("SELECT member_id FROM pupu_project_members WHERE project_id = ?", secret.id).toArray().map((r) => String(r.member_id)).sort();
    assert.deepEqual(members, [lin.id, zhou.id].sort());
  });

  test("再邀请回来：解散的空间原样恢复，成员都在", async () => {
    const { projects, threads, members, secret, open, remove, lin, zhou, sql } = await setup();
    await remove();
    const back = members.invite("zhou@example.com", lin.id, NOW + 2)!;
    assert.equal(back.id, zhou.id);
    await projects.restoreOwnedBy(writer(sql), back.id);
    const restored = projects.getProject(secret.id)!;
    assert.deepEqual(restored.members, [lin.id, zhou.id].sort());
    assert.equal(restored.level, "L3");
    assert.equal(restored.ownerId, zhou.id);
    assert.equal(mayOpen(threads.of("30"), lin.id), true, "林夏又打得开");
    assert.equal(mayOpen(threads.of("30"), zhou.id), true);
    assert.equal(projects.getProject(open.id)?.level, "L2");
  });
});
