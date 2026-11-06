import assert from "node:assert/strict";
import { test } from "node:test";
import type { MenubarState } from "../../cloud/bridge/menubar.ts";
import { trayMenu, trayTooltip, type TrayAction } from "./tray-menu.ts";

const state: MenubarState = {
  status: "busy",
  title: "Pupu 正在跑 1 条命令",
  lines: ["$ npm test"],
  screenGrant: false,
  jobs: 1,
  allowCommands: true,
  allowScreen: false,
  url: "https://pupu.example.com",
  name: "mbpro"
};

function labels(items: ReturnType<typeof trayMenu>): string[] {
  return items.map((item) => (item.type === "separator" ? "—" : String(item.label)));
}

test("菜单项和 Swift 菜单栏一样，外加打开和退出", () => {
  const items = trayMenu({ state, needsPairing: false, update: null }, () => {});
  assert.deepEqual(labels(items), [
    "Pupu · mbpro",
    "Pupu 正在跑 1 条命令",
    "  $ npm test",
    "—",
    "收回屏幕控制",
    "停止正在跑的命令（1 条）",
    "—",
    "允许跑命令和写文件",
    "允许操作屏幕",
    "—",
    "打开 Pupu",
    "—",
    "退出 Pupu（这台电脑会下线）"
  ]);
  const takeback = items.find((item) => item.label === "收回屏幕控制");
  assert.equal(takeback?.enabled, false);
});

test("点开关发出取反后的值", () => {
  const sent: TrayAction[] = [];
  const items = trayMenu({ state, needsPairing: false, update: null }, (action) => sent.push(action));
  const click = (label: string) => {
    const item = items.find((entry) => entry.label === label);
    (item?.click as () => void)();
  };
  click("允许跑命令和写文件");
  click("允许操作屏幕");
  click("停止正在跑的命令（1 条）");
  assert.deepEqual(sent, [
    { action: "setAllowCommands", value: false },
    { action: "setAllowScreen", value: true },
    { action: "stopJobs" }
  ]);
});

test("没配对时只给打开、配对和退出", () => {
  const view = { state, needsPairing: true, update: null };
  assert.deepEqual(labels(trayMenu(view, () => {})), [
    "Pupu：这台电脑还没配对",
    "—",
    "打开 Pupu",
    "配对这台电脑…",
    "—",
    "退出 Pupu（这台电脑会下线）"
  ]);
  assert.equal(trayTooltip(view), "Pupu：这台电脑还没配对");
  assert.equal(trayTooltip({ state, needsPairing: false, update: null }), "Pupu · mbpro：Pupu 正在跑 1 条命令");
});

test("下好新版本后，退出上面多一项重启更新", () => {
  const sent: TrayAction[] = [];
  const items = trayMenu({ state, needsPairing: false, update: "0.2.1" }, (action) => sent.push(action));
  const at = items.findIndex((item) => item.label === "重启并更新到 0.2.1");
  assert.equal(items[at + 1]?.label, "退出 Pupu（这台电脑会下线）");
  (items[at]?.click as () => void)();
  assert.deepEqual(sent, [{ action: "update" }]);
});
