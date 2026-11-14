#!/usr/bin/env node
// 经 CDP 操作后台的 Pupu 电脑 App，窗口不到前台。
// 用法：cdp.mjs targets | eval '<js>' | shot <png 路径> | close
import { writeFileSync } from "node:fs";

const port = process.env.PUPU_CDP_PORT ?? "9333";
const [command, argument] = process.argv.slice(2);

async function call(url, method, params = {}) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error(`连不上 ${url}`));
  });
  socket.send(JSON.stringify({ id: 1, method, params }));
  const reply = await new Promise((done) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) done(message);
    };
    socket.onclose = () => done({ result: {} });
  });
  socket.close();
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}

const base = `http://127.0.0.1:${port}`;
if (command === "close") {
  const version = await (await fetch(`${base}/json/version`)).json();
  await call(version.webSocketDebuggerUrl, "Browser.close");
  process.exit(0);
}

const targets = (await (await fetch(`${base}/json`)).json()).filter((target) => target.type === "page");
if (command === "targets") {
  for (const target of targets) console.log(`${target.title}\t${target.url}`);
  process.exit(0);
}

// 主窗口是加载云端页面的那个，其他是隐藏的采集窗口和 Pupu 浏览器的页面（也是 http）。
// CDP_PAGE 给网址开头来挑，默认挑本地验证的云端（PUPU_VERIFY_HOST、PUPU_VERIFY_PORT，没设就是 http://localhost:5199）。
const prefix = process.env.CDP_PAGE ?? `http://${process.env.PUPU_VERIFY_HOST ?? "localhost"}:${process.env.PUPU_VERIFY_PORT ?? "5199"}`;
const page = targets.find((target) => target.url.startsWith(prefix)) ?? targets.find((target) => target.url.startsWith("http")) ?? targets[0];
if (!page) throw new Error("没有页面");

if (command === "eval") {
  const result = await call(page.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: argument,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "脚本报错");
  console.log(JSON.stringify(result.result?.value ?? null));
} else if (command === "shot") {
  const { data } = await call(page.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
  writeFileSync(argument, Buffer.from(data, "base64"));
  console.log(argument);
} else {
  console.error("用法：cdp.mjs targets | eval '<js>' | shot <png 路径> | close");
  process.exit(2);
}
