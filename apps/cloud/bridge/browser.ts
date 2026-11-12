/**
 * 桥这边用 Pupu 浏览器的入口（方案见 docs/浏览器能力方案.md）。
 *
 * 浏览器窗口在电脑 App 的主进程里，桥在 utilityProcess 里，中间只有消息端口。
 * 这里只管把一步操作发出去、按 id 等回包；怎么驱动网页在 apps/desktop/src/browser-host.ts。
 * 命令行桥（node bridge/main.ts）没有主进程，用不了浏览器。
 */

import type { BrowserAction } from "../src/bridge/protocol.ts";

/** 主进程要做的一步：动作本身，加上云端批过没有。批过的才放行内网地址、file:、下载、提交表单。 */
export type BrowserOp = Omit<BrowserAction, "kind"> & { readonly approved?: boolean };

export type BrowserResult =
  | { readonly ok: true; readonly text: string; readonly url: string }
  | { readonly ok: false; readonly error: string };

/** 桥 → 主进程。 */
export type BrowserRequest = { readonly type: "browser"; readonly id: string; readonly op: BrowserOp };
/** 主进程 → 桥。 */
export type BrowserReply = { readonly type: "browser-result"; readonly id: string; readonly result: BrowserResult };

/** 一步最多等这么久。打开慢网页时主进程自己会先停在 20 秒。 */
export const BROWSER_TIMEOUT_MS = 30_000;

let send: ((request: BrowserRequest) => void) | null = null;
const waiting = new Map<string, { resolve: (result: BrowserResult) => void; timer: ReturnType<typeof setTimeout> }>();
let next = 0;

/** 电脑 App 里的桥启动时接上主进程。 */
export function useBrowserHost(post: (request: BrowserRequest) => void): void {
  send = post;
}

export function browserAvailable(): boolean {
  return send !== null;
}

/** 让主进程做一步，等它回话。超时、没接主进程都回一个失败结果，不抛错。 */
export function browse(op: BrowserOp, timeoutMs = BROWSER_TIMEOUT_MS): Promise<BrowserResult> {
  const post = send;
  if (!post) return Promise.resolve({ ok: false, error: "这台电脑的 Pupu 没有浏览器：只有电脑 App 里的桥能用。" });
  next += 1;
  const id = `b${next}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, error: `浏览器 ${Math.round(timeoutMs / 1000)} 秒没回话。` });
    }, timeoutMs);
    waiting.set(id, { resolve, timer });
    post({ type: "browser", id, op });
  });
}

/** 主进程的回包。不认识的 id（已经超时的）直接丢掉。 */
export function receiveBrowserReply(reply: BrowserReply): void {
  const entry = waiting.get(reply.id);
  if (!entry) return;
  waiting.delete(reply.id);
  clearTimeout(entry.timer);
  entry.resolve(reply.result);
}
