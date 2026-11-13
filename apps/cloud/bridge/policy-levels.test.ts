/**
 * 设置里的三档分级：始终允许（trust）、高风险时询问（ask_risky）、每次询问（ask_all），
 * 各自在跑命令、操作屏幕、浏览器上出不出审批卡；不管哪档都不做的；新电脑默认始终允许。
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { ApprovalDirectory, ApprovalRow, ApprovalStatus } from "../src/bridge/approvals.ts";
import { ComputerGate, screenOn } from "../src/bridge/gate.ts";
import { hardRefusal, NEW_COMPUTER_POLICY, type ComputerPolicy } from "../src/bridge/policy.ts";
import type { Action, ComputerView } from "../src/bridge/protocol.ts";
import { ComputerStore, type ComputerRow } from "../src/bridge/store.ts";
import { localRefusal } from "./local.ts";
import { sqlStorage } from "./sql-memory.ts";

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
  sweep() {
    return 0;
  }
}

function setup(policy: ComputerPolicy) {
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
    screen: { kind: "none" }
  };
  const approvals = new MemoryApprovals();
  const view = (): ComputerView => ({
    id: computer.id,
    name: computer.name,
    online: true,
    stale: false,
    lastSeenAt: now,
    policy: computer.policy,
    screen: screenOn(computer.screen, now),
    browser: true
  });
  const gate = new ComputerGate({
    computers: () => [view()],
    directory: {
      list: () => [computer],
      setPolicy: (_id: string, next: ComputerPolicy) => {
        computer = { ...computer, policy: next };
        return true;
      },
      setScreen: (_id: string, grant: ComputerRow["screen"]) => {
        computer = { ...computer, screen: grant };
      }
    },
    approvals,
    now: () => now,
    onChange: () => {}
  });
  return { gate, approvals, tick: (ms: number) => (now += ms) };
}

/** 让 beforeTool 跑到开始等的那一步。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

type Case = { readonly name: string; readonly call: { id: string; name: string; arguments: Record<string, unknown> }; readonly action: Action };

const CASES: readonly Case[] = [
  { name: "低风险命令", call: { id: "ls", name: "run_command", arguments: { command: "ls" } }, action: { kind: "run", command: "ls", background: false } },
  {
    name: "高风险命令",
    call: { id: "rm", name: "run_command", arguments: { command: "rm -rf build" } },
    action: { kind: "run", command: "rm -rf build", background: false }
  },
  {
    name: "写文件",
    call: { id: "w", name: "write_file", arguments: { path: "/Users/me/notes.txt", content: "hi" } },
    action: { kind: "write", path: "/Users/me/notes.txt", content: "hi" }
  },
  { name: "看屏幕", call: { id: "look", name: "computer_look", arguments: {} }, action: { kind: "computer", op: "look" } },
  {
    name: "浏览器打开内网地址",
    call: { id: "open", name: "browser_open", arguments: { url: "http://127.0.0.1:8765/login" } },
    action: { kind: "browser", op: "open", url: "http://127.0.0.1:8765/login" }
  },
  {
    name: "浏览器点按钮（点到提交按钮时桥上只认 approved）",
    call: { id: "click", name: "browser_click", arguments: { ref: 7 } },
    action: { kind: "browser", op: "click", ref: 7 }
  }
];

/** 每一档、每一种动作：出不出卡（出的话是哪种），以及不出卡时 exec 帧带不带 approved。 */
const EXPECTED: Readonly<Record<ComputerPolicy, Readonly<Record<string, "none" | "screen" | "step" | "none-unapproved">>>> = {
  trust: {
    低风险命令: "none",
    高风险命令: "none",
    写文件: "none",
    看屏幕: "none",
    浏览器打开内网地址: "none",
    "浏览器点按钮（点到提交按钮时桥上只认 approved）": "none"
  },
  ask_risky: {
    低风险命令: "none-unapproved",
    高风险命令: "step",
    写文件: "none-unapproved",
    看屏幕: "screen",
    浏览器打开内网地址: "step",
    "浏览器点按钮（点到提交按钮时桥上只认 approved）": "none-unapproved"
  },
  ask_all: {
    低风险命令: "step",
    高风险命令: "step",
    写文件: "step",
    看屏幕: "screen",
    浏览器打开内网地址: "step",
    "浏览器点按钮（点到提交按钮时桥上只认 approved）": "step"
  }
};

