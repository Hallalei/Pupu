import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { ApprovalDirectory, ApprovalRow, ApprovalStatus } from "../src/bridge/approvals.ts";
import { APPROVAL_TTL_MS, ComputerGate } from "../src/bridge/gate.ts";
import type { ComputerPolicy } from "../src/bridge/policy.ts";
import type { ComputerView } from "../src/bridge/protocol.ts";
import type { ComputerRow } from "../src/bridge/store.ts";

class MemoryApprovals implements ApprovalDirectory {
  readonly rows: ApprovalRow[] = [];

  byId(id: string) {
    return this.rows.find((row) => row.id === id);
  }

  byCall(callId: string) {
    return this.rows.find((row) => row.callId === callId);
  }

  insert(input: Omit<ApprovalRow, "id" | "status" | "note" | "decidedAt">): ApprovalRow {
    const row: ApprovalRow = { ...input, id: `a${this.rows.length + 1}`, status: "pending", note: null, decidedAt: null };
    this.rows.push(row);
    return row;
  }

  settle(id: string, status: Exclude<ApprovalStatus, "pending">, at: number, note?: string): boolean {
    const index = this.rows.findIndex((row) => row.id === id && row.status === "pending");
    if (index === -1) return false;
    this.rows[index] = { ...this.rows[index]!, status, decidedAt: at, note: note ?? null };
    return true;
  }

  pending(now: number) {
    return this.rows.filter((row) => row.status === "pending" && row.expiresAt > now);
  }

  sweep(now: number) {
    let changed = 0;
    for (const row of this.rows) {
      if (row.status === "pending" && row.expiresAt <= now && this.settle(row.id, "expired", now)) changed += 1;
    }
    return changed;
  }
}

function setup(policy: ComputerPolicy = "ask_risky") {
  let now = 1_000_000;
  let computer: ComputerRow = {
    id: "c1",
    name: "mbpro",
    tokenHash: "h",
    localRoot: "/Users/me",
    terminalsFolder: "/Users/me/.pupu/terminals",
    createdAt: 1,
    revokedAt: null,
    lastSeenAt: now,
    policy,
    screenUntil: null
  };
  const approvals = new MemoryApprovals();
  const changes: string[][] = [];
  const view = (): ComputerView => ({
    id: computer.id,
    name: computer.name,
    online: true,
    stale: false,
    lastSeenAt: now,
    policy: computer.policy,
    screen: computer.screenUntil !== null && computer.screenUntil > now
  });
  const options = {
    computers: () => [view()],
    directory: {
      list: () => [computer],
      setPolicy: (_id: string, next: ComputerPolicy) => {
        computer = { ...computer, policy: next };
        return true;
      },
      setScreenUntil: (_id: string, until: number | null) => {
        computer = { ...computer, screenUntil: until };
      }
    },
    approvals,
    now: () => now,
    onChange: (ids: readonly string[]) => {
      changes.push([...ids]);
    }
  };
  return {
    gate: new ComputerGate(options),
    /** 同一份存储上再开一道门，模拟 DO 被回收后重启。 */
    restart: () => new ComputerGate(options),
    approvals,
    changes,
    tick: (ms: number) => {
      now += ms;
    }
  };
}

const run = (id: string, command: string) => ({ id, name: "run_command", arguments: { command } });
const shot = (id: string) => ({ id, name: "computer_look", arguments: {} });

