import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { ApprovalStore } from "../src/bridge/approvals.ts";
import { ComputerGate } from "../src/bridge/gate.ts";
import { renderPrompt } from "../src/prompt.ts";
import { ProjectStore, type Project } from "../src/projects.ts";
import { reportCards, ReportStore } from "../src/reports.ts";
import { MAIN_SESSION, ThreadStore, workFilter } from "../src/threads.ts";
import { createPupuTools } from "../src/tools.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_800_000_000_000;

/** 林夏（m1）的私聊是 7，阿周（m2）的是 8，周报项目的会话是 9。 */
async function group() {
  const sql = sqlStorage();
  const projects = new ProjectStore(sql);
  const threads = new ThreadStore(sql, projects);
  await threads.ensurePrivateChat("m1", async () => "7", NOW);
  await threads.ensurePrivateChat("m2", async () => "8", NOW);
  const project = projects.insertProject({ session: "9", name: "周报", goal: "写周报", background: "" });
  return { sql, projects, threads, project, reports: new ReportStore(sql) };
}

function report(reports: ReportStore, project: Project, id: string, origin: string) {
  reports.open({ id, projectId: project.id, session: project.session, task: `转来的事 ${id}`, origin }, NOW);
}

describe("报告卡回到转交它的那条聊天", () => {
  const nameOf = () => "周报";

  async function settled() {
    const pupu = await group();
    report(pupu.reports, pupu.project, "main", MAIN_SESSION);
    report(pupu.reports, pupu.project, "lin", "7");
    pupu.reports.settle(pupu.project.session, NOW, "done", "写好了", NOW + 10);
    return pupu;
  }

  test("转交的人看得到，卡上写着是哪条聊天", async () => {
    const { reports } = await settled();
    const cards = reportCards(reports.visible([MAIN_SESSION, "7"]), nameOf);
    assert.deepEqual(cards.map((card) => card.chat).sort(), ["1", "7"]);
  });

  test("别人收不到你私聊转交的卡", async () => {
    const { reports } = await settled();
    const cards = reportCards(reports.visible([MAIN_SESSION, "8"]), nameOf);
    assert.deepEqual(cards.map((card) => card.chat), ["1"]);
  });

  test("没有私聊的人只看到主会话的", async () => {
    const { reports } = await settled();
    assert.deepEqual(reports.visible([MAIN_SESSION]).map((row) => row.id), ["main"]);
  });

  test("同一个项目在两条聊天里各一张，不合成一张", async () => {
    const { reports } = await settled();
    const cards = reportCards(reports.visible([MAIN_SESSION, "7"]), nameOf);
    assert.equal(cards.length, 2);
    assert.ok(cards.every((card) => card.more === 0));
  });

  test("有私聊之前记下的报告算主会话的", () => {
    const sql = sqlStorage();
    sql.exec(`CREATE TABLE pupu_reports (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session TEXT NOT NULL, task TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'running', summary TEXT NOT NULL DEFAULT '', owner TEXT,
      errors INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, reported_at INTEGER, seen_at INTEGER
    )`);
    sql.exec(
      "INSERT INTO pupu_reports (id, project_id, session, task, state, created_at, reported_at) VALUES ('old', 'a', '9', '老的事', 'done', 1, 2)"
    );
    const [card] = reportCards(new ReportStore(sql).visible([MAIN_SESSION]), nameOf);
    assert.equal(card?.chat, "1");
  });
});

