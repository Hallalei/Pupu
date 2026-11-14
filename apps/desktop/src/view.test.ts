import assert from "node:assert/strict";
import { test } from "node:test";
import type { MenubarState } from "../../cloud/bridge/menubar.ts";
import { computerView } from "./view.ts";

const permissions = { screen: false, accessibility: true };
const desktop = { id: "d1", name: "mbpro", token: "window-secret" };
const computer = { id: "c1", name: "mbpro", token: "secret" };
const state: MenubarState = {
  status: "idle",
  title: "在线",
  detail: "屏幕已授权",
  lines: [],
  screenGrant: true,
  jobs: 0,
  allowCommands: false,
  allowScreen: true,
  url: "https://pupu.example.com",
  name: "mbpro"
};

test("桥报了状态就用桥的，不带凭据", () => {
  const view = computerView({
    pairing: { desktop, computer },
    state,
    switches: { allowCommands: true, allowScreen: true },
    fallbackName: "host",
    permissions
  });
  assert.equal(view.paired, true);
  assert.equal(view.unfinished, false);
  assert.equal(view.allowCommands, false);
  assert.equal(view.screenGrant, true);
  assert.deepEqual([view.title, view.detail], ["在线", "屏幕已授权"]);
  assert.equal(JSON.stringify(view).includes("secret"), false);
});

test("桥还没报状态：没连上 · 正在连接…", () => {
  const view = computerView({
    pairing: { desktop, computer },
    state: null,
    switches: { allowCommands: true, allowScreen: false },
    fallbackName: "host",
    permissions
  });
  assert.deepEqual([view.status, view.title, view.detail], ["offline", "没连上", "正在连接…"]);
  assert.deepEqual([view.allowCommands, view.allowScreen], [true, false]);
});

test("配对半路没做完：没连上 · 配对没做完，不说被吊销", () => {
  const view = computerView({
    pairing: { desktop, computer: null },
    state: null,
    switches: { allowCommands: true, allowScreen: true },
    fallbackName: "host",
    permissions
  });
  assert.equal(view.paired, false);
  assert.equal(view.unfinished, true);
  assert.deepEqual([view.status, view.title, view.detail], ["offline", "没连上", "配对没做完"]);
  assert.equal(view.name, "host");
  assert.equal(JSON.stringify(view).includes("secret"), false);
});

test("被吊销以后不再显示桥的旧状态，开关用本机文件里的", () => {
  const view = computerView({
    pairing: { desktop, computer: null, computerRevoked: true },
    state,
    switches: { allowCommands: true, allowScreen: false },
    fallbackName: "host",
    permissions
  });
  assert.equal(view.paired, false);
  assert.equal(view.unfinished, false);
  assert.equal(view.status, "offline");
  assert.deepEqual([view.title, view.detail], ["授权被吊销", null]);
  assert.equal(view.name, "host");
  assert.equal(view.screenGrant, false);
  assert.deepEqual([view.allowCommands, view.allowScreen], [true, false]);
});
