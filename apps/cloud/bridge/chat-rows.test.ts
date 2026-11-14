import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApprovalView } from "../src/bridge/approvals.ts";
import type { ComputerView } from "../src/bridge/protocol.ts";
import { ABORTED, blockedText } from "../src/bridge/blocked.ts";
import { buildRows, dividerTime, readable, TIME_GAP, type RowContext, type StepStatus } from "../src/client/chat-rows.ts";
import type { TranscriptMessage } from "../src/protocol.ts";
import { EMPTY_VIEW } from "../src/view.ts";
import { noticeMessage } from "../src/messages.ts";

const MAC: ComputerView = {
  id: "mac",
  name: "mbpro",
  ownerId: null,
  online: true,
  stale: false,
  lastSeenAt: 1,
  policy: "ask_all",
  screen: false
};

function call(id: string): TranscriptMessage {
  return {
    id: `a-${id}`,
    role: "assistant",
    timestamp: 1,
    parts: [{ type: "tool-call", id, name: "run_command", arguments: { command: "npm test", computer_id: "mac" } }]
  };
}

function result(id: string, text: string, error: boolean): TranscriptMessage {
  return {
    id: `r-${id}`,
    role: "tool",
    timestamp: 2,
    parts: [{ type: "tool-result", id, name: "run_command", content: [{ type: "text", text }], error }]
  };
}

function approval(callId: string | undefined): ApprovalView {
  return {
    id: `approval-${callId ?? "sign-in"}`,
    ...(callId ? { callId } : {}),
    computerId: "mac",
    computerName: "mbpro",
    kind: "step",
    title: "在「mbpro」上跑命令",
    detail: "npm test",
    reason: null,
    createdAt: 1,
    expiresAt: 2
  };
}

function statuses(
  messages: TranscriptMessage[],
  options: { running: boolean; approvals?: ApprovalView[]; computers?: ComputerView[] }
): StepStatus[] {
  const context: RowContext = {
    projectTags: false,
    projects: new Map(),
    computers: options.computers ?? [MAC],
    approvals: options.approvals ?? [],
    members: [],
    toggled: new Set()
  };
  return buildRows({ ...EMPTY_VIEW, messages, running: options.running }, context).flatMap((row) =>
    row.kind === "computer" ? row.task.steps.map((step) => step.status) : []
  );
}

describe("对话里一步的状态", () => {
  test("同一台电脑上另一次调用在等批，这一步还是在做", () => {
    assert.deepEqual(statuses([call("mine")], { running: true, approvals: [approval("other")] }), ["running"]);
  });

  test("审批对着这次调用，这一步等你批准", () => {
    assert.deepEqual(statuses([call("mine")], { running: true, approvals: [approval("mine")] }), ["waiting"]);
  });

  test("不知道是哪台电脑时，别的审批也不算这一步的", () => {
    const messages = [call("mine")];
    assert.deepEqual(statuses(messages, { running: true, approvals: [approval("other")], computers: [] }), ["running"]);
    assert.deepEqual(statuses(messages, { running: true, approvals: [approval(undefined)], computers: [] }), ["running"]);
  });

  test("一轮里两步：只有对上审批的那步在等", () => {
    assert.deepEqual(
      statuses([call("first"), call("second")], { running: true, approvals: [approval("second")] }),
      ["running", "waiting"]
    );
  });

  test("这一轮停了还没有结果，算没做完", () => {
    assert.deepEqual(statuses([call("mine")], { running: false }), ["unfinished"]);
  });

  test("有结果就看结果，审批不再算", () => {
    const blocked = (why: string) => `<harness>\n[error] Tool call blocked: ${why}\n</harness>`;
    assert.deepEqual(
      statuses(
        [
          call("ok"),
          result("ok", "全过了", false),
          call("broken"),
          result("broken", "在「mbpro」上没做成：找不到 npm", true),
          call("denied"),
          result("denied", blocked("用户在手机上拒绝了这一步，没有执行：在「mbpro」上跑命令。不要重试"), true),
          call("expired"),
          result("expired", blocked("这条请示 10 分钟没人处理，已经作废，没有执行：在「mbpro」上跑命令。"), true)
        ],
        { running: true, approvals: [approval("ok")] }
      ),
      ["done", "failed", "denied", "expired"]
    );
  });

  test("等批准时这一轮停了，这一步算没做完，卡片上只留原因", () => {
    const text = blockedText(`等批准的时候${ABORTED}`, "在「mbpro」上跑命令", "要做的话重新来。");
    const wrapped = `<harness>\n[error] Tool call blocked: ${text}\n</harness>`;
    assert.deepEqual(statuses([call("stopped"), result("stopped", wrapped, true)], { running: false }), ["unfinished"]);
    assert.equal(readable(wrapped, "unfinished"), "等批准的时候这一轮停下了，这一步没有做。");
  });
});

test("系统消息画成居中的一行，只放第一句", () => {
  const notice: TranscriptMessage = {
    id: "n1",
    role: "user",
    timestamp: 3,
    parts: [{ type: "text", text: noticeMessage("「mbpro」上放到后台的命令跑完了，退出码 0：\n```\nnpm run build\n```") }]
  };
  const context: RowContext = { projectTags: false, projects: new Map(), computers: [MAC], approvals: [], members: [] };
  const rows = buildRows({ ...EMPTY_VIEW, messages: [notice], running: false }, context);
  assert.deepEqual(
    rows.map((row) => (row.kind === "notice" ? row.text : row.kind)),
    ["「mbpro」上放到后台的命令跑完了，退出码 0："]
  );
});

