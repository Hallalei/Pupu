import { fileURLToPath } from "node:url";
import os from "node:os";
import { stopAllJobs } from "./actions.ts";
import { readConfig, writeConfig, configPath, type BridgeConfig } from "./config.ts";
import { installLaunchAgent, plistPath, uninstallLaunchAgent } from "./launchd.ts";
import { openBridge, type BridgeConnection } from "./session.ts";

const scriptPath = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "pair":
      await pair(flags);
      return;
    case "start":
      await start();
      return;
    case "install":
      await install();
      return;
    case "uninstall":
      await uninstallLaunchAgent();
      console.log("已卸下开机自启。凭据还在，要作废它再运行 revoke。");
      return;
    case "revoke":
      await revoke(flags);
      return;
    case "status":
      await status();
      return;
    default:
      console.log(`用法：
  node bridge/main.ts pair --url http://localhost:5173 [--name 名字] [--token 访问口令] [--force]
  node bridge/main.ts start
  node bridge/main.ts install
  node bridge/main.ts uninstall
  node bridge/main.ts status
  node bridge/main.ts revoke [--token 访问口令]`);
      process.exit(command ? 1 : 0);
  }
}

async function pair(flags: Map<string, string>): Promise<void> {
  const origin = originOf(flags.get("url"));
  try {
    await readConfig();
    if (flags.get("force") !== "true") {
      throw new Error("已经配对过。要再配一台，加上 --force。");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("已经配对")) throw error;
  }
  const name = flags.get("name")?.trim() || os.hostname() || "电脑";
  const access = flags.get("token");
  const response = await fetch(new URL("/api/computers", origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(access ? { authorization: `Bearer ${access}` } : {})
    },
    body: JSON.stringify({ name })
  });
  const body = (await response.json().catch(() => null)) as { id?: string; name?: string; token?: string; error?: string } | null;
  if (!response.ok || !body?.id || !body.token || !body.name) {
    throw new Error(body?.error || `配对失败：${response.status}`);
  }
  const config: BridgeConfig = { url: origin.toString().replace(/\/$/, ""), computerId: body.id, token: body.token, name: body.name };
  await writeConfig(config);
  console.log(`已配对「${config.name}」。`);
  console.log(`凭据写在 ${configPath()}，只这一次能看到。`);
  console.log("接下来让它常驻：node bridge/main.ts start");
  console.log("开机自启：node bridge/main.ts install");
}

async function start(): Promise<void> {
  let current: BridgeConnection | null = null;
  let stop = false;
  const shutdown = () => {
    stop = true;
    stopAllJobs();
    current?.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  let failures = 0;
  while (!stop) {
    const config = await readConfig();
    const session = openBridge(config);
    current = session;
    const end = await session.done;
    if (stop) break;
    if (end === "rejected") {
      console.error("凭据被拒绝。重新 pair。30 秒后再看一次配置。");
      await sleep(30_000);
      continue;
    }
    if (end === "busy") {
      console.error("这台电脑已经有桥连着。15 秒后再试。");
      await sleep(15_000);
      continue;
    }
    failures = session.welcomed() ? 0 : failures + 1;
    const delay = Math.min(10_000, 1000 * 2 ** Math.min(failures, 3));
    console.error("连接断了，正在重连。");
    await sleep(delay);
  }
}

async function install(): Promise<void> {
  await readConfig();
  const target = await installLaunchAgent(process.execPath, scriptPath);
  console.log(`已装成开机自启：${target}`);
  console.log(`日志在 ~/.pupu/bridge.log`);
}

async function revoke(flags: Map<string, string>): Promise<void> {
  const config = await readConfig();
  const access = flags.get("token");
  const response = await fetch(new URL(`/api/computers/${encodeURIComponent(config.computerId)}/revoke`, config.url), {
    method: "POST",
    headers: access ? { authorization: `Bearer ${access}` } : {}
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `吊销失败：${response.status}`);
  }
  console.log(`已吊销「${config.name}」。这台电脑的桥会断开，要再用就重新 pair。`);
}

async function status(): Promise<void> {
  const config = await readConfig();
  console.log(`「${config.name}」`);
  console.log(`id：${config.computerId}`);
  console.log(`云端：${config.url}`);
  console.log(`配置：${configPath()}`);
  console.log(`开机自启：${plistPath()}`);
}

function originOf(value: string | undefined): URL {
  if (!value) throw new Error("pair 需要 --url，比如 http://localhost:5173");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url 不是合法地址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url 要用 http 或 https。");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, "true");
    }
  }
  return { command, flags };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
