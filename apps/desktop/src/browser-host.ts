import { app, BrowserWindow, session, type Session, type WebContents } from "electron";
import type { BrowserOp, BrowserResult } from "../../cloud/bridge/browser.ts";
import { renderSnapshot, type AXNode } from "./browser-snapshot.ts";

/** 和主窗口、推流窗口都分开，登录态只在这里。 */
export const BROWSER_PARTITION = "persist:pupu-browser";
const OPEN_TIMEOUT_MS = 20_000;
const SETTLE_MS = 5_000;
const READ_MAX_CHARS = 20_000;

export type BrowserHostOptions = {
  readonly log: (line: string) => void;
  /** 后台测试时 `show` 也只 showInactive，不抢前台。 */
  readonly background: boolean;
};

type Debugger = Electron.Debugger;

/**
 * Pupu 浏览器：一个独立的窗口，主进程用 webContents.debugger 走 CDP 驱动它，不开调试端口（docs/浏览器能力方案.md）。
 * 平时不显示；要人登录、过验证码时 `show` 才拿出来。窗口关了就丢，下一步再开一个，登录态在 partition 里留着。
 * 快照、点击的做法参考 browser-use 的 browser_use/ax.py（MIT），自己写的，没搬代码。
 */
export class BrowserHost {
  readonly #options: BrowserHostOptions;
  #window: BrowserWindow | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: BrowserHostOptions) {
    this.#options = options;
    setupSession(session.fromPartition(BROWSER_PARTITION));
  }

  /** 一次只做一步，按到达顺序。 */
  run(op: BrowserOp): Promise<BrowserResult> {
    const result = this.#queue.then(() => this.#perform(op));
    this.#queue = result.catch(() => undefined);
    return result.catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
  }

  /** 调试和取证用：当前页面的截图，PNG 的 base64。 */
  async screenshot(): Promise<string> {
    const { data } = (await this.#cdp("Page.captureScreenshot", { format: "png" })) as { data: string };
    return data;
  }

  stop(): void {
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  async #perform(op: BrowserOp): Promise<BrowserResult> {
    switch (op.op) {
      case "open": {
        const url = httpUrl(op.url);
        if (!url) return { ok: false, error: "只能打开 http 或 https 的网址。" };
        await this.#open(url);
        return this.#look();
      }
      case "look":
        return this.#look(op.query);
      case "read": {
        const { result } = (await this.#cdp("Runtime.evaluate", {
          expression: "document.body ? document.body.innerText : ''",
          returnByValue: true
        })) as { result: { value?: unknown } };
        const text = typeof result.value === "string" ? result.value : "";
        const clipped = text.length > READ_MAX_CHARS ? `${text.slice(0, READ_MAX_CHARS)}\n…（后面还有 ${text.length - READ_MAX_CHARS} 个字）` : text;
        return { ok: true, url: this.#contents().getURL(), text: `${this.#header()}\n\n${clipped}` };
      }
      case "click": {
        const { x, y } = await this.#point(op.ref);
        await this.#cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await this.#cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        await this.#settle();
        return this.#look();
      }
      case "type": {
        await this.#cdp("DOM.focus", { backendNodeId: op.ref });
        // 先清空再输：和 ego lite 的 fill、Playwright 的 fill 一样，模型给的是整个值。
        const { object } = (await this.#cdp("DOM.resolveNode", { backendNodeId: op.ref })) as { object: { objectId?: string } };
        if (object.objectId) {
          await this.#cdp("Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration:
              "function(){if('value' in this&&this.value){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}));}}"
          });
        }
        await this.#cdp("Input.insertText", { text: op.text });
        if (op.submit) {
          const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
          await this.#cdp("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...enter });
          await this.#cdp("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
        }
        await this.#settle();
        return this.#look();
      }
      case "show": {
        const window = this.#ensure();
        if (this.#options.background) window.showInactive();
        else {
          window.show();
          window.focus();
        }
        return { ok: true, url: window.webContents.getURL(), text: "已经把 Pupu 浏览器放到这台电脑的屏幕上了。" };
      }
    }
  }

  async #look(query?: string): Promise<BrowserResult> {
    await this.#cdp("Accessibility.enable");
    const { nodes } = (await this.#cdp("Accessibility.getFullAXTree")) as { nodes: AXNode[] };
    const body = renderSnapshot(nodes, query);
    return { ok: true, url: this.#contents().getURL(), text: `${this.#header()}\n\n${body || "（页面上没有文字）"}` };
  }

  #header(): string {
    const contents = this.#contents();
    return `网址：${contents.getURL() || "（空白页）"}\n标题：${contents.getTitle()}`;
  }

  /** 控件中心点，先滚进视口。 */
  async #point(ref: number): Promise<{ x: number; y: number }> {
    try {
      await this.#cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref });
    } catch {
      // 有的节点滚不了（比如 option），照样取位置。
    }
    let quads: number[][];
    try {
      ({ quads } = (await this.#cdp("DOM.getContentQuads", { backendNodeId: ref })) as { quads: number[][] });
    } catch {
      throw new Error(`编号 ${ref} 找不到了，页面可能变了。先 look 一次拿新编号。`);
    }
    const quad = quads[0];
    if (!quad) throw new Error(`编号 ${ref} 的控件现在看不见。`);
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }

  async #open(url: string): Promise<void> {
    const contents = this.#contents();
    const loading = contents.loadURL(url);
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), OPEN_TIMEOUT_MS));
    const outcome = await Promise.race([loading.then(() => "loaded" as const), timeout]).catch((error: unknown) => {
      // 跳转被拦、重定向时 loadURL 会以 ERR_ABORTED 结束，页面其实还在；别的错误照实说。
      const text = error instanceof Error ? error.message : String(error);
      if (/ERR_ABORTED/.test(text)) return "aborted" as const;
      throw new Error(`打不开 ${url}：${text}`);
    });
    if (outcome === "timeout") contents.stop();
  }

  /** 动作之后等页面停下：在加载就等它加载完，没在加载就给脚本一点时间。 */
  async #settle(): Promise<void> {
    const contents = this.#contents();
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!contents.isLoading()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SETTLE_MS);
      contents.once("did-stop-loading", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async #cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const debug = this.#debugger();
    return debug.sendCommand(method, params);
  }

  #debugger(): Debugger {
    const debug = this.#contents().debugger;
    if (!debug.isAttached()) debug.attach("1.3");
    return debug;
  }

  #contents(): WebContents {
    return this.#ensure().webContents;
  }

  #ensure(): BrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      title: "Pupu 浏览器",
      show: false,
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        // 窗口平时不显示，不节流才能照常渲染和响应输入。
        backgroundThrottling: false,
        spellcheck: false,
        devTools: !app.isPackaged
      }
    });
    guard(window.webContents);
    window.on("closed", () => {
      if (this.#window === window) this.#window = null;
    });
    this.#window = window;
    this.#options.log("Pupu 浏览器窗口已创建。");
    return window;
  }
}

