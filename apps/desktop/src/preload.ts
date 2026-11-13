/**
 * 主窗口的 preload。窗口开着 sandbox 和 contextIsolation，网页拿不到 Node，
 * 只拿到这里挂的 `window.pupuDesktop`（类型在 apps/cloud/src/client/desktop.ts）。
 *
 * 跑在 sandbox 里，除了 electron 不能 require 别的模块（Paseo 踩过：preload 一出错，
 * 接口就整个没挂上）。build.mjs 把它打成单个文件，下面只有类型引用。
 */
import { contextBridge, ipcRenderer } from "electron";
import type { ChromeImport, ChromeProfile, DesktopComputer, PupuDesktop } from "../../cloud/src/client/desktop.ts";

const ORIGIN_ARG = "--pupu-origin=";
const origin = process.argv.find((arg) => arg.startsWith(ORIGIN_ARG))?.slice(ORIGIN_ARG.length);

// 没连上时窗口显示本地的页面，那里不给接口。主进程收到调用时还会再查一遍来源。
if (origin && window.location.origin === origin) {
  const api: PupuDesktop = {
    version: 1,
    ...(process.platform === "darwin" ? { titleBar: "inset" as const } : {}),
    computer: () => ipcRenderer.invoke("pupu:computer") as Promise<DesktopComputer>,
    onComputer(listener) {
      const handler = (_event: unknown, computer: DesktopComputer) => listener(computer);
      ipcRenderer.on("pupu:computer", handler);
      return () => {
        ipcRenderer.removeListener("pupu:computer", handler);
      };
    },
    setSwitch: (name, value) => ipcRenderer.invoke("pupu:set-switch", name, value) as Promise<void>,
    takeback: () => ipcRenderer.invoke("pupu:takeback") as Promise<void>,
    stopJobs: () => ipcRenderer.invoke("pupu:stop-jobs") as Promise<void>,
    openPrivacySettings: (pane) => ipcRenderer.invoke("pupu:open-privacy", pane) as Promise<void>,
    repair: () => ipcRenderer.invoke("pupu:repair") as Promise<void>,
    showBrowser: () => ipcRenderer.invoke("pupu:show-browser") as Promise<void>,
    browserTakeover: () => ipcRenderer.invoke("pupu:browser-takeover-state") as Promise<boolean>,
    onBrowserTakeover(listener) {
      const handler = (_event: unknown, open: boolean) => listener(open === true);
      ipcRenderer.on("pupu:browser-takeover", handler);
      return () => {
        ipcRenderer.removeListener("pupu:browser-takeover", handler);
      };
    },
    attachBrowser: (rect) =>
      ipcRenderer.invoke("pupu:browser-attach", { x: rect.x, y: rect.y, width: rect.width, height: rect.height }) as Promise<boolean>,
    detachBrowser: (handback) => ipcRenderer.invoke("pupu:browser-detach", handback === true) as Promise<void>,
    chromeProfiles: () => ipcRenderer.invoke("pupu:chrome-profiles") as Promise<ChromeProfile[]>,
    importChrome: (profile) => ipcRenderer.invoke("pupu:import-chrome", profile) as Promise<ChromeImport>
  };
  contextBridge.exposeInMainWorld("pupuDesktop", api);
}
