import assert from "node:assert/strict";
import test from "node:test";
import { STALE_MS } from "../src/bridge/protocol.ts";
import {
  describeComputers,
  foregroundTimeoutMs,
  formatRun,
  fresh,
  selectComputer,
  type ComputerCandidate
} from "../src/bridge/status.ts";

function computer(patch: Partial<ComputerCandidate> & Pick<ComputerCandidate, "id" | "name">): ComputerCandidate {
  return {
    online: false,
    stale: false,
    lastSeenAt: null,
    ...patch
  };
}

test("没指定电脑时，一台在线就用它，多台在线要问", () => {
  const desk = computer({ id: "a", name: "书房", online: true });
  const laptop = computer({ id: "b", name: "笔记本", online: true });
  const none = selectComputer([], undefined);
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.text, /还没有授权的电脑/);
  const one = selectComputer([desk], undefined);
  assert.equal(one.ok && one.computer.id, "a");
  const many = selectComputer([desk, laptop], undefined);
  assert.equal(many.ok, false);
  if (!many.ok) assert.match(many.text, /请指定 computer_id/);
  const offline = selectComputer([computer({ id: "a", name: "书房" })], undefined);
  assert.equal(offline.ok, false);
  if (!offline.ok) assert.match(offline.text, /没连上/);
});

test("指定了电脑：没有、离线、心跳中断各说各的", () => {
  const desk = computer({ id: "a", name: "书房", stale: true, lastSeenAt: 1 });
  const missing = selectComputer([desk], "nope");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.text, /没有 id 为 nope/);
  const stale = selectComputer([desk], "a");
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.text, /心跳停了/);
  const offline = selectComputer([computer({ id: "a", name: "书房" })], "a");
  assert.equal(offline.ok, false);
  if (!offline.ok) assert.match(offline.text, /现在没连上/);
});

test("前台等待时间和心跳新鲜度有上限", () => {
  assert.equal(foregroundTimeoutMs(undefined), 30_000);
  assert.equal(foregroundTimeoutMs(0.1), 1000);
  assert.equal(foregroundTimeoutMs(999), 120_000);
  assert.equal(foregroundTimeoutMs(12), 12_000);
  assert.equal(fresh(1_000, 1_000 + STALE_MS), true);
  assert.equal(fresh(1_000, 1_000 + STALE_MS + 1), false);
});

test("命令结果告诉模型退出码、超时和输出文件", () => {
  const running = formatRun({
    name: "书房",
    commandId: "c1",
    outputPath: "/tmp/c1.log",
    output: "partial",
    truncated: false,
    end: { kind: "detached" }
  });
  assert.equal(running.ok, true);
  assert.match(running.text, /继续在后台跑/);
  assert.match(running.text, /\/tmp\/c1\.log/);
  const failed = formatRun({
    name: "书房",
    commandId: "c1",
    outputPath: "/tmp/c1.log",
    output: "",
    truncated: true,
    end: { kind: "exited", code: 1 }
  });
  assert.equal(failed.ok, false);
  assert.match(failed.text, /退出码 1/);
  assert.match(describeComputers([]), /还没有授权的电脑/);
  assert.match(describeComputers([computer({ id: "a", name: "书房", online: true })]), /书房（id: a）：在线/);
});
