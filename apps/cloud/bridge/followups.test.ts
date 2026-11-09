import assert from "node:assert/strict";
import test from "node:test";
import { ANY_COMPUTER, DETACHED_TTL_MS, FollowUpStore, WAIT_TTL_MS } from "../src/bridge/followups.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_000_000_000;

test("电脑连上时取走等它的和等随便哪台的对话，每条对话一次", () => {
  const store = new FollowUpStore(sqlStorage());
  store.wait("c1", "s1", NOW);
  store.wait("c1", "s1", NOW + 1);
  store.wait(ANY_COMPUTER, "s2", NOW);
  store.wait("c2", "s3", NOW);
  assert.deepEqual(store.arrived("c1", NOW + 10).sort(), ["s1", "s2"]);
  assert.deepEqual(store.arrived("c1", NOW + 20), [], "取走了就不再叫");
  assert.deepEqual(store.arrived("c2", NOW + 20), ["s3"]);
});

test("等了一天还没连上的，不再叫", () => {
  const store = new FollowUpStore(sqlStorage());
  store.wait("c1", "s1", NOW);
  assert.deepEqual(store.arrived("c1", NOW + WAIT_TTL_MS + 1), []);
});

test("后台命令退出：按请求和电脑取回发起的对话，只取一次", () => {
  const store = new FollowUpStore(sqlStorage());
  store.detached({ requestId: "r1", session: "s1", computerId: "c1", command: "npm run build", startedAt: NOW });
  assert.equal(store.finished("r1", "c2", NOW), null, "别的电脑报的不认");
  assert.equal(store.finished("r1", "c1", NOW)?.session, "s1");
  assert.equal(store.finished("r1", "c1", NOW), null);
});

test("后台命令跑了一周以上，退出时不再回到对话", () => {
  const store = new FollowUpStore(sqlStorage());
  store.detached({ requestId: "r1", session: "s1", computerId: "c1", command: "x", startedAt: NOW });
  assert.equal(store.finished("r1", "c1", NOW + DETACHED_TTL_MS + 1), null);
});

test("电脑吊销、对话没了：相关的记录都清掉", () => {
  const store = new FollowUpStore(sqlStorage());
  store.wait("c1", "s1", NOW);
  store.detached({ requestId: "r1", session: "s1", computerId: "c1", command: "x", startedAt: NOW });
  store.wait("c2", "s2", NOW);
  store.detached({ requestId: "r2", session: "s2", computerId: "c2", command: "y", startedAt: NOW });
  store.forgetComputer("c1");
  store.forgetSession("s2");
  assert.deepEqual(store.arrived("c1", NOW), []);
  assert.equal(store.finished("r1", "c1", NOW), null);
  assert.deepEqual(store.arrived("c2", NOW), []);
  assert.equal(store.finished("r2", "c2", NOW), null);
});
