import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { begin, IDLE, restoreDraft, settle } from "../src/client/outbox.ts";

function ids() {
  let next = 0;
  return () => `m${++next}`;
}

describe("发消息：等服务端收下", () => {
  test("服务端收下了，回到空闲", () => {
    const sending = begin(IDLE, "跑一下测试", null, ids())!;
    assert.deepEqual(settle(sending, sending.sent.id, null), IDLE);
  });

  test("服务端拒了：字和引用都还在，原因留着", () => {
    const sending = begin(IDLE, "跑一下测试", "上面那段", ids())!;
    const failed = settle(sending, sending.sent.id, "今天的额度用完了");
    assert.equal(failed.status, "failed");
    assert.equal(failed.status === "failed" && failed.error, "今天的额度用完了");
    assert.equal(failed.status === "failed" && failed.sent.quote, "上面那段");
    assert.equal(restoreDraft("", sending.sent), "跑一下测试");
  });

  test("等回话时又打了字，放回时接在后面，一个字都不丢", () => {
    const sending = begin(IDLE, "第一句", null, ids())!;
    assert.equal(restoreDraft("第二句", sending.sent), "第一句\n第二句");
  });

  test("原样重发沿用 id，服务端按 operationId 只收一次；改过再发换新 id", () => {
    const newId = ids();
    const first = begin(IDLE, "跑一下测试", null, newId)!;
    const failed = settle(first, first.sent.id, "连接断了，这条没发出去。");
    assert.equal(begin(failed, "跑一下测试", null, newId)?.sent.id, first.sent.id);
    assert.notEqual(begin(failed, "跑一下测试吧", null, newId)?.sent.id, first.sent.id);
    assert.notEqual(begin(failed, "跑一下测试", "换了引用", newId)?.sent.id, first.sent.id);
  });

  test("上一条还没回话时不发第二条", () => {
    const sending = begin(IDLE, "第一句", null, ids())!;
    assert.equal(begin(sending, "第二句", null, ids()), null);
  });

  test("不是正在等的那条的回话，不改状态", () => {
    const sending = begin(IDLE, "第一句", null, ids())!;
    assert.equal(settle(sending, "别的", "拒了"), sending);
  });
});
