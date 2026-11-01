/**
 * 配对窗口的 preload。配对窗口只加载 App 里的 pair.html，
 * 这几个接口只给它：线上网页拿不到，不能自己触发重新配对。
 */
import { contextBridge, ipcRenderer } from "electron";
import type { PairingInfo, PairingRequest } from "./pairing-window.ts";

contextBridge.exposeInMainWorld("pupuPairing", {
  info: () => ipcRenderer.invoke("pairing:info") as Promise<PairingInfo>,
  /** 成功返回 null，失败返回给人看的原因。 */
  pair: (request: PairingRequest) => ipcRenderer.invoke("pairing:pair", request) as Promise<string | null>
});
