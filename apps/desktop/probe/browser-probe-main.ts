/**
 * 原型的取证脚本，不进正式包（build.mjs 不打它）。跑法见 probe/run.mjs。
 *
 * 和电脑 App 走同一条路：桥那一侧在 utilityProcess 里调 bridge/browser.ts 的 browse()，
 * 主进程收到请求交给 BrowserHost，结果按 id 回到桥。测试页由本机 127.0.0.1 的小服务给。
 */
import { app, utilityProcess } from "electron";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserRequest } from "../../cloud/bridge/browser.ts";
import { BrowserHost } from "../src/browser-host.ts";

const out = process.env.PROBE_OUT ?? path.join(process.cwd(), "probe-out");
app.setPath("userData", path.join(out, "userdata"));
// 不进程序坞、不抢前台。
if (process.platform === "darwin") app.dock?.hide();

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Pupu 浏览器探针</title></head><body>
<h1>Pupu 浏览器探针</h1>
<p>计数：<span id="c">0</span></p>
<button onclick="c.textContent=+c.textContent+1;document.title='点过 '+c.textContent+' 次'">加一</button>
<p><label for="n">名字</label> <input id="n"></p>
<button onclick="out.textContent='你好，'+n.value">打招呼</button>
<p id="out"></p>
<a href="/two">下一页</a>
</body></html>`;

const lines: string[] = [];
function log(line: string): void {
  lines.push(line);
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  await mkdir(out, { recursive: true });
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/two" ? "<title>第二页</title><h1>第二页</h1><p>到了。</p>" : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const host = new BrowserHost({ log: (line) => log(`[主进程] ${line}`), background: true });
  const child = utilityProcess.fork(path.join(__dirname, "bridge.mjs"), [origin], { serviceName: "Pupu Probe Bridge", stdio: "pipe" });
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  let shots = 0;
  child.on("message", (message: BrowserRequest | { type: "shot" } | { type: "report"; lines: string[] }) => {
    if (message.type === "browser") {
      log(`[主进程] 收到桥的请求 ${message.id}：${JSON.stringify(message.op)}`);
      void host.run(message.op).then((result) => {
        log(`[主进程] 回给桥 ${message.id}：ok=${result.ok}`);
        child.postMessage({ type: "browser-result", id: message.id, result });
      });
    } else if (message.type === "shot") {
      shots += 1;
      const name = `shot-${shots}.png`;
      void host.screenshot().then(async (data) => {
        await writeFile(path.join(out, name), Buffer.from(data, "base64"));
        child.postMessage({ type: "shot-done", name });
      });
    } else if (message.type === "report") {
      lines.push(...message.lines);
      void (async () => {
        await writeFile(path.join(out, "report.txt"), `${lines.join("\n")}\n`);
        host.stop();
        server.close();
        app.exit(0);
      })();
    }
  });
  setTimeout(() => {
    log("超时，退出。");
    void writeFile(path.join(out, "report.txt"), `${lines.join("\n")}\n`).then(() => app.exit(2));
  }, 90_000);
}

app.on("window-all-closed", () => {});
void app.whenReady().then(main).catch((error: unknown) => {
  log(`失败：${error instanceof Error ? error.stack : String(error)}`);
  void writeFile(path.join(out, "report.txt"), `${lines.join("\n")}\n`).then(() => app.exit(1));
});
