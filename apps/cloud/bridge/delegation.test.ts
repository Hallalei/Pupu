import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mayOpen } from "../src/access.ts";
import { childReport, mayCall, reportsWait, REPORT_LIMIT, SpaceSessionStore } from "../src/delegation.ts";
import { createDelegationTools } from "../src/delegation.ts";
import { renderPrompt } from "../src/prompt.ts";
import { ProjectStore, type SpaceWriter } from "../src/projects.ts";
import { ReportStore } from "../src/reports.ts";
import { MAIN_SESSION, ThreadStore, type Thread } from "../src/threads.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_800_000_000_000;

function writer(sql: SqlStorage): SpaceWriter {
  const run = async (query: string, ...params: (string | number | null)[]) => sql.exec(query, ...params);
  return { run, transaction: (callback) => callback({ run }) };
}

/** 空间「官网改版」主会话 9，切成协调模式；另一个普通项目「周报」会话 5。 */
async function space() {
  const sql = sqlStorage();
  const projects = new ProjectStore(sql);
  const children = new SpaceSessionStore(sql);
  const threads = new ThreadStore(sql, projects, (session) => {
    const child = children.bySession(session);
    const project = child && projects.getProject(child.projectId);
    return project && { project, title: child.title };
  });
  const site = projects.insertProject({ session: "9", name: "官网改版", goal: "上线", background: "" });
  await projects.setMode(writer(sql), site.id, "coordinator", NOW);
  const weekly = projects.insertProject({ session: "5", name: "周报", goal: "", background: "" });
  const submitted: { session: string; text: string; operationId: string }[] = [];
  const stopped: string[] = [];
  let next = 20;
  const tools = createDelegationTools({
    threadOf: (session) => threads.of(session),
    children,
    createSession: async () => String(next++),
    submit: async (session, text, operationId) => {
      submitted.push({ session, text, operationId });
    },
    stop: async (session) => {
      stopped.push(session);
      return true;
    },
    now: () => NOW,
    changed: () => {}
  });
  const run = (name: string, args: unknown, session: string, callId = `call-${name}`) => {
    const tool = tools.find((each) => each.name === name) as unknown as {
      execute(args: unknown, api: unknown): Promise<{ output: { text: string }[]; isError?: boolean }>;
    };
    return tool.execute(args, { conversationId: session, callId });
  };
  return { sql, projects, children, threads, site: projects.getProject(site.id)!, weekly, submitted, stopped, run };
}

describe("谁能调什么工具", () => {
  test("协调模式的主会话只能委派，别的工具在 beforeTool 里拦下", async () => {
    const { threads } = await space();
    const main = threads.of("9");
    assert.equal(mayCall(main, "delegate"), undefined);
    assert.equal(mayCall(main, "list_projects"), undefined);
    assert.ok(mayCall(main, "run_command"));
    assert.ok(mayCall(main, "connector_run"));
  });

  test("普通项目、聊天、子会话都不能委派，别的工具照旧", async () => {
    const pupu = await space();
    await pupu.run("delegate", { title: "排版", task: "改" }, "9");
    for (const session of ["5", MAIN_SESSION, "20"]) {
      const thread = pupu.threads.of(session);
      assert.ok(mayCall(thread, "delegate"), session);
      assert.ok(mayCall(thread, "message_child"), session);
      assert.equal(mayCall(thread, "run_command"), undefined, session);
    }
  });
});

describe("派活", () => {
  test("派一件事：新开子会话，送去任务，记成在做", async () => {
    const pupu = await space();
    const result = await pupu.run("delegate", { title: "定价页排版", task: "改成竖排" }, "9");
    assert.equal(result.isError, undefined);
    assert.equal(pupu.submitted.length, 1);
    assert.equal(pupu.submitted[0]!.session, "20");
    assert.match(pupu.submitted[0]!.text, /改成竖排/);
    const thread = pupu.threads.of("20");
    assert.equal(thread?.kind, "child");
    assert.equal(thread?.kind === "child" && thread.title, "定价页排版");
    assert.equal(pupu.children.busy(pupu.site.id), true);
  });

  test("同一次调用重放，不会开第二个子会话", async () => {
    const pupu = await space();
    await pupu.run("delegate", { title: "排版", task: "改" }, "9", "same");
    await pupu.run("delegate", { title: "排版", task: "改" }, "9", "same");
    assert.equal(pupu.children.ofProject(pupu.site.id).length, 1);
    assert.deepEqual(
      pupu.submitted.map((each) => each.operationId),
      ["delegate:same", "delegate:same"]
    );
  });

  test("不是协调模式的会话派不了", async () => {
    const pupu = await space();
    for (const session of ["5", MAIN_SESSION]) {
      const result = await pupu.run("delegate", { title: "x", task: "y" }, session);
      assert.equal(result.isError, true);
    }
    assert.equal(pupu.submitted.length, 0);
  });

  test("只能对自己空间的子会话发话、停下", async () => {
    const pupu = await space();
    await pupu.run("delegate", { title: "排版", task: "改" }, "9");
    pupu.children.add({ session: "30", projectId: pupu.weekly.id, title: "别人的", operation: "o" }, NOW);
    assert.equal((await pupu.run("message_child", { child_id: "30", message: "hi" }, "9")).isError, true);
    assert.equal((await pupu.run("stop_child", { child_id: "30" }, "9")).isError, true);
    assert.equal((await pupu.run("message_child", { child_id: "20", message: "按钮也改" }, "9")).isError, undefined);
    await pupu.run("stop_child", { child_id: "20" }, "9");
    assert.deepEqual(pupu.stopped, ["20"]);
    assert.equal(pupu.children.busy(pupu.site.id), false);
  });

  test("列出子会话和状态", async () => {
    const pupu = await space();
    await pupu.run("delegate", { title: "排版", task: "改" }, "9");
    const listed = (await pupu.run("list_children", {}, "9")).output[0]!.text;
    assert.match(listed, /排版（id: 20）：正在做/);
  });
});

