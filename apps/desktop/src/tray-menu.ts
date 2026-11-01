import type { MenuItemConstructorOptions } from "electron";
import type { MenubarAction, MenubarState } from "../../cloud/bridge/menubar.ts";

/** 托盘上能点的，除了桥的那几个动作，还有 App 自己的。 */
export type TrayAction =
  | MenubarAction
  | { readonly action: "open" }
  | { readonly action: "pair" }
  | { readonly action: "quit" };

/** 托盘要显示的：桥报来的状态，加上这台电脑配没配好。 */
export type TrayView = {
  readonly state: MenubarState | null;
  /** 还没配对，或者凭据被吊销了：菜单里给「配对」。 */
  readonly needsPairing: boolean;
};

export function trayTooltip(view: TrayView): string {
  if (view.needsPairing) return "Pupu：这台电脑还没配对";
  return view.state ? `Pupu · ${view.state.name}：${view.state.title}` : "Pupu：桥还没连上";
}

/**
 * 菜单项和文案跟 bridge/menubar.swift 一样：五种状态、一键收回、停命令、本机开关。
 * 「打开 Pupu」打开 App 的窗口；另加配对和退出。
 */
export function trayMenu(view: TrayView, send: (action: TrayAction) => void): MenuItemConstructorOptions[] {
  const click = (action: TrayAction) => () => send(action);
  const tail: MenuItemConstructorOptions[] = [
    { type: "separator" },
    { label: "打开 Pupu", click: click({ action: "open" }) },
    ...(view.needsPairing ? [{ label: "配对这台电脑…", click: click({ action: "pair" }) }] : []),
    { type: "separator" },
    { label: "退出 Pupu（这台电脑会下线）", click: click({ action: "quit" }) }
  ];
  const state = view.state;
  if (!state || view.needsPairing) {
    return [
      { label: view.needsPairing ? "Pupu：这台电脑还没配对" : "Pupu：桥还没连上", enabled: false },
      ...tail
    ];
  }
  return [
    { label: `Pupu · ${state.name}`, enabled: false },
    { label: state.title, enabled: false },
    ...state.lines.slice(0, 8).map((line): MenuItemConstructorOptions => ({ label: `  ${line}`, enabled: false })),
    { type: "separator" },
    {
      label: "收回屏幕控制",
      enabled: state.screenGrant || state.status === "screen",
      click: click({ action: "takeback" })
    },
    {
      label: state.jobs > 0 ? `停止正在跑的命令（${state.jobs} 条）` : "停止正在跑的命令",
      enabled: state.jobs > 0,
      click: click({ action: "stopJobs" })
    },
    { type: "separator" },
    {
      label: "允许跑命令和写文件",
      type: "checkbox",
      checked: state.allowCommands,
      click: click({ action: "setAllowCommands", value: !state.allowCommands })
    },
    {
      label: "允许操作屏幕",
      type: "checkbox",
      checked: state.allowScreen,
      click: click({ action: "setAllowScreen", value: !state.allowScreen })
    },
    ...tail
  ];
}
