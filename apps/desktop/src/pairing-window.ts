import { app, BrowserWindow } from "electron";
import type { PairingStatus } from "./pairing-state.ts";
import { windowChrome } from "./window-chrome.ts";

/** 配对窗口打开时要显示什么。`status` 之后还会变，主进程用 `pairing:status` 推新的。 */
export type PairingInfo = {
  /** 要连的 Pupu，比如 pupu.cobuilder-team.workers.dev。 */
  readonly host: string;
  /** 本机开发服务器没设访问口令时，不填码也能配对。 */
  readonly codeOptional: boolean;
  readonly status: PairingStatus;
  /**
   * 命令行的桥已经给这台电脑配过对（~/.pupu/bridge.json）时，那台电脑的名字。
   * 沿用它的授权就不会多出一台同名的电脑。只在第一次配对时给。
   */
  readonly adoptable: string | null;
  /** 这个 Pupu 开了 Google 登录：先给「用 Google 登录」，配对码收在下面。`computer` 时不用登录，是 false。 */
  readonly google: boolean;
};

export type PairingRequest = {
  readonly code: string;
  readonly adopt: boolean;
};

export type GoogleRequest = {
  readonly adopt: boolean;
};

export function createPairWindow(
  preload: string,
  page: string,
  query: Record<string, string>,
  reveal: (window: BrowserWindow) => void
): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    resizable: false,
    fullscreenable: false,
    title: "Pupu",
    ...windowChrome(),
    show: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      // 和主窗口分开：这里不需要 Pupu 的 cookie。
      partition: "pupu-pairing"
    }
  });
  window.once("ready-to-show", () => reveal(window));
  void window.loadFile(page, { query });
  return window;
}