describe("回报", () => {
  test("还有子会话在做，从聊天转来的事先不报；回投之后的那一轮才报", async () => {
    const pupu = await space();
    const main = pupu.threads.of("9");
    await pupu.run("delegate", { title: "排版", task: "改" }, "9");
    assert.equal(reportsWait(main, pupu.children, NOW), true);
    // 子会话做完、回投：主会话处理回投的那一轮（提问时间晚于回投）才报。
    pupu.children.markIdle("20", NOW + 5);
    pupu.children.markReported("20", NOW + 6);
    assert.equal(reportsWait(main, pupu.children, NOW + 7), false);
    assert.equal(reportsWait(pupu.threads.of(MAIN_SESSION), pupu.children, NOW), false);
  });

  test("子会话比主会话先做完：主会话说「派出去了」的那一轮还不报", async () => {
    const pupu = await space();
    const main = pupu.threads.of("9");
    // 主会话这一轮在 NOW 提问，派活；子会话很快做完，在主会话回完之前就回投了。
    await pupu.run("delegate", { title: "排版", task: "改" }, "9");
    pupu.children.markIdle("20", NOW + 1);
    pupu.children.markReported("20", NOW + 2);
    assert.equal(pupu.children.busy(pupu.site.id), false);
    assert.equal(reportsWait(main, pupu.children, NOW), true);
  });

  test("排着队的 message_child 还没做，前一轮回完不算空着", async () => {
    const pupu = await space();
    await pupu.run("delegate", { title: "排版", task: "改" }, "9");
    pupu.children.markBusy("20", NOW + 10);
    pupu.children.markIdle("20", NOW + 1);
    assert.equal(pupu.children.busy(pupu.site.id), true);
    pupu.children.markIdle("20", NOW + 10);
    assert.equal(pupu.children.busy(pupu.site.id), false);
  });

  test("停下的子会话不管排队，直接空出来", async () => {
    const pupu = await space();
    await pupu.run("delegate", { title: "排版", task: "改" }, "9");
    pupu.children.markBusy("20", NOW + 10);
    pupu.children.markIdle("20");
    assert.equal(pupu.children.busy(pupu.site.id), false);
  });

  test("回报带子会话的名字，太长的截断", () => {
    assert.match(childReport("排版", "改好了"), /子会话「排版」回报：\n改好了/);
    const long = childReport("排版", "字".repeat(REPORT_LIMIT + 50));
    assert.ok(long.includes("截断"));
    assert.ok(long.length < REPORT_LIMIT + 120);
  });
});

describe("子会话的可见范围和提示词", () => {
  test("子会话的受众就是它的空间", async () => {
    const pupu = await space();
    await pupu.run("delegate", { title: "排版", task: "改" }, "9");
    await pupu.projects.setLevel(writer(pupu.sql), pupu.site.id, "L3", NOW);
    await pupu.projects.addMember(writer(pupu.sql), pupu.site.id, "m1", "m1", NOW);
    const child = pupu.threads.of("20");
    assert.equal(mayOpen(child, "m1"), true);
    assert.equal(mayOpen(child, "m2"), false);
  });

  test("主会话的提示词说只委派、列出子会话；子会话的提示词说只做这件事", async () => {
    const pupu = await space();
    await pupu.run("delegate", { title: "排版", task: "改" }, "9");
    const prompt = (session: string) =>
      renderPrompt(
        pupu.threads.of(session) as Thread,
        pupu.projects,
        new ReportStore(pupu.sql),
        [],
        [],
        () => "某人",
        pupu.children.ofProject(pupu.site.id)
      );
    assert.match(prompt("9"), /只做两件事/);
    assert.match(prompt("9"), /排版（id: 20）：正在做/);
    assert.match(prompt("20"), /只负责一件事：「排版」/);
    assert.doesNotMatch(prompt("5"), /只做两件事/);
  });
});
