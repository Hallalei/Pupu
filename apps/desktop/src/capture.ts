import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  powerSaveBlocker,
  screen,
  session,
  systemPreferences,
  type IpcMainEvent,
  type Session
} from "electron";
import type { CaptureCommand, CaptureEvent } from "../../cloud/bridge/remote.ts";

const PARTITION = "pupu-capture";

export type CaptureHostOptions = {
  readonly preload: string;
  readonly page: string;
  readonly onEvent: (event: CaptureEvent) => void;
  readonly log: (line: string) => void;
  /** 开发时用假画面，不碰真屏幕，也不要屏幕录制权限。 */
  readonly fake: boolean;
};

/**
 * 远程桌面的推流窗口（技术方案 6.3）。一次会话开一个隐藏的沙箱窗口，结束就销毁；单独的内存 session，
 * 只加载本地的推流页，主窗口里的网页碰不到画面。做法参考 Cindy 的 apps/desktop/native/remote-desktop/README.md
 * 「Desktop capture process boundary」（Apache-2.0）。
 */
export class CaptureHost {
  readonly #options: CaptureHostOptions;
  #window: BrowserWindow | null = null;
  #session: string | null = null;
  #ready = false;
  #queue: CaptureCommand[] = [];
  #blocker: number | null = null;

  constructor(options: CaptureHostOptions) {
    this.#options = options;
    this.#setupSession(session.fromPartition(PARTITION));
    ipcMain.on("capture:event", (event, value: unknown) => this.#onEvent(event, value));
    ipcMain.on("capture:log", (event, line: unknown) => {
      if (event.sender === this.#window?.webContents) this.#options.log(`推流窗口：${String(line).slice(0, 300)}`);
    });
  }

  command(command: CaptureCommand): void {
    if (command.type === "start") {
      this.stop();
      this.#open(command);
      return;
    }
    if (command.session !== this.#session) return;
    if (command.type === "stop") {
      this.stop();
      return;
    }
    this.#send(command);
  }

  stop(): void {
    const window = this.#window;
    this.#window = null;
    this.#session = null;
    this.#ready = false;
    this.#queue = [];
    if (this.#blocker !== null) powerSaveBlocker.stop(this.#blocker);
    this.#blocker = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  #open(command: Extract<CaptureCommand, { type: "start" }>): void {
    const fail = (message: string) =>
      this.#options.onEvent({ type: "failed", session: command.session, message });
    if (!this.#options.fake) {
      const status = systemPreferences.getMediaAccessStatus("screen");
      if (status === "denied" || status === "restricted") {
        fail("这台电脑没给 Pupu 屏幕录制权限。到系统设置 → 隐私与安全性 → 屏幕录制里打开。");
        return;
      }
    }
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      webPreferences: {
        preload: this.#options.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: PARTITION,
        // 窗口不显示，定时器和截屏也不能降速。
        backgroundThrottling: false,
        additionalArguments: this.#options.fake ? ["--pupu-fake-screen"] : []
      }
    });
    this.#window = window;
    this.#session = command.session;
    this.#queue = [command];
    this.#blocker = powerSaveBlocker.start("prevent-display-sleep");
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.once("did-finish-load", () => {
      // getDisplayMedia 要用户手势，隐藏窗口里没有人点，给它一次（M0 也是这么做的）。
      void window.webContents.executeJavaScript("0", true).finally(() => {
        if (this.#window !== window) return;
        this.#ready = true;
        for (const queued of this.#queue.splice(0)) this.#send(queued);
      });
    });
    window.webContents.once("render-process-gone", () => {
      if (this.#window !== window) return;
      this.stop();
      fail("推流窗口崩了。");
    });
    window.loadFile(this.#options.page).catch((error: unknown) => {
      if (this.#window !== window) return;
      this.stop();
      fail(error instanceof Error ? error.message : String(error));
    });
  }

  #send(command: CaptureCommand): void {
    if (!this.#ready) {
      this.#queue.push(command);
      return;
    }
    this.#window?.webContents.send("capture:command", command);
  }

  #onEvent(event: IpcMainEvent, value: unknown): void {
    if (event.sender !== this.#window?.webContents) return;
    const message = value as CaptureEvent | null;
    if (message?.session !== this.#session) return;
    this.#options.onEvent(message);
  }

  #setupSession(ses: Session): void {
    // 截屏走 display-capture，有的版本报成没带设备的 media（Cindy 的 README 里记了这一点）。别的权限一律不给。
    const allowed = (contents: Electron.WebContents | null, permission: string) =>
      (permission === "display-capture" || permission === "media") &&
      contents !== null &&
      contents === this.#window?.webContents;
    ses.setPermissionRequestHandler((contents, permission, callback) => callback(allowed(contents, permission)));
    ses.setPermissionCheckHandler((contents, permission) => allowed(contents, permission));
    // 不弹选屏窗口，直接给主屏幕：输入的坐标也是按主屏幕算的。
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      if (request.frame !== this.#window?.webContents.mainFrame) {
        callback({});
        return;
      }
      const sources = await desktopCapturer.getSources({ types: ["screen"] }).catch(() => []);
      const primary = String(screen.getPrimaryDisplay().id);
      const source = sources.find((item) => item.display_id === primary) ?? sources[0];
      this.#options.log(`推流：选了屏幕「${source?.name ?? "没有"}」。`);
      callback(source ? { video: source } : {});
    });
  }
}
