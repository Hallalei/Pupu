import assert from "node:assert/strict";
import test from "node:test";
import { CallSessions, computerActivity, describeDoing, type RunningCall } from "../src/bridge/activity.ts";
import type { ApprovalRow } from "../src/bridge/approvals.ts";
import type { ComputerView } from "../src/bridge/protocol.ts";

function computer(id: string, name: string, over: Partial<ComputerView> = {}): ComputerView {
  return { id, name, online: true, stale: false, lastSeenAt: 1, policy: "ask_risky", screen: false, ...over };
}

function approval(over: Partial<ApprovalRow> & Pick<ApprovalRow, "id" | "callId" | "computerId">): ApprovalRow {
  return {
    kind: "step",
    screen: false,
    title: "在「mbpro」上跑命令",
    detail: "git push origin main",
    reason: "推送到远端仓库",
    session: null,
    status: "pending",
    note: null,
    createdAt: 100,
    expiresAt: 10_000,
    decidedAt: null,
    ...over
  };
}

function run(callId: string, computerId: string, command: string, startedAt: number): RunningCall {
  return { callId, computerId, action: { kind: "run", command, background: false }, startedAt };
}

const projects: Record<string, { id: string; name: string }> = {
  "call-push": { id: "p1", name: "官网改版" },
  "call-test": { id: "p2", name: "周报" }
};
const projectOf = (callId: string) => projects[callId] ?? null;

test("在线闲着、离线都只报状态，不说在做什么", () => {
  const [idle, offline] = computerActivity({
    computers: [computer("c1", "mbpro"), computer("c2", "书房", { online: false, stale: true })],
    running: [],
    pending: [],
    projectOf
  });
  assert.deepEqual(idle, {
    computerId: "c1",
    computerName: "mbpro",
    state: "idle",
    doing: null,
    reason: null,
    project: null,
    since: null,
    pending: 0,
    running: 0,
    screen: false
  });
  assert.equal(offline?.state, "offline");
  assert.equal(offline?.doing, null);
});

test("正在跑的说最新的那件，带上是哪个项目", () => {
  const [mbpro] = computerActivity({
    computers: [computer("c1", "mbpro")],
    running: [run("call-test", "c1", "npm test", 300), run("call-other", "c1", "ls", 200)],
    pending: [],
    projectOf
  });
  assert.equal(mbpro?.state, "working");
  assert.equal(mbpro?.doing, "跑命令：npm test");
  assert.deepEqual(mbpro?.project, { id: "p2", name: "周报" });
  assert.equal(mbpro?.since, 300);
  assert.equal(mbpro?.running, 2);
});

test("有请示等批时先说等批的那条，最早来的在前", () => {
  const [mbpro, other] = computerActivity({
    computers: [computer("c1", "mbpro", { screen: true }), computer("c2", "书房")],
    running: [run("call-test", "c1", "npm test", 300)],
    pending: [
      approval({ id: "a1", callId: "call-push", computerId: "c1", createdAt: 150 }),
      approval({ id: "a2", callId: "call-x", computerId: "c1", createdAt: 160, title: "在「mbpro」上写文件" })
    ],
    projectOf
  });
  assert.equal(mbpro?.state, "waiting");
  assert.equal(mbpro?.doing, "跑命令：git push origin main");
  assert.equal(mbpro?.reason, "推送到远端仓库");
  assert.deepEqual(mbpro?.project, { id: "p1", name: "官网改版" });
  assert.equal(mbpro?.since, 150);
  assert.equal(mbpro?.pending, 2);
  assert.equal(mbpro?.running, 1);
  assert.equal(mbpro?.screen, true);
  // 别的电脑的请示不算在它头上。
  assert.equal(other?.state, "idle");
  assert.equal(other?.pending, 0);
});

test("屏幕授权的请示只说操作屏幕；离线的电脑照样数等批的", () => {
  const [mbpro] = computerActivity({
    computers: [computer("c1", "mbpro", { online: false })],
    running: [],
    pending: [
      approval({
        id: "a1",
        callId: "call-screen",
        computerId: "c1",
        kind: "screen",
        title: "在「mbpro」上操作屏幕",
        detail: "看这台电脑的屏幕，用鼠标和键盘操作它。",
        reason: null
      })
    ],
    projectOf
  });
  assert.equal(mbpro?.state, "offline");
  assert.equal(mbpro?.pending, 1);

  const [online] = computerActivity({
    computers: [computer("c1", "mbpro")],
    running: [],
    pending: [approval({ id: "a1", callId: "call-screen", computerId: "c1", kind: "screen", title: "在「mbpro」上操作屏幕" })],
    projectOf
  });
  assert.equal(online?.doing, "操作屏幕");
});

test("在做什么说成一行：长命令截断，屏幕操作不报坐标", () => {
  const long = describeDoing({ kind: "run", command: `echo ${"x".repeat(100)}\nls`, background: false });
  assert.equal(long.length, "跑命令：".length + 60 + 1);
  assert.ok(long.endsWith("…"));
  assert.equal(describeDoing({ kind: "run", command: "git status\n  && ls", background: false }), "跑命令：git status && ls");
  assert.equal(describeDoing({ kind: "computer", op: "screenshot" }), "看屏幕");
  assert.equal(describeDoing({ kind: "computer", op: "click", x: 10, y: 20 }), "点击屏幕");
  assert.equal(describeDoing({ kind: "read", path: "/Users/me/a.txt", maxBytes: 10 }), "读文件：/Users/me/a.txt");
});

test("调用的会话只记最近的这些", () => {
  const sessions = new CallSessions(2);
  sessions.remember("a", "s1");
  sessions.remember("b", "s2");
  sessions.remember("a", "s1");
  sessions.remember("c", "s3");
  assert.equal(sessions.of("b"), null);
  assert.equal(sessions.of("a"), "s1");
  assert.equal(sessions.of("c"), "s3");
});