/** 只认 http 和 https，别的（file、chrome、devtools、javascript、App 自己的页面）都不去。 */
export function httpUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function setupSession(ses: Session): void {
  // 摄像头、麦克风、定位、通知、剪贴板……一律不给。
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // 第一版不下载，见方案文档「登录态和隐私」。
  ses.on("will-download", (event) => event.preventDefault());
  // 去掉 UA 里的 Electron 和 App 名字，少被当成内嵌浏览器。
  ses.setUserAgent(
    ses
      .getUserAgent()
      .split(" ")
      .filter((token) => !/^(Electron|@pupu|Pupu)\b/i.test(token) && !token.startsWith(`${app.getName()}/`))
      .join(" ")
  );
}

function guard(contents: WebContents): void {
  const block = (event: { preventDefault(): void }, url: string) => {
    if (!httpUrl(url)) event.preventDefault();
  };
  contents.on("will-navigate", (event, url) => block(event, url));
  contents.on("will-redirect", (event, url) => block(event, url));
  // 子框架常见 about:blank、srcdoc、blob 的（编辑器、广告位），放过；顶层页面只能是 http(s)。
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && /^(about|blob|data):/.test(event.url)) return;
    block(event, event.url);
  });
  // 新窗口在同一个窗口里打开：模型只看得到这一页。
  contents.setWindowOpenHandler(({ url }) => {
    if (httpUrl(url)) void contents.loadURL(url).catch(() => undefined);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}
