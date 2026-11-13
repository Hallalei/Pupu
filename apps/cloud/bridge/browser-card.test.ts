import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApprovalView } from "../src/bridge/approvals.ts";
import { parseUpFrame, type ComputerView } from "../src/bridge/protocol.ts";
import { buildRows, type BrowserTask, type ChatRow, type RowContext } from "../src/client/chat-rows.ts";
import type { TranscriptMessage } from "../src/protocol.ts";
import { EMPTY_VIEW } from "../src/view.ts";

const MAC: ComputerView = {
  id: "mac",
  name: "mbpro",
  ownerId: null,
  online: true,
  stale: false,
  lastSeenAt: 1,
  policy: "ask_all",
  screen: false,
  browser: true
};

let clock = 1;
function assistant(parts: TranscriptMessage["parts"]): TranscriptMessage {
  clock += 1;
  return { id: `a${clock}`, role: "assistant", timestamp: clock, parts };
}
function tool(id: string, name: string, args: Record<string, unknown>) {
  return { type: "tool-call" as const, id, name, arguments: { computer_id: "mac", ...args } };
}
function done(id: string, name: string, error = false): TranscriptMessage {
  clock += 1;
  return {
    id: `r-${id}`,
    role: "tool",
    timestamp: clock,
    parts: [{ type: "tool-result", id, name, content: [{ type: "text", text: "ok" }], error }]
  };
}
function user(text: string): TranscriptMessage {
  clock += 1;
  return { id: `u${clock}`, role: "user", timestamp: clock, parts: [{ type: "text", text }] };
}

function rows(messages: TranscriptMessage[], running: boolean, approvals: ApprovalView[] = []): ChatRow[] {
  const context: RowContext = { projectTags: false, projects: new Map(), computers: [MAC], approvals, members: [], toggled: new Set() };
  return buildRows({ ...EMPTY_VIEW, messages, running }, context);
}
function tasks(list: ChatRow[]): BrowserTask[] {
  return list.flatMap((row) => (row.kind === "browser" ? [row.task] : []));
}

