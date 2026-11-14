#!/usr/bin/env node
// 起一份隔离的云端：自己的端口、自己的空数据，不碰 apps/cloud/.wrangler/state。
// vite.config.ts 里的 cloudflare() 换成带 persistState 的版本，写到 node_modules 下，退出时删掉。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const cloud = join(repo, "apps/cloud");
const port = process.env.PUPU_VERIFY_PORT ?? "5199";
const state = process.env.PUPU_VERIFY_STATE ?? "/tmp/pupu-verify/state";
// 浏览器的 cookie 按主机名不按端口：localhost 上另一个验证实例种的 cookie 会带过来，被当成坏凭据。并行验证时换成 127.0.0.1。
const host = process.env.PUPU_VERIFY_HOST;
const scaffold = join(cloud, "node_modules/.pupu-verify");
const config = join(scaffold, "vite.config.ts");

const source = readFileSync(join(cloud, "vite.config.ts"), "utf8");
if (!source.includes("cloudflare()")) {
  console.error("vite.config.ts 里找不到 cloudflare()，更新 serve-cloud.mjs 的替换规则");
  process.exit(1);
}
if (existsSync(config)) {
  console.error(`${config} 已存在：另一次验证在跑，或上次没清理。先跑 doctor.mjs`);
  process.exit(1);
}

rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
mkdirSync(scaffold, { recursive: true });
writeFileSync(config, source.replace("cloudflare()", `cloudflare({ persistState: { path: ${JSON.stringify(state)} } })`));

const server = spawn("npx", ["vite", "dev", "--config", config, "--port", port, "--strictPort", ...(host ? ["--host", host] : [])], {
  cwd: cloud,
  stdio: "inherit"
});

function cleanup() {
  rmSync(scaffold, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
