/**
 * 探针：Pupu 浏览器的页面是 WebContentsView，平时挂在从不显示的宿主窗口里，接手时挪进另一个窗口再挪回来。
 * 看三件事：每个状态下都截得到画面；挪来挪去后 CDP 的点击照样管用；宿主窗口一直不显示。
 * 量出来的结论（Electron 45.2.1，macOS）：宿主里 `capturePage(stayHidden)` 报「Current display surface not available
 * for capture」，CDP 的 `Page.captureScreenshot` 三种状态都截得到，所以 browser-host.ts 的画面改用 CDP 截。
 * 用法：node probe/run-view.mjs <输出目录>，报告在 <输出目录>/report.txt，每个状态的截图存成 jpg。
 */
import { app, BrowserWindow, WebContentsView } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const out = process.env.PROBE_OUT ?? process.cwd();
app.setPath("userData", path.join(out, "userdata"));
// 不进程序坞、不抢前台。
if (process.platform === "darwin") app.dock?.hide();
const report: string[] = [];
const note = (line: string) => report.push(line);
const PAGE = `data:text/html,<title>0</title><button style="position:fixed;left:20px;top:20px;width:200px;height:80px" onclick="document.title=String(+document.title+1)">+1</button>`;
const HOST = { x: 0, y: 0, width: 1280, height: 860 };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(view: WebContentsView, label: string): Promise<void> {
  const viaCapturePage = await view.webContents.capturePage(undefined, { stayHidden: true }).then(
    (image) => (image.isEmpty() ? "空" : JSON.stringify(image.getSize())),
    (error: unknown) => `出错 ${String(error)}`
  );
  const debug = view.webContents.debugger;
  if (!debug.isAttached()) debug.attach("1.3");
  const shot = await Promise.race([
    debug.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: 60 }).then((r: { data: string }) => r.data, (e: unknown) => `出错 ${String(e)}`),
    pause(4000).then(() => "超时")
  ]);
  if (shot.length > 100) await writeFile(path.join(out, `${label}.jpg`), Buffer.from(shot, "base64"));
  note(`${label}：capturePage ${viaCapturePage}；CDP 截图 ${shot.length > 100 ? `${shot.length} 字节` : shot}`);
}

async function click(view: WebContentsView, label: string): Promise<void> {
  const debug = view.webContents.debugger;
  if (!debug.isAttached()) debug.attach("1.3");
  for (const type of ["mousePressed", "mouseReleased"]) {
    await debug.sendCommand("Input.dispatchMouseEvent", { type, x: 60, y: 50, button: "left", clickCount: 1 });
  }
  await pause(300);
  note(`${label}：点过后标题 ${view.webContents.getTitle()}`);
}

void app
  .whenReady()
  .then(async () => {
    const host = new BrowserWindow({ ...HOST, show: false });
    host.on("show", () => note("出错：宿主窗口被显示了"));
    const view = new WebContentsView({ webPreferences: { partition: "probe-view", sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    view.setBounds(HOST);
    host.contentView.addChildView(view);
    await view.webContents.loadURL(PAGE);
    await capture(view, "宿主里");
    await click(view, "宿主里");

    const main = new BrowserWindow({ width: 900, height: 640, show: false });
    await main.loadURL("data:text/html,<body style='background:%23eee'>main</body>");
    main.showInactive();
    host.contentView.removeChildView(view);
    main.contentView.addChildView(view);
    view.setBounds({ x: 20, y: 60, width: 860, height: 520 });
    await pause(500);
    await capture(view, "主窗口里");
    await click(view, "主窗口里");

    main.contentView.removeChildView(view);
    host.contentView.addChildView(view);
    view.setBounds(HOST);
    main.hide();
    await pause(500);
    await capture(view, "回到宿主");
    await click(view, "回到宿主");
    note(`宿主一直没显示：${!host.isVisible()}`);
  })
  .catch((error: unknown) => note(`出错 ${String(error)}`))
  .finally(async () => {
    await writeFile(path.join(out, "report.txt"), report.join("\n"));
    app.exit(0);
  });