describe("电脑任务卡", () => {
  const context: RowContext = { projectTags: false, projects: new Map(), computers: [MAC], approvals: [], members: [], toggled: new Set() };
  const shot = (id: string, data: string): TranscriptMessage => ({
    id: `r-${id}`,
    role: "tool",
    timestamp: 2,
    parts: [
      {
        type: "tool-result",
        id,
        name: "computer_look",
        content: [
          { type: "text", text: "看了" },
          { type: "image", data, mimeType: "image/jpeg" }
        ],
        error: false
      }
    ]
  });
  const look = (id: string): TranscriptMessage => ({
    id: `a-${id}`,
    role: "assistant",
    timestamp: 1,
    parts: [{ type: "tool-call", id, name: "computer_look", arguments: { computer_id: "mac" } }]
  });
  const say = (id: string, text: string, role: "user" | "assistant"): TranscriptMessage => ({
    id,
    role,
    timestamp: 3,
    parts: [{ type: "text", text }]
  });
  const cards = (messages: TranscriptMessage[], running = false) =>
    buildRows({ ...EMPTY_VIEW, messages, running }, context).flatMap((row) => (row.kind === "computer" ? [row.task] : []));

  test("一轮里在同一台电脑上的几步合成一张卡，中间的话照常显示，带最近的画面", () => {
    const rows = buildRows(
      {
        ...EMPTY_VIEW,
        messages: [look("l1"), shot("l1", "first"), say("t1", "看到了，接着跑测试", "assistant"), call("c1"), result("c1", "全过了", false), look("l2"), shot("l2", "second")],
        running: false
      },
      context
    );
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["computer", "assistant"]
    );
    const task = rows[0]!.kind === "computer" ? rows[0]!.task : null;
    assert.equal(task?.computer, "mbpro");
    assert.equal(task?.computerId, "mac");
    assert.equal(task?.steps.length, 3);
    assert.equal(task?.state, "done");
    assert.equal(task?.usesScreen, true);
    assert.equal(task?.status, "用完了");
    assert.equal(task?.latest, "看了窗口");
    assert.equal(task?.screen?.data, "second");
  });

  test("用户说了话就另起一张", () => {
    assert.equal(cards([call("c1"), result("c1", "ok", false), say("u1", "再跑一次", "user"), call("c2"), result("c2", "ok", false)]).length, 2);
  });

  test("只跑命令的一步也是一张卡（ToolCallCard）；还在跑时是正在做，出错了写失败并默认展开", () => {
    const [live] = cards([call("c1")], true);
    assert.equal(live?.state, "live");
    assert.equal(live?.usesScreen, false);
    assert.equal(live?.status, "正在做");
    assert.equal(live?.screen, null);
    const [failed] = cards([call("c1"), result("c1", "找不到 npm", true)]);
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.status, "失败");
    assert.equal(failed?.expanded, true);
    const [done] = cards([call("c1"), result("c1", "ok", false)]);
    assert.equal(done?.status, "");
  });

  test("几步里有一步没成，组上写几件没成；用过屏幕的这一轮还在跑时是正在用", () => {
    const [group] = cards([call("c1"), result("c1", "找不到 npm", true), call("c2"), result("c2", "ok", false)]);
    assert.equal(group?.state, "done");
    assert.equal(group?.status, "1 件没成");
    const [screen] = cards([look("l1"), shot("l1", "first"), call("c1")], true);
    assert.equal(screen?.usesScreen, true);
    assert.equal(screen?.status, "正在用");
  });

  test("隔了半小时以上的消息前面有一条时间分隔线，分隔线也把卡片断开", () => {
    const at = (message: TranscriptMessage, timestamp: number): TranscriptMessage => ({ ...message, timestamp });
    const rows = buildRows(
      {
        ...EMPTY_VIEW,
        messages: [at(call("c1"), 1_000), at(result("c1", "ok", false), 1_001), at(call("c2"), 1_000 + TIME_GAP), at(result("c2", "ok", false), 1_002 + TIME_GAP)],
        running: false
      },
      context
    );
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["computer", "time", "computer"]
    );
    const time = rows[1]!;
    assert.equal(time.kind === "time" ? time.at : null, 1_000 + TIME_GAP);
    const steps = rows.flatMap((row) => (row.kind === "computer" ? row.task.steps.map((step) => step.at) : []));
    assert.deepEqual(steps, [1_000, 1_000 + TIME_GAP]);
  });

  test("分隔线上的字：今天、昨天、今年只写月日，往年带年份", () => {
    const now = new Date(2026, 10, 14, 16, 30).getTime();
    assert.equal(dividerTime(new Date(2026, 10, 14, 14, 2).getTime(), now), "今天 14:02");
    assert.equal(dividerTime(new Date(2026, 10, 13, 9, 5).getTime(), now), "昨天 09:05");
    assert.equal(dividerTime(new Date(2026, 10, 2, 8, 0).getTime(), now), "11月2日 08:00");
    assert.equal(dividerTime(new Date(2025, 0, 2, 8, 0).getTime(), now), "2025年1月2日 08:00");
  });
});
