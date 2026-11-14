import { useEffect, useState } from "react";

/**
 * 电脑 App 的窗口里，preload 往页面上挂的 `window.pupuDesktop`。普通浏览器里没有。
 * 只有这几个窄接口：这台电脑的状态、本机开关、收回屏幕、停命令、打开系统设置里的授权页、重新配对。
 * 实现在 apps/desktop/src/preload.ts，改这里要一起改那边。
 */
export type DesktopComputer = {
  /** 这台电脑有没有配对好、桥有没有在跑。 */
  readonly paired: boolean;
  /**
   * 没配好是因为配对半路没做完：窗口连上了，这台电脑的凭据还没拿到，再试一次就好。
   * 没配好而这一项不是 true，是云端拒了这台电脑的凭据（授权被吊销）。老的 App 不报。
   */
  readonly unfinished?: boolean;
  readonly computerId: string | null;
  readonly name: string;
  readonly status: "offline" | "idle" | "busy" | "screen" | "waiting";
  /** 状态词：在线、在做事、在用屏幕、等你批准、没连上、授权被吊销。 */
  readonly title: string;
  /** 状态词的补充，接在「 · 」后面：屏幕已授权、正在连接…、配对没做完、正在被远程控制。老的 App 不报。 */
  readonly detail?: string | null;
  readonly lines: readonly string[];
  readonly screenGrant: boolean;
  readonly jobs: number;
  readonly allowCommands: boolean;
  readonly allowScreen: boolean;
  /** Pupu.app 自己有没有这两项系统授权。屏幕助手由它拉起，授权记在它名下。 */
  readonly permissions: { readonly screen: boolean; readonly accessibility: boolean };
};

export type DesktopSwitch = "allowCommands" | "allowScreen";

/** 这台电脑上设的模型。key 不给页面，只说有没有。 */
export type LocalModelView = {
  readonly baseUrl: string;
  readonly model: string;
  readonly vision: boolean;
  readonly contextWindow: number;
  readonly hasKey: boolean;
};

/** 要存的模型。`apiKey` 留空是沿用旧的。 */
export type LocalModelInput = {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly vision: boolean;
  readonly contextWindow: number;
};

export type LocalModelResult = { readonly ok: true } | { readonly ok: false; readonly error: string };
export type PrivacyPane = "screen" | "accessibility";

export type BrowserRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export type PupuDesktop = {
  readonly version: 1;
  /** 窗口没有系统标题栏，红绿灯浮在页面上，页面要让位、要留出能拖窗口的地方。老版本的 App 没有这一项。 */
  readonly titleBar?: "inset";
  computer(): Promise<DesktopComputer>;
  /** 状态变了就回调。返回取消订阅的函数。 */
  onComputer(listener: (computer: DesktopComputer) => void): () => void;
  setSwitch(name: DesktopSwitch, value: boolean): Promise<void>;
  takeback(): Promise<void>;
  stopJobs(): Promise<void>;
  openPrivacySettings(pane: PrivacyPane): Promise<void>;
  /** 窗口的凭据失效了、这台电脑被吊销了或者配对没做完：打开 App 自己的配对窗口。 */
  repair(): Promise<void>;
  /** 人来接手：在主窗口里打开放大视图，里面是 Pupu 浏览器的真实页面。0.2.4 以前的 App 没有。 */
  showBrowser?(): Promise<void>;
  /** 现在要不要显示接手的放大视图。页面加载好时问一次，之后听 `onBrowserTakeover`。0.2.5 以前的 App 没有。 */
  browserTakeover?(): Promise<boolean>;
  /** 要不要显示接手的放大视图变了就回调。返回取消订阅的函数。0.2.5 以前的 App 没有。 */
  onBrowserTakeover?(listener: (open: boolean) => void): () => void;
  /** 把真实页面挂到这个位置上（CSS 像素，相对窗口内容区）。窗口大小变了再调一次。0.2.5 以前的 App 没有。 */
  attachBrowser?(rect: BrowserRect): Promise<boolean>;
  /** 关掉放大视图：页面回到后台，任务接着做。0.2.5 以前的 App 没有。 */
  detachBrowser?(handback?: boolean): Promise<void>;
  /** 列出这台电脑上 Chrome 的用户资料，导入前让人挑。0.2.4 以前的 App 没有。 */
  chromeProfiles?(): Promise<readonly ChromeProfile[]>;
  /**
   * 把这台电脑上 Chrome 某个用户资料的登录状态（cookie）导进 Pupu 浏览器。读 Chrome 的钥匙串项时 macOS 会弹窗，要人自己点允许。
   * 导进来的只存在这台电脑的 Pupu 浏览器里，不上传。0.2.4 以前的 App 没有。
   */
  importChrome?(profile: string): Promise<ChromeImport>;
  /** 这台电脑上设的模型。0.2.6 以前的 App 没有这两项，页面要先看有没有。 */
  localModel?(): Promise<LocalModelView | null>;
  /** 存之前试一次能不能调工具，不过就不存。null 是清掉。 */
  setLocalModel?(input: LocalModelInput | null): Promise<LocalModelResult>;
};

export type ChromeProfile = { readonly dir: string; readonly name: string };
export type ChromeImport =
  | { readonly ok: true; readonly imported: number; readonly skipped: number }
  | { readonly ok: false; readonly error: string };

declare global {
  interface Window {
    readonly pupuDesktop?: PupuDesktop;
  }
}

export function desktop(): PupuDesktop | null {
  return typeof window !== "undefined" && window.pupuDesktop?.version === 1 ? window.pupuDesktop : null;
}

/** 在 html 上记下窗口有没有系统标题栏，styles.css 按它让位。 */
export function followWindowChrome() {
  if (desktop()?.titleBar === "inset") document.documentElement.dataset.titlebar = "inset";
}

/** 在电脑 App 里返回这台电脑的状态，普通浏览器里一直是 null。 */
export function useDesktopComputer(): DesktopComputer | null {
  const [computer, setComputer] = useState<DesktopComputer | null>(null);
  useEffect(() => {
    const app = desktop();
    if (!app) return;
    let live = true;
    void app.computer().then((value) => {
      if (live) setComputer(value);
    });
    const off = app.onComputer((value) => {
      if (live) setComputer(value);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return computer;
}
