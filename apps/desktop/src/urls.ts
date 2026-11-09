import os from "node:os";

export const DEFAULT_URL = "https://app.getpupu.com";

/**
 * 以前的默认地址，和 DEFAULT_URL 是同一个 Worker，凭据两边都认。
 * 0.2.1 以前的凭据按这个地址存，升级后搬过来，不用重新登录。
 */
export const LEGACY_URLS: readonly string[] = ["https://pupu.cobuilder-team.workers.dev"];

/** 只留协议、主机和端口，比如 https://pupu.example.com。 */
export function originOf(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Pupu 的地址要用 http 或 https。");
  return url.origin;
}

export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** 本机的开发服务器。没设访问口令时不填配对码也能配对。 */
export function isLocalOrigin(origin: string): boolean {
  const { hostname } = new URL(origin);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** 交给系统浏览器的外链只认这几种，别的（file:、自定义协议）一律不开。 */
export function canOpenExternally(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

/** 和命令行配对时用的名字一样，去掉 .local。 */
export function computerName(hostname = os.hostname()): string {
  return hostname.replace(/\.local$/i, "").trim() || "电脑";
}
