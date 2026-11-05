import { nativeTheme, type BrowserWindowConstructorOptions } from "electron";

/**
 * 窗口外观：macOS 上不要系统标题栏，天空一直铺到窗口顶上，红绿灯浮在内容上面。
 * 网页靠 `window.pupuDesktop.titleBar` 知道要给红绿灯让位（见 apps/cloud/src/client/desktop.ts），
 * 本地页面（配对、离线）在 page.css 里自己处理拖动。底色取天空的顶，窗口没画完时不闪别的颜色。
 */
export function windowChrome(): BrowserWindowConstructorOptions {
  return {
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0c1420" : "#34557f",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 24, y: 22 } }
      : {})
  };
}
