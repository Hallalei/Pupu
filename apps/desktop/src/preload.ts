/**
 * 主窗口的 preload。窗口开着 sandbox 和 contextIsolation，网页拿不到 Node，
 * 只拿到这里挂的 `window.pupuDesktop`（类型在 apps/cloud/src/client/desktop.ts）。
 *
 * 跑在 sandbox 里，除了 electron 不能 require 别的模块（Paseo 踩过：preload 一出错，
 * 接口就整个没挂上）。build.mjs 把它打成单个文件，下面只有类型引用。
 */
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopComputer, LocalModelResult, LocalModelView, PupuDesktop } from "../../cloud/src/client/desktop.ts";

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
    localModel: () => ipcRenderer.invoke("pupu:local-model") as Promise<LocalModelView | null>,
    setLocalModel: (input) => ipcRenderer.invoke("pupu:set-local-model", input) as Promise<LocalModelResult>
  };
  contextBridge.exposeInMainWorld("pupuDesktop", api);
}
