import assert from "node:assert/strict";
import { test } from "node:test";
import type { MenubarState } from "../../cloud/bridge/menubar.ts";
import { computerAuth } from "./pairing-state.ts";
import { trayMenu, trayTooltip, type TrayAction, type TrayView } from "./tray-menu.ts";

const state: MenubarState = {
  status: "busy",
  title: "在做事",
  detail: null,
  lines: ["$ npm test"],
  screenGrant: false,
  jobs: 1,
  allowCommands: true,
  allowScreen: false,
  url: "https://pupu.example.com",
  name: "mbpro"
};

const view: TrayView = { state, name: "mbpro", pairing: "ok", update: null };

function labels(items: ReturnType<typeof trayMenu>): string[] {
  return items.map((item) => (item.type === "separator" ? "—" : String(item.label)));
}

test("菜单照「这台电脑」那一页的说法：名字和状态词、命令、收回、停止、两个开关、打开和退出", () => {
  const items = trayMenu(view, () => {});
  assert.deepEqual(labels(items), [
    "mbpro · 在做事",
    "  $ npm test",
    "—",
    "收回屏幕",
    "停止命令（1 条）",
    "—",
    "允许跑命令和写文件",
    "允许操作屏幕",
    "—",
    "打开 Pupu",
    "—",
    "退出 Pupu（这台电脑会下线）"
  ]);
  const takeback = items.find((item) => item.label === "收回屏幕");
  assert.equal(takeback?.enabled, false);
  assert.equal(items[0]?.enabled, false);
});

test("有补充时第一行下面再一行，远程桌面连着时多一项断开", () => {
  const remote = { ...state, status: "screen" as const, title: "在用屏幕", detail: "正在被远程控制", jobs: 0, lines: [], remote: true };
  const items = trayMenu({ ...view, state: remote }, () => {});
  assert.deepEqual(labels(items).slice(0, 6), ["mbpro · 在用屏幕", "正在被远程控制", "—", "断开远程桌面", "收回屏幕", "停止命令"]);
  assert.equal(items.find((item) => item.label === "收回屏幕")?.enabled, true);
  assert.equal(items.find((item) => item.label === "停止命令")?.enabled, false);
  assert.equal(trayTooltip({ ...view, state: remote }), "Pupu · mbpro：在用屏幕 · 正在被远程控制");
});

test("点开关发出取反后的值", () => {
  const sent: TrayAction[] = [];
  const items = trayMenu(view, (action) => sent.push(action));
  const click = (label: string) => {
    const item = items.find((entry) => entry.label === label);
    (item?.click as () => void)();
  };
  click("允许跑命令和写文件");
  click("允许操作屏幕");
  click("停止命令（1 条）");
  assert.deepEqual(sent, [
    { action: "setAllowCommands", value: false },
    { action: "setAllowScreen", value: true },
    { action: "stopJobs" }
  ]);
});

test("没配对时只给打开、配对和退出", () => {
  const first = { ...view, state: null, pairing: "first" as const };
  assert.deepEqual(labels(trayMenu(first, () => {})), [
    "这台电脑还没配对",
    "—",
    "打开 Pupu",
    "配对这台电脑…",
    "—",
    "退出 Pupu（这台电脑会下线）"
  ]);
  assert.equal(trayTooltip(first), "Pupu：这台电脑还没配对");
});

test("被吊销以后给重新配对，不再显示桥的旧状态", () => {
  const sent: TrayAction[] = [];
  const revoked = { ...view, pairing: "revoked" as const };
  const items = trayMenu(revoked, (action) => sent.push(action));
  assert.deepEqual(labels(items), [
    "mbpro · 授权被吊销",
    "—",
    "打开 Pupu",
    "重新配对…",
    "—",
    "退出 Pupu（这台电脑会下线）"
  ]);
  (items.find((item) => item.label === "重新配对…")?.click as () => void)();
  assert.deepEqual(sent, [{ action: "pair" }]);
  assert.equal(trayTooltip(revoked), "Pupu · mbpro：授权被吊销");
});

test("配对半路没做完：没连上 · 配对没做完，给再试一次，不说被吊销", () => {
  const sent: TrayAction[] = [];
  const unfinished = { ...view, state: null, pairing: "unfinished" as const };
  const items = trayMenu(unfinished, (action) => sent.push(action));
  assert.deepEqual(labels(items), [
    "mbpro · 没连上",
    "配对没做完",
    "—",
    "打开 Pupu",
    "再试一次…",
    "—",
    "退出 Pupu（这台电脑会下线）"
  ]);
  assert.equal(items[1]?.enabled, false);
  (items.find((item) => item.label === "再试一次…")?.click as () => void)();
  assert.deepEqual(sent, [{ action: "pair" }]);
  assert.equal(trayTooltip(unfinished), "Pupu · mbpro：没连上 · 配对没做完");
});

test("桥还没报状态时是「没连上 · 正在连接…」，没有开关", () => {
  const starting = { ...view, state: null };
  assert.deepEqual(labels(trayMenu(starting, () => {})), [
    "mbpro · 没连上",
    "正在连接…",
    "—",
    "打开 Pupu",
    "—",
    "退出 Pupu（这台电脑会下线）"
  ]);
  assert.equal(trayTooltip(starting), "Pupu · mbpro：没连上 · 正在连接…");
  assert.equal(trayTooltip(view), "Pupu · mbpro：在做事");
});

test("托盘跟着凭据走：只是窗口的没了照常显示；少了电脑的，云端拒过才写被吊销", () => {
  const credential = { id: "c1", name: "mbpro", token: "t" };
  const shown = (pairing: Parameters<typeof computerAuth>[0]) =>
    labels(trayMenu({ ...view, state: null, pairing: computerAuth(pairing) }, () => {}))[0];
  assert.equal(shown({ desktop: null, computer: null }), "这台电脑还没配对");
  assert.equal(shown({ desktop: credential, computer: null }), "mbpro · 没连上");
  assert.equal(shown({ desktop: credential, computer: null, computerRevoked: true }), "mbpro · 授权被吊销");
  assert.equal(computerAuth({ desktop: null, computer: credential }), "ok");
  assert.equal(computerAuth({ desktop: credential, computer: credential }), "ok");
});

test("下好新版本后，退出上面多一项重启更新", () => {
  const sent: TrayAction[] = [];
  const items = trayMenu({ ...view, update: "0.2.1" }, (action) => sent.push(action));
  const at = items.findIndex((item) => item.label === "重启并更新到 0.2.1");
  assert.equal(items[at + 1]?.label, "退出 Pupu（这台电脑会下线）");
  assert.equal(items[at - 1]?.type, "separator");
  (items[at]?.click as () => void)();
  assert.deepEqual(sent, [{ action: "update" }]);
});
