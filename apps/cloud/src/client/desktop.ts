import { useEffect, useState } from "react";

/**
 * 电脑 App 的窗口里，preload 往页面上挂的 `window.pupuDesktop`。普通浏览器里没有。
 * 只有这几个窄接口：这台电脑的状态、本机开关、收回屏幕、停命令、打开系统设置里的授权页、重新配对。
 * 实现在 apps/desktop/src/preload.ts，改这里要一起改那边。
 */
export type DesktopComputer = {
  /** 这台电脑有没有配对好、桥有没有在跑。 */
  readonly paired: boolean;
  readonly computerId: string | null;
  readonly name: string;
  readonly status: "offline" | "idle" | "busy" | "screen" | "waiting";
  readonly title: string;
  readonly lines: readonly string[];
  readonly screenGrant: boolean;
  readonly jobs: number;
  readonly allowCommands: boolean;
  readonly allowScreen: boolean;
  /** Pupu.app 自己有没有这两项系统授权。屏幕助手由它拉起，授权记在它名下。 */
  readonly permissions: { readonly screen: boolean; readonly accessibility: boolean };
};

export type DesktopSwitch = "allowCommands" | "allowScreen";
export type PrivacyPane = "screen" | "accessibility";

export type PupuDesktop = {
  readonly version: 1;
  computer(): Promise<DesktopComputer>;
  /** 状态变了就回调。返回取消订阅的函数。 */
  onComputer(listener: (computer: DesktopComputer) => void): () => void;
  setSwitch(name: DesktopSwitch, value: boolean): Promise<void>;
  takeback(): Promise<void>;
  stopJobs(): Promise<void>;
  openPrivacySettings(pane: PrivacyPane): Promise<void>;
  /** 窗口的凭据失效了：打开 App 自己的配对窗口。 */
  repair(): Promise<void>;
};

declare global {
  interface Window {
    readonly pupuDesktop?: PupuDesktop;
  }
}

export function desktop(): PupuDesktop | null {
  return typeof window !== "undefined" && window.pupuDesktop?.version === 1 ? window.pupuDesktop : null;
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
