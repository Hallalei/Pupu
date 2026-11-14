#!/usr/bin/env node
// 只读体检：这份实例值不值得驱动。不打印任何密钥的值。
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const port = process.env.PUPU_VERIFY_PORT ?? "5199";
const host = process.env.PUPU_VERIFY_HOST ?? "localhost";
const cdpPort = process.env.PUPU_CDP_PORT ?? "9333";
const run = (command) => {
  try {
    return execSync(command, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const line = (ok, label, detail = "") => console.log(`${ok ? "ok " : "NO "} ${label}${detail ? `：${detail}` : ""}`);

console.log(`提交 ${run("git rev-parse --short HEAD")}，分支 ${run("git branch --show-current")}`);

const scaffold = existsSync(join(repo, "apps/cloud/node_modules/.pupu-verify/vite.config.ts"));
const listener = run(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).split("\n")[0];
const command = listener ? run(`ps -o command= -p ${listener}`) : "";
line(Boolean(listener) && command.includes(".pupu-verify"), `云端 ${port} 是验证实例`, listener ? `pid ${listener}` : "没在跑");

let state = null;
if (listener) {
  const response = await fetch(`http://${host}:${port}/api/state`).catch(() => null);
  state = response;
  line(response?.status === 200, "/api/state 可读", String(response?.status ?? "连不上"));
}

const vars = existsSync(join(repo, "apps/cloud/.dev.vars")) ? readFileSync(join(repo, "apps/cloud/.dev.vars"), "utf8") : "";
line(/^DEEPSEEK_API_KEY=.+/m.test(vars), "本地有 DEEPSEEK_API_KEY", "没有时 Pupu 不会回复");
line(/^ACCESS_TOKEN=/m.test(vars) === false, "本地没设 ACCESS_TOKEN", "设了就不能空码配对");
line(Boolean(run("command -v ego-browser")), "ego-browser 可用");
line(
  existsSync(join(repo, "apps/desktop/node_modules/electron/dist/Electron.app")),
  "电脑 App 的 Electron 本体在",
  "测电脑 App 才要；缺了跑 (cd apps/desktop && npm ci && node node_modules/electron/install.js)"
);

const cdp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`).catch(() => null);
console.log(`--  电脑 App CDP ${cdpPort}：${cdp?.ok ? "在跑" : "没在跑"}`);
const booted = run("xcrun simctl list devices booted").split("\n").filter((row) => row.includes("Booted"));
console.log(`--  模拟器：${booted.length ? booted.join("；").trim() : "没有启动的"}`);
console.log(`--  脚手架配置：${scaffold ? "存在" : "不存在"}`);
