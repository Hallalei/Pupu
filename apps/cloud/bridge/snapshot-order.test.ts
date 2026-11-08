import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSnapshotOrder } from "../src/client/snapshot-order.ts";

describe("网页状态：后回来的旧快照不盖新的", () => {
  test("先发的晚回来，整份都不用", () => {
    const order = createSnapshotOrder();
    const slow = order.start();
    const fast = order.start();
    assert.deepEqual(order.arrived(fast), { state: true, activity: true, outcome: true });
    assert.deepEqual(order.arrived(slow), { state: false, activity: false, outcome: false });
  });

  test("按顺序回来的都用", () => {
    const order = createSnapshotOrder();
    assert.equal(order.arrived(order.start()).state, true);
    assert.equal(order.arrived(order.start()).state, true);
  });

  test("拉取发出之后推来了 activity：快照里的其余照用，activity 不回退", () => {
    const order = createSnapshotOrder();
    const ticket = order.start();
    order.pushed();
    assert.deepEqual(order.arrived(ticket), { state: true, activity: false, outcome: true });
  });

  test("推送之后才发的拉取，activity 照用", () => {
    const order = createSnapshotOrder();
    order.pushed();
    assert.equal(order.arrived(order.start()).activity, true);
  });

  test("新的那次成功了，旧的那次超时不再报连不上", () => {
    const order = createSnapshotOrder();
    const slow = order.start();
    order.arrived(order.start());
    assert.equal(order.failed(slow), false);
  });

  test("新的那次失败了，旧的那次晚回来：内容照用，错误留着", () => {
    const order = createSnapshotOrder();
    const slow = order.start();
    assert.equal(order.failed(order.start()), true);
    assert.deepEqual(order.arrived(slow), { state: true, activity: true, outcome: false });
  });
});
