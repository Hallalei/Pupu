import { fileURLToPath } from "node:url";
import os from "node:os";
import { readConfig, writeConfig, configPath, type BridgeConfig } from "./config.ts";
import { installLaunchAgent, plistPath, uninstallLaunchAgent } from "./launchd.ts";
import { localPath, readLocal } from "./local.ts";
import { modelPath, parseLocalModel, readModelFile, writeModelFile } from "./model.ts";
import { probeModel } from "../src/model/probe.ts";
import { startMenubar } from "./menubar.ts";
import { runBridge } from "./run.ts";

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
      await revoke();
      return;
    case "status":
      await status();
      return;
    case "model":
      await model(flags);
      return;
    default:
      console.log(`用法：
  node bridge/main.ts pair --url https://你的 Pupu --code 配对码 [--name 名字] [--force]
  node bridge/main.ts start
  node bridge/main.ts install
  node bridge/main.ts uninstall
  node bridge/main.ts status
  node bridge/main.ts revoke
  node bridge/main.ts model --base-url http://localhost:11434/v1 --model qwen3 [--context 32000] [--vision]
  node bridge/main.ts model --clear

配对码在网页或 App 的设置里生成，10 分钟内有效，用一次就作废。
连本机的开发服务器可以不带；手边没有登录的设备时，可以用 --token 访问口令 代替。`);
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
  const code = flags.get("code");
  const access = flags.get("token");
  const response = await fetch(new URL("/api/pair", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "computer",
      name,
      ...(code ? { code } : {}),
      ...(access ? { accessToken: access } : {})
    })
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
  const bridge = runBridge({
    config: readConfig,
    async rejected() {
      console.error("凭据被拒绝。重新 pair。30 秒后再看一次配置。");
      await sleep(30_000);
    },
    ui: startMenubar,
    blocked: [configPath(), modelPath()],
    model: readModelFile
  });
  process.on("SIGINT", bridge.stop);
  process.on("SIGTERM", bridge.stop);
  await bridge.done;
}

/**
 * 设这台电脑上的模型，Pupu 可以经这台电脑转发模型请求。key 从环境变量 PUPU_MODEL_KEY 读，不走命令行参数，
 * 免得留在 shell 历史里。存之前试一次能不能调工具。桥要重启才用上新的。
 */
async function model(flags: Map<string, string>): Promise<void> {
  if (flags.get("clear") === "true") {
    await writeModelFile(null);
    console.log("已清掉这台电脑上的模型。重启桥后生效。");
    return;
  }
  const parsed = parseLocalModel({
    baseUrl: flags.get("base-url"),
    model: flags.get("model"),
    apiKey: process.env.PUPU_MODEL_KEY ?? "",
    contextWindow: flags.get("context"),
    vision: flags.get("vision") === "true"
  });
  if (typeof parsed === "string") throw new Error(parsed);
  const probe = await probeModel(parsed);
  if (!probe.ok) throw new Error(probe.error);
  await writeModelFile(parsed);
  console.log(`已存好：${parsed.model}，上下文 ${parsed.contextWindow}${parsed.vision ? "，能看图" : ""}。写在 ${modelPath()}。`);
  console.log("重启桥后生效，然后在网页的设置里把模型换成这台电脑。");
}

async function install(): Promise<void> {
  await readConfig();
  const target = await installLaunchAgent(process.execPath, scriptPath);
  console.log(`已装成开机自启：${target}`);
  console.log(`日志在 ~/.pupu/bridge.log`);
}

/** 拿这台电脑自己的凭据注销自己，不用访问口令。 */
async function revoke(): Promise<void> {
  const config = await readConfig();
  const response = await fetch(new URL("/api/bridge/revoke", config.url), {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}` }
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
  const switches = await readLocal();
  const on = (value: boolean) => (value ? "开" : "关");
  console.log(`本机开关（${localPath()}）：跑命令和写文件 ${on(switches.allowCommands)}，操作屏幕 ${on(switches.allowScreen)}`);
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
