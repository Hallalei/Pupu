import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { renderSVG } from "uqr";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * 远程桌面的验证：在局域网里开一个网页，手机打开就能看这台电脑的屏幕。
 * 这里只转信令，画面和输入走 WebRTC，直接在手机和推流端之间。
 * 接进 Pupu 以后，这一层换成桥和云端。
 *
 * 推流端默认是这台电脑 Chrome 里的推流页（/sender），和 Electron 用的是同一套 Chromium WebRTC；
 * 键鼠由推流页经这里交给输入助手 pupu-input 注入；量延迟用的时间戳由小窗 pupu-stamp 画在屏幕上，
 * 推流页放在后台也能量。两个助手用 npm run desktop:helpers 编译。
 * PUPU_SENDER=native 时改用原生 libwebrtc 的 pupu-desktop，推流和键鼠都由它管。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.join(here, "..", ".build");
const nativeBin = process.env.PUPU_DESKTOP_BIN ?? path.join(build, "release", "PupuDesktop");
const inputBin = process.env.PUPU_INPUT_BIN ?? path.join(build, "pupu-input");
const stampBin = process.env.PUPU_STAMP_BIN ?? path.join(build, "pupu-stamp");
const native = process.env.PUPU_SENDER === "native";
const port = Number(process.env.PORT ?? 8790);
// 局域网里谁都能连这个端口，地址里带上这串钥匙才给看、给操作。
const key = process.env.PUPU_SPIKE_KEY ?? randomBytes(4).toString("hex");
const stunOnly = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
let iceServers: unknown[] = stunOnly;

// TURN 密钥放在 apps/cloud/.dev.vars（不提交）：PUPU_TURN_KEY_ID、PUPU_TURN_KEY_TOKEN。
// 有密钥就向 Cloudflare 换短期凭证，推流端和观看端都拿它连 TURN；没有就只用 STUN。
function devVars(): Record<string, string> {
  const file = path.join(here, "..", "..", "..", ".dev.vars");
  if (!existsSync(file)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match?.[2]) vars[match[1]] = match[2];
  }
  return vars;
}

async function refreshTurn(): Promise<void> {
  const { PUPU_TURN_KEY_ID: id, PUPU_TURN_KEY_TOKEN: token } = devVars();
  if (!id || !token) {
    console.log("没有 TURN 密钥，只用 STUN");
    return;
  }
  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: 6 * 3600 })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { iceServers: { urls: string[]; username?: string; credential?: string }[] };
    // Cloudflare 建议浏览器里去掉 53 端口的地址：很多浏览器会直接拦掉，白等超时。
    iceServers = body.iceServers.map((server) => ({ ...server, urls: server.urls.filter((url) => !/:53\b/.test(url)) }));
    console.log(`TURN 凭证已签发（6 小时有效）：${iceServers.flatMap((server) => (server as { urls: string[] }).urls).join("、")}`);
  } catch (error) {
    console.log(`TURN 凭证签发失败，只用 STUN：${(error as Error).message}`);
  }
}

function lanAddresses(): string[] {
  const found: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) found.push(address.address);
    }
  }
  return found;
}

