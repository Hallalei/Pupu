import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApprovalView } from "../src/bridge/approvals.ts";
import type { ComputerView } from "../src/bridge/protocol.ts";
import { ABORTED, blockedText } from "../src/bridge/blocked.ts";
import { buildRows, readable, type RowContext, type StepStatus } from "../src/client/chat-rows.ts";
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
    // 连着三步以上会合成一组，展开它才看得到每一步。
    toggled: new Set(messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "tool-call" ? [`group:${part.id}`] : []))))
  };
  return buildRows({ ...EMPTY_VIEW, messages, running: options.running }, context).flatMap((row) =>
    row.kind === "tool" ? [row.step.status] : []
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