describe("三档分级", () => {
  for (const policy of ["trust", "ask_risky", "ask_all"] as const) {
    for (const item of CASES) {
      const want = EXPECTED[policy][item.name]!;
      test(`${policy}：${item.name} → ${want}`, async () => {
        const { gate } = setup(policy);
        const waiting = gate.beforeTool(item.call);
        await settle();
        const cards = gate.pending();
        if (want === "none" || want === "none-unapproved") {
          for (const card of cards) gate.decide(card.id, "deny");
          await waiting;
          assert.equal(cards.length, 0, "不出卡");
          assert.equal(await waiting, undefined);
          assert.equal(gate.approved({ requestId: item.call.id, computerId: "c1", action: item.action }), want === "none");
          return;
        }
        assert.equal(cards.length, 1, "出一张卡");
        assert.equal(cards[0]!.kind, want);
        gate.decide(cards[0]!.id, "allow");
        assert.equal(await waiting, undefined);
        assert.equal(gate.approved({ requestId: item.call.id, computerId: "c1", action: item.action }), true);
      });
    }
  }

  test("始终允许：屏幕不用授权，一小时、一天后照样算批过（不会 15 分钟过期）", () => {
    const { gate, tick } = setup("trust");
    const action = { kind: "computer", op: "click", x: 1, y: 2 } as const;
    assert.equal(gate.approved({ requestId: "c", computerId: "c1", action }), true);
    tick(24 * 60 * 60_000);
    assert.equal(gate.approved({ requestId: "c2", computerId: "c1", action }), true);
  });

  test("改成始终允许：这台电脑还挂着的卡一起放行，等着的那一步接着做", async () => {
    const { gate, approvals } = setup("ask_all");
    const waiting = gate.beforeTool({ id: "ls", name: "run_command", arguments: { command: "ls" } });
    await settle();
    assert.equal(gate.pending().length, 1);
    assert.equal(gate.setPolicy("c1", "trust"), true);
    assert.equal(await waiting, undefined);
    assert.equal(gate.pending().length, 0);
    assert.equal(approvals.rows[0]?.status, "allowed");
  });

  test("改成更严的不动挂着的卡", async () => {
    const { gate } = setup("ask_risky");
    const stop = new AbortController();
    const waiting = gate.beforeTool({ id: "rm", name: "run_command", arguments: { command: "rm -rf build" } }, stop.signal);
    await settle();
    gate.setPolicy("c1", "ask_all");
    assert.equal(gate.pending().length, 1);
    stop.abort();
    await waiting.catch(() => {});
  });
});

describe("不管哪档都不做的", () => {
  for (const policy of ["trust", "ask_risky", "ask_all"] as const) {
    test(`${policy}：改 TCC 直接拦下，不出卡`, async () => {
      const { gate } = setup(policy);
      for (const command of ["tccutil reset All", "sqlite3 ~/Library/Application\\ Support/com.apple.TCC/TCC.db 'select 1'"]) {
        const result = await gate.beforeTool({ id: command, name: "run_command", arguments: { command } });
        assert.match(result && "block" in result ? result.block : "", /隐私权限/);
      }
      assert.equal(gate.pending().length, 0);
    });
  }

  test("桥上也拦：云端说批过了也不做；写 TCC 的库一样", () => {
    const on = { allowCommands: true, allowScreen: true };
    assert.match(localRefusal({ kind: "run", command: "tccutil reset ScreenCapture", background: false }, true, on, "/Users/me") ?? "", /隐私权限/);
    assert.match(
      localRefusal({ kind: "write", path: "/Users/me/Library/Application Support/com.apple.TCC/TCC.db", content: "" }, true, on, "/Users/me") ?? "",
      /隐私权限/
    );
    assert.equal(hardRefusal({ kind: "run", command: "ls ~/Library", background: false }), null);
  });

  test("始终允许也挡不住电脑上关掉的开关", () => {
    const off = { allowCommands: false, allowScreen: false };
    assert.match(localRefusal({ kind: "computer", op: "look" }, true, off, "/Users/me") ?? "", /允许操作屏幕/);
    assert.match(localRefusal({ kind: "run", command: "ls", background: false }, true, off, "/Users/me") ?? "", /允许跑命令/);
  });
});

describe("新电脑的默认分级", () => {
  test("新配对的电脑是始终允许；已有的电脑保留原来的选择", () => {
    const sql = sqlStorage();
    const store = new ComputerStore(sql);
    assert.equal(NEW_COMPUTER_POLICY, "trust");
    const old = store.insert({ name: "旧电脑", tokenHash: "h1", policy: "ask_risky" });
    const picky = store.insert({ name: "挑剔的电脑", tokenHash: "h2" });
    store.setPolicy(picky.id, "ask_all");
    const fresh = store.insert({ name: "新电脑", tokenHash: "h3" });
    assert.equal(fresh.policy, "trust");
    // 同一个库重新打开（比如新版本部署后），已有的电脑不变。
    const reopened = new ComputerStore(sql);
    const policies = Object.fromEntries(reopened.list().map((row) => [row.name, row.policy]));
    assert.deepEqual(policies, { 旧电脑: "ask_risky", 挑剔的电脑: "ask_all", 新电脑: "trust" });
    assert.equal(old.policy, "ask_risky");
  });
});
