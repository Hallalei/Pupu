/** 更新文件放在 R2 的 pupu-downloads 桶，dl.getpupu.com 是它的公开域名。 */
export const DOWNLOAD_ORIGIN = "https://dl.getpupu.com";
export const FEED_KEY = "mac-arm64.json";

/** Squirrel.Mac 的 JSON 清单：`currentRelease` 和本机版本不一样就下载 `url` 指的 zip。 */
export function updateFeed(version: string, url: string, date: Date) {
  return {
    currentRelease: version,
    releases: [{ version, updateTo: { version, name: version, pub_date: date.toISOString(), url } }]
  };
}
