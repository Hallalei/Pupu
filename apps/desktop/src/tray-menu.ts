import type { MenuItemConstructorOptions } from "electron";
import type { MenubarAction, MenubarState } from "../../cloud/bridge/menubar.ts";
import type { Pairing } from "./credentials.ts";

/** 托盘上能点的，除了桥的那几个动作，还有 App 自己的。 */
export type TrayAction =
  | MenubarAction
  | { readonly action: "open" }
  | { readonly action: "pair" }
  | { readonly action: "update" }
  | { readonly action: "quit" };

/**
 * 这台电脑的授权：`first` 还没配对，`revoked` 被吊销了，`ok` 配好了。
 * 只是窗口的凭据没了、这台电脑的还在时算 `ok`：桥照样在跑，「收回屏幕」得点得到，「打开 Pupu」会先打开配对窗口。
 */
export type TrayPairing = "first" | "revoked" | "ok";

export function trayPairing(pairing: Pick<Pairing, "desktop" | "computer">): TrayPairing {
  if (pairing.computer) return "ok";
  return pairing.desktop ? "revoked" : "first";
}

/** 托盘要显示的：桥报来的状态，加上这台电脑配没配好。 */
export type TrayView = {
  readonly state: MenubarState | null;
  /** 菜单第一行写的电脑名：凭据里的，被吊销以后用这台电脑自己的名字。 */
  readonly name: string;
  readonly pairing: TrayPairing;
  /** 下好了、等重启的新版本。 */
  readonly update: string | null;
};

/** 状态词和补充。桥还没报状态（刚启动、桥在重启）时是「没连上 · 正在连接…」。 */
function statusOf(view: TrayView): { readonly title: string; readonly detail: string | null } {
  if (view.pairing === "revoked") return { title: "授权被吊销", detail: null };
  if (!view.state) return { title: "没连上", detail: "正在连接…" };
  return { title: view.state.title, detail: view.state.detail };
}

/** 鼠标停在图标上：「Pupu · mbpro：在线」，有补充时接在后面。 */
export function trayTooltip(view: TrayView): string {
  if (view.pairing === "first") return "Pupu：这台电脑还没配对";
  const { title, detail } = statusOf(view);
  return `Pupu · ${view.name}：${[title, detail].filter(Boolean).join(" · ")}`;
}

/**
 * 托盘菜单（规范 ThisComputer）：第一行「mbpro · 在线」，有补充时下面再一行；等批准的事和在跑的命令；
 * 断开远程桌面、收回屏幕、停止命令；两个本机开关；打开 Pupu；更新和退出。
 * 还没配对、被吊销、刚启动还没连上时只剩几项。说法和设置里「这台电脑」那一页一样。
 */
export function trayMenu(view: TrayView, send: (action: TrayAction) => void): MenuItemConstructorOptions[] {
  const click = (action: TrayAction) => () => send(action);
  const open: MenuItemConstructorOptions = { label: "打开 Pupu", click: click({ action: "open" }) };
  const tail: MenuItemConstructorOptions[] = [
    { type: "separator" },
    ...(view.update ? [{ label: `重启并更新到 ${view.update}`, click: click({ action: "update" }) }] : []),
    { label: "退出 Pupu（这台电脑会下线）", click: click({ action: "quit" }) }
  ];
  if (view.pairing === "first") {
    return [
      { label: "这台电脑还没配对", enabled: false },
      { type: "separator" },
      open,
      { label: "配对这台电脑…", click: click({ action: "pair" }) },
      ...tail
    ];
  }
  if (view.pairing === "revoked") {
    return [
      { label: `${view.name} · 授权被吊销`, enabled: false },
      { type: "separator" },
      open,
      { label: "重新配对…", click: click({ action: "pair" }) },
      ...tail
    ];
  }
  const state = view.state;
  if (!state) {
    return [
      { label: `${view.name} · 没连上`, enabled: false },
      { label: "正在连接…", enabled: false },
      { type: "separator" },
      open,
      ...tail
    ];
  }
  return [
    { label: `${view.name} · ${state.title}`, enabled: false },
    ...(state.detail ? [{ label: state.detail, enabled: false }] : []),
    ...state.lines.slice(0, 8).map((line): MenuItemConstructorOptions => ({ label: `  ${line}`, enabled: false })),
    { type: "separator" },
    ...(state.remote
      ? [{ label: "断开远程桌面", click: click({ action: "stopRemote" }) } satisfies MenuItemConstructorOptions]
      : []),
    {
      label: "收回屏幕",
      enabled: state.screenGrant || state.status === "screen",
      click: click({ action: "takeback" })
    },
    {
      label: state.jobs > 0 ? `停止命令（${state.jobs} 条）` : "停止命令",
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
    { type: "separator" },
    open,
    ...tail
  ];
}
