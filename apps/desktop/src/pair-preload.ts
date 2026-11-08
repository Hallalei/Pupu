/**
 * 配对窗口的 preload。配对窗口只加载 App 里的 pair.html，
 * 这几个接口只给它：线上网页拿不到，不能自己触发重新配对。
 */
import { contextBridge, ipcRenderer } from "electron";
import type { PairingStatus } from "./pairing-state.ts";
import type { GoogleRequest, PairingInfo, PairingRequest } from "./pairing-window.ts";

contextBridge.exposeInMainWorld("pupuPairing", {
  info: () => ipcRenderer.invoke("pairing:info") as Promise<PairingInfo>,
  /** 主进程那边配对开始了、做完了，或者凭据变了。 */
  onStatus: (callback: (status: PairingStatus) => void) => {
    ipcRenderer.on("pairing:status", (_event, status: PairingStatus) => callback(status));
  },
  /** 成功返回 null，失败返回给人看的原因。 */
  pair: (request: PairingRequest) => ipcRenderer.invoke("pairing:pair", request) as Promise<string | null>,
  /** 打开系统浏览器用 Google 登录，等它回来。返回值和 `pair` 一样。 */
  google: (request: GoogleRequest) => ipcRenderer.invoke("pairing:google", request) as Promise<string | null>,
  /** 不等浏览器了。正在等的 `google` 返回「已取消。」。 */
  cancel: () => ipcRenderer.invoke("pairing:cancel") as Promise<void>
});
