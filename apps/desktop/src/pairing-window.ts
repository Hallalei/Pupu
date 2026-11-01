import { BrowserWindow } from "electron";

/** 配对窗口打开时要显示什么。 */
export type PairingInfo = {
  /** 要连的 Pupu，比如 pupu.cobuilder-team.workers.dev。 */
  readonly host: string;
  /** 本机开发服务器没设访问口令时，不填码也能配对。 */
  readonly codeOptional: boolean;
  /**
   * - `first`：两份凭据都没有；
   * - `desktop`：窗口的凭据被吊销了，要一个新码；
   * - `computer`：窗口还能用，只是这台电脑的授权被吊销了，点一下就重新授权，不用码。
   */
  readonly reason: "first" | "desktop" | "computer";
  /**
   * 命令行的桥已经给这台电脑配过对（~/.pupu/bridge.json）时，那台电脑的名字。
   * 沿用它的授权就不会多出一台同名的电脑。只在第一次配对时给。
   */
  readonly adoptable: string | null;
};

export type PairingRequest = {
  readonly code: string;
  readonly adopt: boolean;
};

export function createPairWindow(preload: string, page: string, query: Record<string, string>): BrowserWindow {
  const window = new BrowserWindow({
    width: 440,
    height: 560,
    resizable: false,
    fullscreenable: false,
    title: "连上 Pupu",
    backgroundColor: "#6f8fb3",
    show: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 和主窗口分开：这里不需要 Pupu 的 cookie。
      partition: "pupu-pairing"
    }
  });
  window.once("ready-to-show", () => window.show());
  void window.loadFile(page, { query });
  return window;
}