describe("浏览器任务卡片", () => {
  test("说的话、计划、几步浏览器操作合成一张卡，正在做时显示在浏览哪", () => {
    const list = rows(
      [
        user("看看我的 mars"),
        assistant([
          { type: "text", text: "我在浏览器里打开你的后台，只看不动。" },
          { type: "tool-call", id: "p1", name: "browser_plan", arguments: { steps: [{ text: "打开后台" }, { text: "看余额" }] } }
        ]),
        done("p1", "browser_plan"),
        assistant([tool("o1", "browser_open", { url: "https://accounts.google.com/signin" })])
      ],
      true
    );
    assert.deepEqual(
      list.map((row) => row.kind),
      ["user", "assistant", "browser", "typing"]
    );
    const [task] = tasks(list);
    assert.equal(task!.state, "live");
    assert.equal(task!.status, "正在浏览 accounts.google.com");
    assert.equal(task!.computerId, "mac");
    assert.deepEqual(task!.plan, [
      { text: "打开后台", done: false },
      { text: "看余额", done: false }
    ]);
  });

  test("做完后带上 result：卡片收成一句结果，计划按最后一次", () => {
    const list = rows(
      [
        user("看看"),
        assistant([tool("o1", "browser_open", { url: "https://example.com" })]),
        done("o1", "browser_open"),
        assistant([tool("l1", "browser_read", {})]),
        done("l1", "browser_read"),
        assistant([
          { type: "tool-call", id: "p2", name: "browser_plan", arguments: { steps: [{ text: "打开", done: true }, { text: "读", done: true }], result: "余额 $30，订单正常" } }
        ]),
        done("p2", "browser_plan"),
        assistant([{ type: "text", text: "一切正常。" }])
      ],
      false
    );
    const [task] = tasks(list);
    assert.equal(tasks(list).length, 1);
    assert.equal(task!.state, "done");
    assert.equal(task!.result, "余额 $30，订单正常");
    assert.equal(task!.plan.every((step) => step.done), true);
    assert.equal(task!.steps.length, 2);
    assert.equal(list.at(-1)!.kind, "assistant");
  });

  test("取消任务后：最后一步做完了，但计划没勾完、没给结果，算停下，不算做完", () => {
    const list = rows(
      [
        user("做 12 轮"),
        assistant([{ type: "tool-call", id: "p1", name: "browser_plan", arguments: { steps: [{ text: "第 1 轮", done: true }, { text: "第 2 轮" }] } }]),
        done("p1", "browser_plan"),
        assistant([tool("l1", "browser_look", {})]),
        done("l1", "browser_look")
      ],
      false
    );
    const [task] = tasks(list);
    assert.equal(task!.state, "stopped");
    assert.equal(task!.status, "已停下");
  });

  test("最后一步请人接手、这一轮停了：等人在电脑上接手，人回话后这张卡不再等", () => {
    const handed = [
      assistant([tool("o1", "browser_open", { url: "https://a.test/login" })]),
      done("o1", "browser_open"),
      assistant([tool("s1", "browser_show", {})]),
      done("s1", "browser_show")
    ];
    const [waiting] = tasks(rows(handed, false));
    assert.equal(waiting!.state, "waiting");
    assert.equal(waiting!.status, "等你在电脑上的 Pupu 里接手");
    const [running] = tasks(rows(handed, true));
    assert.equal(running!.state, "live");
    // 人回了话（说好了，或者点了「取消任务」替人说不做了）：停在交接上，不算做完。
    const [after] = tasks(rows([...handed, user("好了")], false));
    assert.equal(after!.state, "stopped");
    assert.equal(after!.status, "交给你接手了");
    const [failed] = tasks(rows([handed[0]!, handed[1]!, handed[2]!, done("s1", "browser_show", true)], false));
    assert.notEqual(failed!.state, "waiting");
  });

  test("用户发了新消息，下一段浏览器操作另起一张卡", () => {
    const list = rows(
      [
        assistant([tool("o1", "browser_open", { url: "https://a.test" })]),
        done("o1", "browser_open"),
        user("再看看别的"),
        assistant([tool("o2", "browser_open", { url: "https://b.test" })])
      ],
      true
    );
    const found = tasks(list);
    assert.equal(found.length, 2);
    assert.equal(found[0]!.state, "done");
    assert.equal(found[1]!.state, "live");
    assert.equal(found[1]!.status, "正在浏览 b.test");
  });

  test("停在一步等批：状态写等你批准", () => {
    const approval: ApprovalView = {
      id: "ap",
      callId: "c1",
      computerId: "mac",
      computerName: "mbpro",
      kind: "step",
      title: "在 Pupu 浏览器里点击",
      detail: "提交",
      reason: null,
      createdAt: 1,
      expiresAt: 2
    };
    const list = rows([assistant([tool("c1", "browser_click", { ref: 3, label: "提交", sensitive: true })])], true, [approval]);
    const [task] = tasks(list);
    assert.equal(task!.state, "waiting");
    assert.match(task!.status, /^等你批准/);
  });

  test("这一轮停了又没结果：已停下；最后一步失败：没做完", () => {
    const stopped = tasks(rows([assistant([tool("o1", "browser_open", { url: "https://a.test" })])], false));
    assert.equal(stopped[0]!.state, "stopped");
    const failed = tasks(rows([assistant([tool("o1", "browser_open", { url: "https://a.test" })]), done("o1", "browser_open", true)], false));
    assert.equal(failed[0]!.state, "failed");
  });

  test("带 sensitive 填的内容不显示在步骤里", () => {
    const [task] = tasks(rows([assistant([tool("t1", "browser_type", { ref: 2, text: "secret-otp", sensitive: true })])], true));
    assert.doesNotMatch(task!.steps[0]!.title, /secret-otp/);
  });
});

describe("浏览器画面帧", () => {
  const frame = { type: "browser-frame", jpeg: "QUJD", width: 960, height: 600, url: "https://a.test/", title: "A", at: 5 };
  test("合法的帧收下", () => {
    assert.deepEqual(parseUpFrame(JSON.stringify(frame)), frame);
  });
  test("不是 base64、太大、尺寸不对的不收", () => {
    assert.equal(parseUpFrame(JSON.stringify({ ...frame, jpeg: "<script>" })), null);
    assert.equal(parseUpFrame(JSON.stringify({ ...frame, jpeg: "A".repeat(700_000) })), null);
    assert.equal(parseUpFrame(JSON.stringify({ ...frame, width: 0 })), null);
    assert.equal(parseUpFrame(JSON.stringify({ ...frame, height: 99999 })), null);
  });
});