function viewerUrl(host: string): string {
  return `http://${host}:${port}/?k=${key}`;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// 经 cloudflared 隧道进来的请求也是从本机连过来的，靠它加的 cf-connecting-ip 头认出公网来客。
function isLocal(request: http.IncomingMessage): boolean {
  return isLoopback(request.socket.remoteAddress) && !request.headers["cf-connecting-ip"];
}

function clientAddress(request: http.IncomingMessage): string | undefined {
  const forwarded = request.headers["cf-connecting-ip"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? request.socket.remoteAddress;
}

function startMessage(params: URLSearchParams): Record<string, unknown> {
  return {
    type: "start",
    source: params.get("source") === "pattern" ? "pattern" : "screen",
    fps: Number(params.get("fps") ?? 30),
    maxWidth: Number(params.get("w") ?? 1920),
    codec: params.get("codec") ?? "H264",
    kbps: Number(params.get("kbps") ?? 8000),
    hint: params.get("hint") ?? "detail",
    stamp: true,
    iceServers,
    // relay=1 时两端都只走 TURN，量中转这条路。
    relay: params.get("relay") === "1"
  };
}

function record(from: string, message: Record<string, unknown>): void {
  // 一行一个 JSON，方便事后汇总。
  console.log(JSON.stringify({ at: new Date().toISOString(), from, ...message }));
}

async function page(response: http.ServerResponse, file: string): Promise<void> {
  try {
    const html = await readFile(path.join(here, file));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  } catch {
    response.writeHead(500).end();
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://local");
  const local = isLocal(request);
  if (url.pathname === "/") {
    // 记一笔谁打开了观看页：手机连不上时，分得清是网络不通还是页面开了但连接没建起来。
    console.log(`观看页被打开：${clientAddress(request)}`);
    void page(response, "viewer.html");
  } else if (url.pathname === "/sender" && local && !native) {
    void page(response, "sender.html");
  } else if (url.pathname === "/qr.svg" && local) {
    // 推流页上给手机扫的二维码。
    const host = lanAddresses()[0] ?? "localhost";
    response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store", "x-viewer-url": viewerUrl(host) });
    response.end(renderSVG(viewerUrl(host), { border: 2 }));
  } else {
    response.writeHead(404).end();
  }
});

const sockets = new WebSocketServer({ server, path: "/ws" });

sockets.on("connection", (socket, request) => {
  const params = new URL(request.url ?? "/ws", "http://local").searchParams;
  if (params.get("k") !== key) {
    socket.close(4001, "钥匙不对");
    return;
  }
  if (native) {
    acceptNative(socket, params, clientAddress(request));
  } else if (params.get("role") === "sender") {
    if (isLocal(request)) acceptSender(socket);
    else socket.close(4003, "推流页只能在这台电脑上打开");
  } else {
    acceptViewer(socket, params, clientAddress(request));
  }
});

// ---- Chrome 推流页 ----

let sender: WebSocket | null = null;
let viewer: { socket: WebSocket; params: URLSearchParams } | null = null;
let input: ChildProcess | null = null;

function send(socket: WebSocket | null | undefined, message: Record<string, unknown>): void {
  if (socket?.readyState === socket?.OPEN) socket?.send(JSON.stringify(message));
}

function parse(data: unknown): Record<string, unknown> | null {
  try {
    const message = JSON.parse(String(data));
    return message && typeof message === "object" ? message : null;
  } catch {
    return null;
  }
}

function acceptSender(socket: WebSocket): void {
  sender?.close(4000, "replaced");
  sender = socket;
  console.log("推流页连上了");
  if (viewer) send(socket, startMessage(viewer.params));

  socket.on("message", (data) => {
    const message = parse(data);
    if (!message) return;
    if (message.type === "input") {
      injectInput(message.event);
      return;
    }
    if (message.type === "log") {
      console.log(`推流页：${message.text}`);
      return;
    }
    if (message.type === "senderStats") record("sender", message);
    send(viewer?.socket, message);
  });
  socket.on("close", () => {
    if (sender !== socket) return;
    sender = null;
    console.log("推流页断开了");
    send(viewer?.socket, { type: "error", message: "电脑上的推流页关了" });
  });
}

function acceptViewer(socket: WebSocket, params: URLSearchParams, address: string | undefined): void {
  // 同一时间只给一个人看，后来的顶掉先来的。
  viewer?.socket.close(4000, "replaced");
  viewer = { socket, params };
  console.log(`有人连上了：${address}`);
  send(socket, { type: "config", iceServers, relay: params.get("relay") === "1" });
  if (sender) send(sender, startMessage(params));
  else send(socket, { type: "error", message: "电脑上的推流页还没打开" });

  socket.on("message", (data) => {
    const message = parse(data);
    if (!message) return;
    if (message.type === "report") {
      record("viewer", message);
      return;
    }
    send(sender, message);
  });
  socket.on("close", () => {
    if (viewer?.socket !== socket) return;
    viewer = null;
    send(sender, { type: "stop" });
  });
}

function injectInput(event: unknown): void {
  if (!event || typeof event !== "object") return;
  if (!input) {
    if (!existsSync(inputBin)) {
      send(viewer?.socket, { type: "error", message: "输入助手还没编译：npm run desktop:helpers" });
      return;
    }
    const child = spawn(inputBin, [], { stdio: ["pipe", "pipe", "inherit"] });
    input = child;
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const message = parse(line);
      if (message) send(viewer?.socket, message);
    });
    child.stdin?.on("error", () => {});
    child.once("exit", () => {
      if (input === child) input = null;
    });
  }
  input.stdin?.write(`${JSON.stringify(event)}\n`);
}

// ---- 原生 pupu-desktop ----

let active: { socket: WebSocket; child: ChildProcess } | null = null;

function acceptNative(socket: WebSocket, params: URLSearchParams, address: string | undefined): void {
  if (active) {
    active.socket.close(4000, "replaced");
    stopChild(active.child);
  }
  const child = spawn(nativeBin, [], { stdio: ["pipe", "pipe", "inherit"] });
  active = { socket, child };
  console.log(`有人连上了：${address}`);

  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (socket.readyState === socket.OPEN) socket.send(line);
  });
  child.once("error", (error) => {
    socket.send(JSON.stringify({ type: "error", message: `pupu-desktop 启动不了：${error.message}` }));
  });
  child.once("exit", (code) => {
    if (socket.readyState === socket.OPEN) socket.close(1011, `pupu-desktop 退出了（${code}）`);
  });
  child.stdin?.on("error", () => {
    // 子进程退出时管道断了，上面 exit 会处理。
  });

  socket.on("message", (data) => {
    const message = parse(data);
    if (message?.type === "report") record("viewer", message);
    else child.stdin?.write(`${data.toString()}\n`);
  });
  socket.on("close", () => {
    stopChild(child);
    if (active?.child === child) active = null;
  });

  child.stdin?.write(`${JSON.stringify(startMessage(params))}\n`);
}

function stopChild(child: ChildProcess): void {
  child.stdin?.end();
  setTimeout(() => child.kill("SIGTERM"), 500).unref();
}

// 时间戳小窗跟着服务一起起停：它读到 stdin 关了就退出。
const stamp = !native && existsSync(stampBin) ? spawn(stampBin, [], { stdio: ["pipe", "ignore", "inherit"] }) : null;
if (!native && !stamp) console.log("时间戳小窗还没编译，量不了延迟：npm run desktop:helpers");

process.on("exit", () => {
  input?.kill();
  stamp?.kill();
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(0));

await refreshTurn();
setInterval(() => void refreshTurn(), 5 * 3600 * 1000).unref();

server.listen(port, "0.0.0.0", () => {
  console.log(`远程桌面验证页已开（推流端：${native ? "原生 pupu-desktop" : "Chrome 推流页"}）`);
  if (!native) console.log(`  在这台电脑的 Chrome 里打开推流页：http://localhost:${port}/sender?k=${key}`);
  console.log("  手机打开：");
  for (const address of lanAddresses()) console.log(`    ${viewerUrl(address)}`);
  console.log(`    ${viewerUrl("localhost")}`);
});
