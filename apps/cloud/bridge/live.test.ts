import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { RunningCall } from "../src/bridge/activity.ts";
import type { ApprovalRow } from "../src/bridge/approvals.ts";
import type { ComputerView } from "../src/bridge/protocol.ts";
import type { ApnsPush, ApnsResult } from "../src/push/apns.ts";
import { LINGER_S, LivePusher, liveContent, liveDue, type LiveInput } from "../src/push/live.ts";
import type { PushTokenRow, PushTokenType } from "../src/push/store.ts";

const T0 = 1_800_000_000_000;

function computer(id: string, name: string, over: Partial<ComputerView> = {}): ComputerView {
  return { id, name, online: true, stale: false, lastSeenAt: 1, policy: "ask_risky", screen: false, ...over };
}

function approval(id: string, over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id,
    callId: `call-${id}`,
    computerId: "c1",
    kind: "step",
    screen: false,
    title: "在「mbpro」上跑命令",
    detail: "git push\n  origin main",
    reason: "推送到远端仓库",
    status: "pending",
    note: null,
    createdAt: T0,
    expiresAt: T0 + 600_000,
    decidedAt: null,
    ...over
  };
}

function run(callId: string, computerId: string, command: string, startedAt: number): RunningCall {
  return { callId, computerId, action: { kind: "run", command, background: false }, startedAt };
}

function input(over: Partial<LiveInput> = {}): LiveInput {
  return {
    computers: [computer("c1", "mbpro"), computer("c2", "书房")],
    running: [],
    pending: [],
    screenUntil: () => null,
    ...over
  };
}

const none = new Map<string, number>();

describe("liveContent", () => {
  test("闲着、命令还没跑满 30 秒：不上灵动岛", () => {
    assert.equal(liveContent(input(), none, T0), null);
    assert.equal(liveContent(input({ running: [run("a", "c1", "npm test", T0)] }), none, T0 + 29_999), null);
  });

  test("命令跑满 30 秒：说在哪台电脑上跑什么，从开跑算起", () => {
    const content = liveContent(input({ running: [run("a", "c2", "npm run build", T0)] }), none, T0 + 30_000);
    assert.deepEqual(content, {
      mode: "command",
      computerId: "c2",
      computerName: "书房",
      title: "Pupu 正在「书房」上跑命令",
      detail: "npm run build",
      since: T0 / 1000,
      approvalId: null,
      pending: 0,
      screen: false,
      icon: "command"
    });
  });

  test("等批压过操作屏幕和长命令；最早的那条在前，数的是全部", () => {
    const content = liveContent(
      input({
        computers: [computer("c1", "mbpro", { screen: true })],
        running: [run("a", "c1", "npm test", T0 - 60_000)],
        pending: [approval("a1"), approval("a2", { createdAt: T0 + 5 })]
      }),
      none,
      T0 + 10
    );
    assert.equal(content?.mode, "approval");
    assert.equal(content?.title, "Pupu 想在「mbpro」上跑命令");
    assert.equal(content?.detail, "git push origin main");
    assert.equal(content?.approvalId, "a1");
    assert.equal(content?.pending, 2);
    assert.equal(content?.screen, true);
    assert.equal(content?.icon, "command");
  });

  test("屏幕授权的请示用屏幕图标", () => {
    const content = liveContent(
      input({ pending: [approval("a1", { kind: "screen", title: "在「mbpro」上操作屏幕", detail: "看屏幕" })] }),
      none,
      T0
    );
    assert.equal(content?.icon, "screen");
    assert.equal(content?.title, "Pupu 想在「mbpro」上操作屏幕");
  });

  test("操作屏幕期间一直在，显示最近动过的那台，从授权开始算", () => {
    const content = liveContent(
      input({
        computers: [computer("c1", "mbpro", { screen: true }), computer("c2", "书房", { screen: true })],
        running: [run("a", "c1", "ls", T0 - 5000), run("b", "c2", "ls", T0 - 1000)]
      }),
      new Map([["c2", T0 - 180_000]]),
      T0
    );
    assert.equal(content?.mode, "screen");
    assert.equal(content?.computerName, "书房");
    assert.equal(content?.title, "Pupu 正在操作「书房」的屏幕");
    assert.equal(content?.detail, null);
    assert.equal(content?.since, (T0 - 180_000) / 1000);
    assert.equal(content?.screen, true);
  });

  test("离线的电脑不算在操作屏幕", () => {
    assert.equal(liveContent(input({ computers: [computer("c1", "mbpro", { screen: true, online: false })] }), none, T0), null);
  });
});

test("liveDue：下一条命令跑满 30 秒，或者屏幕授权到期，取早的", () => {
  const base = input({
    computers: [computer("c1", "mbpro", { screen: true })],
    running: [run("a", "c1", "ls", T0 - 40_000), run("b", "c1", "ls", T0 - 10_000)],
    screenUntil: () => T0 + 15 * 60_000
  });
  assert.equal(liveDue(base, T0), T0 + 20_000);
  assert.equal(liveDue({ ...base, running: [] }, T0), T0 + 15 * 60_000);
  assert.equal(liveDue(input(), T0), null);
});

class Tokens {
  rows: PushTokenRow[] = [];

  add(deviceId: string, type: PushTokenType, token: string) {
    this.rows = this.rows.filter((row) => !(row.deviceId === deviceId && row.type === type));
    this.rows.push({ token, type, deviceId, env: "sandbox", createdAt: 1, lastSeen: 1 });
  }

  tokens(type: PushTokenType) {
    return this.rows.filter((row) => row.type === type);
  }

  remove(token: string) {
    this.rows = this.rows.filter((row) => row.token !== token);
  }
}

