import { readFileSync } from "node:fs";
import path from "node:path";
import { Menu, Tray, nativeImage, type NativeImage } from "electron";
import type { MenubarState } from "../../cloud/bridge/menubar.ts";
import { trayMenu, trayTooltip, type TrayAction, type TrayView } from "./tray-menu.ts";

/**
 * 菜单栏上的像素猫（design/icon/export.py 生成，在 static/icons/ 里）：空闲时气泡是空的，
 * 忙和看屏幕时气泡里有输入点，等你批准时右上角多一个圆点，离线变淡。
 */
const ICONS: Record<MenubarState["status"], string> = {
  waiting: "tray-waiting",
  screen: "tray-busy",
  busy: "tray-busy",
  idle: "tray-idle",
  offline: "tray-offline"
};

const icons = new Map<string, NativeImage | null>();

/** 菜单栏图标按惯例用模板图，跟着系统深浅色走。1x、2x 各加一份，像素格不糊。 */
function icon(status: MenubarState["status"]): NativeImage | null {
  const name = ICONS[status];
  const cached = icons.get(name);
  if (cached !== undefined) return cached;
  let result: NativeImage | null = null;
  try {
    const file = (suffix: string) => readFileSync(path.join(__dirname, "icons", `${name}${suffix}.png`));
    result = nativeImage.createEmpty();
    result.addRepresentation({ scaleFactor: 1, buffer: file("") });
    result.addRepresentation({ scaleFactor: 2, buffer: file("@2x") });
    result.setTemplateImage(true);
  } catch {
    result = null;
  }
  icons.set(name, result);
  return result;
}

/** Pupu 在菜单栏上的图标，替代 bridge/menubar.swift。 */
export class PupuTray {
  readonly #tray: Tray;
  readonly #onAction: (action: TrayAction) => void;

  constructor(onAction: (action: TrayAction) => void, view: TrayView) {
    this.#onAction = onAction;
    this.#tray = new Tray(icon("offline") ?? nativeImage.createEmpty());
    this.render(view);
  }

  /** 图标：在线 tray-idle，在做事、在用屏幕 tray-busy，等你批准 tray-waiting；没连上、被吊销、还没配对 tray-offline。 */
  render(view: TrayView): void {
    const image = view.pairing === "ok" ? icon(view.state?.status ?? "offline") : icon("offline");
    this.#tray.setImage(image ?? nativeImage.createEmpty());
    // 找不到图标文件时退回文字，免得图标是空的。
    this.#tray.setTitle(image ? "" : "Pupu");
    this.#tray.setToolTip(trayTooltip(view));
    this.#tray.setContextMenu(Menu.buildFromTemplate(trayMenu(view, this.#onAction)));
  }

  destroy(): void {
    this.#tray.destroy();
  }
}
