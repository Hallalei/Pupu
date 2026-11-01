import { Menu, Tray, nativeImage, type NativeImage } from "electron";
import type { MenubarState } from "../../cloud/bridge/menubar.ts";
import { trayMenu, trayTooltip, type TrayAction, type TrayView } from "./tray-menu.ts";

/** 图标和 bridge/menubar.swift 用同一套 SF Symbol，挑第一个系统里有的。 */
const ICONS: Record<MenubarState["status"], readonly string[]> = {
  waiting: ["hand.raised.fill", "exclamationmark.circle.fill"],
  screen: ["cursorarrow.rays", "cursorarrow.click.2", "cursorarrow"],
  busy: ["pawprint.fill", "terminal.fill"],
  idle: ["pawprint", "circle"],
  offline: ["pawprint", "circle.dashed"]
};

const icons = new Map<string, NativeImage | null>();

/** 菜单栏图标按惯例用模板图，跟着系统深浅色走。1x、2x 各画一份，不糊。 */
function icon(status: MenubarState["status"]): NativeImage | null {
  const cached = icons.get(status);
  if (cached !== undefined) return cached;
  let result: NativeImage | null = null;
  for (const name of ICONS[status]) {
    const symbol = nativeImage.createFromNamedImage(name);
    if (symbol.isEmpty()) continue;
    result = nativeImage.createEmpty();
    result.addRepresentation({ scaleFactor: 1, buffer: symbol.resize({ height: 16, quality: "best" }).toPNG() });
    result.addRepresentation({ scaleFactor: 2, buffer: symbol.resize({ height: 32, quality: "best" }).toPNG() });
    result.setTemplateImage(true);
    break;
  }
  icons.set(status, result);
  return result;
}

/** Pupu 在菜单栏上的图标，替代 bridge/menubar.swift。 */
export class PupuTray {
  readonly #tray: Tray;
  readonly #onAction: (action: TrayAction) => void;

  constructor(onAction: (action: TrayAction) => void) {
    this.#onAction = onAction;
    this.#tray = new Tray(icon("offline") ?? nativeImage.createEmpty());
    this.render({ state: null, needsPairing: false });
  }

  render(view: TrayView): void {
    const image = view.needsPairing ? icon("offline") : icon(view.state?.status ?? "offline");
    this.#tray.setImage(image ?? nativeImage.createEmpty());
    // 系统里找不到这些 SF Symbol 时退回文字，免得图标是空的。
    this.#tray.setTitle(image ? "" : "Pupu");
    this.#tray.setToolTip(trayTooltip(view));
    this.#tray.setContextMenu(Menu.buildFromTemplate(trayMenu(view, this.#onAction)));
  }

  destroy(): void {
    this.#tray.destroy();
  }
}
