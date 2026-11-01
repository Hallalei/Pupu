import assert from "node:assert/strict";
import { test } from "node:test";
import type { MenubarState } from "../../cloud/bridge/menubar.ts";
import { computerView } from "./view.ts";

const permissions = { screen: false, accessibility: true };
const computer = { id: "c1", name: "mbpro", token: "secret" };
const state: MenubarState = {
  status: "idle",
  title: "已连上 Pupu",
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
    computer,
    state,
    switches: { allowCommands: true, allowScreen: true },
    fallbackName: "host",
    permissions
  });
  assert.equal(view.paired, true);
  assert.equal(view.allowCommands, false);
  assert.equal(view.screenGrant, true);
  assert.equal(JSON.stringify(view).includes("secret"), false);
});

test("被吊销以后不再显示桥的旧状态，开关用本机文件里的", () => {
  const view = computerView({
    computer: null,
    state,
    switches: { allowCommands: true, allowScreen: false },
    fallbackName: "host",
    permissions
  });
  assert.equal(view.paired, false);
  assert.equal(view.status, "offline");
  assert.equal(view.name, "host");
  assert.equal(view.screenGrant, false);
  assert.deepEqual([view.allowCommands, view.allowScreen], [true, false]);
});
