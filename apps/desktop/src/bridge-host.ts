/**
 * 桥在电脑 App 里的入口。主进程用 utilityProcess 拉起它，跑的是 Electron 自带的 Node，
 * 不用 ELECTRON_RUN_AS_NODE（技术方案 5.3）。凭据由主进程从 safeStorage 解出来发过来，
 * 状态发回主进程给托盘和窗口，托盘上点的收回、停命令、本机开关发过来。
 */
import type { BridgeConfig } from "../../cloud/bridge/config.ts";
import { usePrebuiltHelper } from "../../cloud/bridge/computer.ts";
import type { MenubarAction } from "../../cloud/bridge/menubar.ts";
import { runBridge, type RunningBridge } from "../../cloud/bridge/run.ts";
import type { FromBridge, ToBridge } from "./messages.ts";

const port = process.parentPort;
let config: BridgeConfig | null = null;
const waiting: ((config: BridgeConfig) => void)[] = [];
let onAction: ((action: MenubarAction) => void) | null = null;
let bridge: RunningBridge | null = null;

function post(message: FromBridge): void {
  port.postMessage(message);
}

function nextConfig(): Promise<BridgeConfig> {
  if (config) return Promise.resolve(config);
  return new Promise((resolve) => waiting.push(resolve));
}

function start(blocked: readonly string[]): void {
  bridge = runBridge({
    config: nextConfig,
    async rejected() {
      // 换了凭据才再连：主进程重新配对后会发新的过来。
      config = null;
      post({ type: "rejected" });
    },
    ui(handler) {
      onAction = handler;
      return {
        update(state) {
          post({ type: "state", state });
        },
        stop() {
          onAction = null;
        }
      };
    },
    blocked
  });
}

async function stop(): Promise<void> {
  if (bridge) {
    bridge.stop();
    // 停命令、关连接都很快，等不到也不拖着 App 退出。
    await Promise.race([bridge.done, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  process.exit(0);
}

port.on("message", (event) => {
  const message = event.data as ToBridge;
  if (message.type === "config") {
    config = message.config;
    if (message.helper) usePrebuiltHelper(message.helper);
    for (const resolve of waiting.splice(0)) resolve(message.config);
    if (!bridge) start(message.blocked);
  } else if (message.type === "action") {
    onAction?.(message.action);
  } else if (message.type === "stop") {
    void stop();
  }
});

process.on("SIGTERM", () => void stop());
