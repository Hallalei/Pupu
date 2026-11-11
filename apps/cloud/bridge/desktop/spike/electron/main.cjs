// 远程桌面验证的 Electron 推流端：在隐藏窗口里打开推流页，全程在后台跑。
// 不进程序坞、不弹选屏窗口，直接推主屏幕，和 M3 电脑 App 里的推流窗口是同一个做法。
//
// 用法：<Electron.app>/Contents/MacOS/Electron spike/electron/main.cjs "http://localhost:8790/sender?k=<钥匙>"
// 第一次用要在系统设置 → 隐私与安全性 → 屏幕录制里允许 Electron。

const { app, BrowserWindow, desktopCapturer, session, systemPreferences } = require("electron");

const url = process.argv.find((arg) => arg.startsWith("http://"));
if (!url) {
  console.error("要给推流页地址：Electron main.cjs http://localhost:8790/sender?k=...");
  process.exit(1);
}

app.dock?.hide();

app.whenReady().then(async () => {
  console.log(`屏幕录制权限：${systemPreferences.getMediaAccessStatus("screen")}`);
  // 推流页调 getDisplayMedia 时直接给主屏幕，不弹选屏窗口。
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    console.log(`可选的屏幕：${sources.map((source) => source.name).join("、") || "没有"}`);
    callback(sources[0] ? { video: sources[0] } : {});
  });

  const window = new BrowserWindow({
    show: false,
    width: 820,
    height: 720,
    // 关掉以后隐藏窗口里的页面照常算"可见"，定时器和截屏都不降速。
    webPreferences: { backgroundThrottling: false }
  });
  window.webContents.on("console-message", (event, _level, message) => console.log(`推流页：${event.message ?? message}`));
  window.webContents.on("did-finish-load", () => {
    // 带上用户手势，和在页面上点「开始截屏」一样。
    window.webContents.executeJavaScript("startCapture()", true).catch((error) => console.error(error));
  });
  await window.loadURL(url);
});

// 没有可见窗口，关掉进程就退出。
app.on("window-all-closed", () => app.quit());
