import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { localRefusal } from "./local.ts";
import { menubarState } from "./menubar.ts";

const ON = { allowCommands: true, allowScreen: true };
const HOME = "/Users/me";

describe("桥上的二次判断", () => {
  test("低风险命令不用批准", () => {
    assert.equal(localRefusal({ kind: "run", command: "ls", background: false }, false, ON, HOME), null);
  });

  test("高风险命令没带批准就拒，带了就放行", () => {
    const action = { kind: "run" as const, command: "git push", background: false };
    assert.match(localRefusal(action, false, ON, HOME) ?? "", /推送代码/);
    assert.equal(localRefusal(action, true, ON, HOME), null);
  });

  test("屏幕操作没带批准就拒", () => {
    assert.match(localRefusal({ kind: "computer", op: "look" }, false, ON, HOME) ?? "", /先在手机或网页上批准/);
    assert.equal(localRefusal({ kind: "computer", op: "permissions" }, false, ON, HOME), null);
  });

  test("本机关掉了，云端批准了也不做", () => {
    const off = { allowCommands: false, allowScreen: false };
    assert.match(localRefusal({ kind: "run", command: "ls", background: false }, true, off, HOME) ?? "", /允许跑命令和写文件/);
    assert.match(localRefusal({ kind: "computer", op: "click", x: 1, y: 1 }, true, off, HOME) ?? "", /允许操作屏幕/);
    assert.equal(localRefusal({ kind: "read", path: "a.txt", maxBytes: 1 }, false, off, HOME), null);
  });
});

describe("菜单栏状态", () => {
  const base = {
    connected: true,
    pending: [] as string[],
    screenGrant: false,
    screenActive: false,
    commands: [] as string[],
    allowCommands: true,
    allowScreen: true,
    url: "https://pupu.example",
    name: "mbpro"
  };

  test("按优先级挑状态", () => {
    assert.equal(menubarState({ ...base, connected: false, commands: ["npm test"] }).status, "offline");
    assert.equal(menubarState({ ...base, pending: ["跑命令：git push"], screenActive: true }).status, "waiting");
    assert.equal(menubarState({ ...base, screenActive: true, commands: ["npm test"] }).status, "screen");
    assert.equal(menubarState({ ...base, commands: ["npm test"] }).status, "busy");
    assert.equal(menubarState(base).status, "idle");
  });

  test("状态词和补充照「这台电脑」那一页的说法", () => {
    const word = (input: Partial<Parameters<typeof menubarState>[0]>) => {
      const state = menubarState({ ...base, ...input });
      return [state.title, state.detail];
    };
    assert.deepEqual(word({}), ["在线", null]);
    assert.deepEqual(word({ screenGrant: true }), ["在线", "屏幕已授权"]);
    assert.deepEqual(word({ commands: ["npm test"] }), ["在做事", null]);
    assert.deepEqual(word({ screenActive: true }), ["在用屏幕", null]);
    assert.deepEqual(word({ pending: ["跑命令：git push"] }), ["等你批准", null]);
    assert.deepEqual(word({ remote: "controlling", pending: ["跑命令：git push"] }), ["在用屏幕", "正在被远程控制"]);
    assert.deepEqual(word({ remote: "viewing" }), ["在用屏幕", "正在被远程查看"]);
    assert.deepEqual(word({ connected: false }), ["没连上", null]);
    assert.deepEqual(word({ connected: false, commands: ["a", "b"] }), ["没连上", "还有 2 条命令在跑"]);
    assert.deepEqual(word({ connected: false, problem: "outdated" }), ["没连上", "这台电脑上的 Pupu 太旧，更新后再连"]);
    assert.deepEqual(word({ connected: false, problem: "busy" }), ["没连上", "另一个 Pupu 已经连着这台电脑，先退出它"]);
    assert.deepEqual(word({ connected: false, problem: "rejected", commands: ["a"] }), ["授权被吊销", null]);
  });

  test("在跑的命令最多列 5 条", () => {
    const state = menubarState({ ...base, commands: ["a", "b", "c", "d", "e", "f", "g"] });
    assert.equal(state.jobs, 7);
    assert.deepEqual(state.lines, ["$ a", "$ b", "$ c", "$ d", "$ e", "还有 2 条"]);
  });
});