/** 让 beforeTool 跑到开始等的那一步。 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("审批", () => {
  test("低风险命令不问，也不算批过", async () => {
    const { gate, approvals } = setup();
    assert.equal(await gate.beforeTool(run("t1", "ls")), undefined);
    assert.equal(approvals.rows.length, 0);
    assert.equal(gate.approved({ requestId: "t1", computerId: "c1", action: { kind: "run", command: "ls", background: false } }), false);
  });

  test("高风险命令等用户批准，批了才放行，exec 帧带 approved", async () => {
    const { gate, approvals } = setup();
    const waiting = gate.beforeTool(run("t1", "rm -rf build"));
    await settle();
    const [row] = gate.pending();
    assert.equal(row?.title, "在「mbpro」上跑命令");
    assert.equal(row?.reason, "删除文件");
    assert.equal(gate.statusFor("c1").pending[0], "跑命令：rm -rf build");
    assert.equal(gate.decide(row!.id, "allow"), "ok");
    assert.equal(await waiting, undefined);
    assert.equal(approvals.rows[0]?.status, "allowed");
    assert.equal(
      gate.approved({ requestId: "t1", computerId: "c1", action: { kind: "run", command: "rm -rf build", background: false } }),
      true
    );
    assert.equal(gate.decide(row!.id, "deny"), "settled");
  });

  test("拒绝了就拦下，告诉模型换个做法", async () => {
    const { gate } = setup();
    const waiting = gate.beforeTool(run("t1", "git push"));
    await settle();
    gate.decide(gate.pending()[0]!.id, "deny");
    const result = await waiting;
    assert.match(result?.block ?? "", /用户在手机上拒绝了这一步/);
  });

  test("过期没人理就当没批", async () => {
    const { gate, tick } = setup();
    const waiting = gate.beforeTool(run("t1", "git push"));
    await settle();
    tick(APPROVAL_TTL_MS + 1);
    assert.equal(gate.pending().length, 0);
    const result = await waiting;
    assert.match(result?.block ?? "", /分钟没人处理，已经作废/);
  });

  test("DO 重启后同一次调用接着等，批过的直接放行", async () => {
    const { gate, restart } = setup();
    const waiting = gate.beforeTool(run("t1", "git push"));
    await settle();
    const id = gate.pending()[0]!.id;
    const second = restart();
    const resumed = second.beforeTool(run("t1", "git push"));
    await settle();
    assert.equal(second.pending().length, 1, "没有重复建一条请示");
    second.decide(id, "allow");
    assert.equal(await resumed, undefined);
    // 原来那个实例上的等待，再点一次时会被叫醒，读到的也是批准。
    assert.equal(gate.decide(id, "allow"), "settled");
    assert.equal(await waiting, undefined);
  });

  test("屏幕批一次授权，之后不再问；收回后再问", async () => {
    const { gate } = setup();
    const first = gate.beforeTool(shot("s1"));
    await settle();
    const [row] = gate.pending();
    assert.equal(row?.kind, "screen");
    gate.decide(row!.id, "allow");
    assert.equal(await first, undefined);
    assert.equal(gate.screenActive("c1"), true);
    assert.equal(await gate.beforeTool(shot("s2")), undefined);
    assert.equal(gate.approved({ requestId: "s2", computerId: "c1", action: { kind: "computer", op: "look" } }), true);

    gate.takeback("c1");
    assert.equal(gate.screenActive("c1"), false);
    const third = gate.beforeTool(shot("s3"));
    await settle();
    assert.equal(gate.pending().length, 1);
    gate.takeback("c1");
    assert.match((await third)?.block ?? "", /收回了屏幕控制/);
  });

  test("sensitive 的屏幕输入在授权期间也单独问", async () => {
    const { gate } = setup();
    const grant = gate.beforeTool(shot("s1"));
    await settle();
    gate.decide(gate.pending()[0]!.id, "allow");
    await grant;
    const click = gate.beforeTool({ id: "k1", name: "computer_click", arguments: { x: 1, y: 2, sensitive: true } });
    await settle();
    assert.equal(gate.pending()[0]?.reason, "这一步会发消息、付款、提交或删除");
    gate.decide(gate.pending()[0]!.id, "allow");
    assert.equal(await click, undefined);
  });

  test("都放行的电脑什么都不问，帧里都带 approved", async () => {
    const { gate } = setup("trust");
    assert.equal(await gate.beforeTool(run("t1", "rm -rf build")), undefined);
    assert.equal(gate.pending().length, 0);
    assert.equal(
      gate.approved({ requestId: "t1", computerId: "c1", action: { kind: "run", command: "rm -rf build", background: false } }),
      true
    );
  });

  test("中止的调用把请示收掉", async () => {
    const { gate } = setup();
    const controller = new AbortController();
    const waiting = gate.beforeTool(run("t1", "git push"), controller.signal);
    await settle();
    controller.abort(new Error("stopped"));
    await assert.rejects(waiting, /stopped/);
    assert.equal(gate.pending().length, 0);
  });
});