describe("私聊发起的审批只给相关的人", () => {
  async function pending(session: string) {
    const pupu = await group();
    const gate = new ComputerGate({
      computers: () => [
        { id: "c1", name: "mbpro", online: true, stale: false, lastSeenAt: NOW, policy: "ask_all", screen: false }
      ],
      directory: {
        list: () => [{ id: "c1", name: "mbpro", policy: "ask_all", ownerId: "m2", screenUntil: null } as never],
        setPolicy: () => false,
        setScreenUntil: () => {}
      },
      approvals: new ApprovalStore(pupu.sql),
      now: () => NOW,
      onChange: () => {}
    });
    const waiting = gate.beforeTool({
      id: "call-1",
      name: "run_command",
      arguments: { command: "ls" },
      session
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const seenBy = (viewer: string | null) => {
      const sees = workFilter(pupu.threads, () => "m2", viewer);
      return gate.pending((row) => sees(row.session, row.computerId)).length;
    };
    return { seenBy, gate, waiting };
  }

  async function settle({ gate, waiting }: Awaited<ReturnType<typeof pending>>) {
    gate.decide(gate.pending()[0]!.id, "deny");
    await waiting;
  }

  test("林夏的私聊用阿周的电脑：两人看得到，第三个人看不到", async () => {
    const asked = await pending("7");
    assert.equal(asked.seenBy("m1"), 1);
    assert.equal(asked.seenBy("m2"), 1);
    assert.equal(asked.seenBy("m3"), 0);
    assert.equal(asked.seenBy(null), 0);
    await settle(asked);
  });

  test("主会话发起的大家都看得到", async () => {
    const asked = await pending("1");
    assert.equal(asked.seenBy("m3"), 1);
    await settle(asked);
  });

  test("早先的审批行没记会话，加列之后还读得出来", () => {
    const sql = sqlStorage();
    sql.exec(`CREATE TABLE pupu_approvals (
      id TEXT PRIMARY KEY, call_id TEXT NOT NULL UNIQUE, computer_id TEXT NOT NULL, kind TEXT NOT NULL,
      screen INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, detail TEXT NOT NULL, reason TEXT,
      status TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER
    )`);
    sql.exec(
      "INSERT INTO pupu_approvals (id, call_id, computer_id, kind, title, detail, status, created_at, expires_at) VALUES ('a', 'c', 'c1', 'step', 't', 'd', 'pending', 1, 2)"
    );
    assert.equal(new ApprovalStore(sql).byCall("c")?.session, null);
  });
});

describe("建项目和转交在哪里能用", () => {
  async function tools() {
    const pupu = await group();
    const handed: { task: string; origin: string }[] = [];
    const list = createPupuTools({
      store: pupu.projects,
      threadOf: (session) => pupu.threads.of(session),
      createProject: async ({ name, goal, background }) =>
        pupu.projects.insertProject({ session: "20", name, goal, background }),
      handOff: async (_project, task, _operationId, origin) => {
        handed.push({ task, origin });
      }
    });
    const run = (name: string, args: unknown, session: string) => {
      const tool = list.find((each) => each.name === name) as unknown as {
        execute(args: unknown, api: unknown): Promise<{ isError?: boolean }>;
      };
      return tool.execute(args, { conversationId: session, callId: `call-${session}` });
    };
    return { ...pupu, handed, run };
  }

  test("私聊里能转交，记下来自这条私聊", async () => {
    const { project, handed, run } = await tools();
    const result = await run("hand_off_to_project", { project_id: project.id, task: "写周报" }, "7");
    assert.notEqual(result.isError, true);
    assert.deepEqual(handed, [{ task: "写周报", origin: "7" }]);
  });

  test("私聊里能建项目，第一件事记下来自这条私聊", async () => {
    const { handed, run } = await tools();
    const result = await run("create_project", { name: "搬家", goal: "搬完", background: "", task: "列清单" }, "8");
    assert.notEqual(result.isError, true);
    assert.deepEqual(handed, [{ task: "列清单", origin: "8" }]);
  });

  test("主会话里照旧", async () => {
    const { project, handed, run } = await tools();
    await run("hand_off_to_project", { project_id: project.id, task: "写周报" }, "1");
    assert.deepEqual(handed, [{ task: "写周报", origin: "1" }]);
  });

  test("项目里不能转交", async () => {
    const { project, handed, run } = await tools();
    const result = await run("hand_off_to_project", { project_id: project.id, task: "写周报" }, "9");
    assert.equal(result.isError, true);
    assert.deepEqual(handed, []);
  });
});

describe("提示词按会话写", () => {
  async function prompts() {
    const pupu = await group();
    const render = (session: string) =>
      renderPrompt(pupu.threads.of(session)!, pupu.projects, pupu.reports, [], [], () => "林夏");
    return { render };
  }

  test("主会话写明大家都看得到，私聊写明只有这个人", async () => {
    const { render } = await prompts();
    assert.match(render("1"), /团体里的人都看得到这里的每句话/);
    assert.match(render("7"), /这里是你和林夏的私聊/);
    assert.match(render("7"), /别的成员看不到，创建者也看不到/);
  });

  test("私聊里转交之前要先说内容会公开", async () => {
    const { render } = await prompts();
    assert.match(render("7"), /先用一句话告诉他这些内容会公开到项目/);
    assert.doesNotMatch(render("1"), /先用一句话告诉他这些内容会公开到项目/);
  });

  test("引用项目报告时，主会话带原话，私聊不带", async () => {
    const { render } = await prompts();
    assert.match(render("1"), /把他的原话和引用的结果都写进 task/);
    assert.doesNotMatch(render("7"), /把他的原话/);
  });

  test("哪里都不再写个人 Agent", async () => {
    const { render } = await prompts();
    for (const session of ["1", "7", "9"]) assert.doesNotMatch(render(session), /个人 Agent/);
  });
});