function setup(answers: ApnsResult[] = []) {
  const store = new Tokens();
  const sent: ApnsPush[] = [];
  let saved: string | undefined;
  let now = T0;
  let apnsOn = true;
  const pusher = new LivePusher({
    store,
    apns: () =>
      apnsOn
        ? {
            send: async (push: ApnsPush) => {
              sent.push(push);
              return answers.shift() ?? { status: 200, reason: null, gone: false };
            }
          }
        : null,
    state: { get: () => saved, set: (value) => (saved = value) },
    now: () => now
  });
  return {
    store,
    sent,
    pusher,
    advance: (ms: number) => (now += ms),
    apnsOff: () => (apnsOn = false),
    aps: (index: number) => (sent[index]!.payload as { aps: Record<string, unknown> }).aps
  };
}

const waiting = input({ pending: [approval("a1")] });
const twoWaiting = input({ pending: [approval("a1"), approval("a2")] });

describe("LivePusher", () => {
  test("没配 APNs：什么都不推", async () => {
    const { store, sent, pusher, apnsOff } = setup();
    store.add("phone", "start", "s".repeat(64));
    apnsOff();
    await pusher.sync(waiting);
    assert.equal(sent.length, 0);
  });

  test("有事、手机还没有活动：用 push-to-start 开一个，带 attributes 和空的 alert", async () => {
    const { store, sent, pusher, aps } = setup();
    store.add("phone", "start", "s".repeat(64));
    await pusher.sync(waiting);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.type, "liveactivity");
    assert.equal(sent[0]!.token, "s".repeat(64));
    assert.equal(sent[0]!.priority, 10);
    const start = aps(0);
    assert.equal(start.event, "start");
    assert.equal(start["attributes-type"], "PupuActivityAttributes");
    assert.deepEqual(start.attributes, { startedAt: T0 / 1000 });
    assert.deepEqual(start.alert, { title: "", body: "" });
    assert.equal((start["content-state"] as { approvalId: string }).approvalId, "a1");

    // 还在等它报 token：同样的内容、变了的内容，都先不再开。
    await pusher.sync(waiting);
    await pusher.sync(twoWaiting);
    assert.equal(sent.length, 1);
  });

  test("活动报上 token 后：内容变了推 update，没变不推；变成等批时立刻投", async () => {
    const { store, sent, pusher, aps, advance } = setup();
    store.add("phone", "start", "s".repeat(64));
    const longRun = input({ running: [run("a", "c1", "npm test", T0)] });
    advance(30_000);
    await pusher.sync(longRun);
    assert.equal(aps(0).event, "start");

    store.add("phone", "activity", "a".repeat(64));
    await pusher.sync(longRun);
    assert.equal(sent.length, 1, "开活动时带的就是这个内容，不用再推");

    await pusher.sync({ ...longRun, pending: [approval("a1")] });
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.token, "a".repeat(64));
    assert.equal(aps(1).event, "update");
    assert.equal(sent[1]!.priority, 10);

    await pusher.sync({ ...longRun, pending: [approval("a1"), approval("a2")] });
    assert.equal(aps(2).event, "update");
    assert.equal(sent[2]!.priority, 5, "已经在等批了，多一条不用立刻投");
  });

  test("开活动后、报 token 前内容变了：token 到了补一条 update", async () => {
    const { store, sent, pusher, aps } = setup();
    store.add("phone", "start", "s".repeat(64));
    await pusher.sync(waiting);
    await pusher.sync(twoWaiting);
    store.add("phone", "activity", "a".repeat(64));
    await pusher.sync(twoWaiting);
    assert.equal(sent.length, 2);
    assert.equal(aps(1).event, "update");
    assert.equal((aps(1)["content-state"] as { pending: number }).pending, 2);
  });

  test("做完了：推 end，说做完了，锁屏上留 2 分钟，活动 token 删掉", async () => {
    const { store, sent, pusher, aps } = setup();
    store.add("phone", "start", "s".repeat(64));
    store.add("phone", "activity", "a".repeat(64));
    await pusher.sync(waiting);
    await pusher.sync(input());
    const end = aps(1);
    assert.equal(end.event, "end");
    assert.equal(end["dismissal-date"], T0 / 1000 + LINGER_S);
    const state = end["content-state"] as { mode: string; title: string; approvalId: string | null };
    assert.equal(state.mode, "done");
    assert.equal(state.title, "Pupu 在「mbpro」上的事做完了");
    assert.equal(state.approvalId, null);
    assert.deepEqual(store.tokens("activity"), []);

    // 再来一件事：开一个新的。
    await pusher.sync(waiting);
    assert.equal(aps(2).event, "start");
  });

  test("在锁屏上划掉了：同一件事不再开，换了件事才开", async () => {
    const { store, sent, pusher, aps, advance } = setup();
    store.add("phone", "start", "s".repeat(64));
    await pusher.sync(waiting);
    store.add("phone", "activity", "a".repeat(64));
    await pusher.sync(waiting);
    // 手机报活动没了，token 删掉。
    store.remove("a".repeat(64));
    advance(10 * 60_000);
    await pusher.sync(waiting);
    assert.equal(sent.length, 1);
    await pusher.sync(twoWaiting);
    assert.equal(sent.length, 2);
    assert.equal(aps(1).event, "start");
  });

  test("APNs 说 token 用不了：删掉", async () => {
    const { store, pusher } = setup([{ status: 410, reason: "Unregistered", gone: true }]);
    store.add("phone", "start", "s".repeat(64));
    await pusher.sync(waiting);
    assert.deepEqual(store.tokens("start"), []);
  });
});
