import { app, autoUpdater } from "electron";
import { DOWNLOAD_ORIGIN, FEED_KEY } from "./update-feed.ts";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * 启动时和每 4 小时查一次，有新版本就在后台下好。下好后不再查：再查 Squirrel 会重下一遍。
 * 不点「重启」也行，退出时自动换上，下次打开就是新版。开发版没有签名，不走这里。
 * 写法参考 update-electron-app 的静态清单。
 */
export function startUpdates(onReady: (version: string) => void, log: (line: string) => void): void {
  if (!app.isPackaged) return;
  autoUpdater.setFeedURL({ url: `${DOWNLOAD_ORIGIN}/${FEED_KEY}`, serverType: "json" });
  autoUpdater.on("error", (error) => log(`更新失败：${error.message}`));
  const timer = setInterval(() => autoUpdater.checkForUpdates(), CHECK_EVERY_MS);
  autoUpdater.once("update-downloaded", (_event, _notes, version) => {
    clearInterval(timer);
    log(`新版本 ${version} 下好了。`);
    onReady(version);
  });
  autoUpdater.checkForUpdates();
}
