import os from "node:os";
import WebSocket from "ws";
import { perform, controlJob, type ActionHost } from "./actions.ts";
import { configPath, requestsDir, terminalsDir, type BridgeConfig } from "./config.ts";
import {
  ALREADY_CONNECTED_CODE,
  BRIDGE_PING,
  BRIDGE_PONG,
  HEARTBEAT_MS,
  PROTOCOL_VERSION,
  REJECT_CODE,
  bridgeWebSocketUrl,
  parseDownFrame,
  type DownFrame,
  type UpFrame
} from "../src/bridge/protocol.ts";

export type ConnectEnd = "closed" | "rejected" | "busy";

export type BridgeConnection = {
  readonly done: Promise<ConnectEnd>;
  /** 连上并且已经 hello 过。用来判断重连要不要退避。 */
  welcomed(): boolean;
  /** 往云端发一帧。没连着返回 false。 */
  send(frame: UpFrame): boolean;
  close(): void;
};

/** 连接上的事，菜单栏要知道。 */
export type BridgeHooks = {
  onReady?(): void;
  onStatus?(status: Extract<DownFrame, { type: "status" }>): void;
  onDesktop?(frame: Extract<DownFrame, { type: "desktop" }>): void;
  onClosed?(): void;
};

/** 连上云端，直到这条连接关掉。`blocked` 是文件工具不让碰的路径，默认挡住桥的凭据。 */
export function openBridge(
  config: BridgeConfig,
  hooks: BridgeHooks = {},
  blocked: readonly string[] = [configPath()]
): BridgeConnection {
  let welcomed = false;
  let socket: WebSocket | null = null;
  const done = new Promise<ConnectEnd>((resolve) => {
    let settled = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    let welcomeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (end: ConnectEnd) => {
      if (settled) return;
      settled = true;
      if (ping) clearInterval(ping);
      if (welcomeTimer) clearTimeout(welcomeTimer);
      resolve(end);
    };
    const root = os.homedir();
    const host: ActionHost = {
      root,
      terminals: terminalsDir(),
      requests: requestsDir(),
      blocked,
      send(frame) {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      }
    };
    socket = new WebSocket(bridgeWebSocketUrl(config.url), {
      headers: { Authorization: `Bearer ${config.token}` }
    });
    const current = socket;
    welcomeTimer = setTimeout(() => {
      current.close(1000, "welcome timeout");
    }, 10_000);
    ping = setInterval(() => {
      if (current.readyState === WebSocket.OPEN) current.send(BRIDGE_PING);
    }, HEARTBEAT_MS);

    current.on("open", () => {
      // 等云端的 welcome 再 hello。心跳先开始，好让休眠的对象知道这台电脑还在。
    });
    current.on("message", (data) => {
      const raw = data.toString();
      if (raw === BRIDGE_PONG) return;
      const frame = parseDownFrame(raw);
      if (!frame) return;
      if (frame.type === "welcome") {
        welcomed = true;
        clearTimeout(welcomeTimer);
        current.send(
          JSON.stringify({
            type: "hello",
            protocol: PROTOCOL_VERSION,
            computerId: config.computerId,
            name: config.name,
            localRoot: root,
            terminalsFolder: terminalsDir()
          })
        );
        console.log(`已连上 ${config.url}，这台电脑是「${config.name}」。`);
        hooks.onReady?.();
        return;
      }
      if (frame.type === "exec") {
        void perform(frame.requestId, frame.action, host, frame.approved === true);
        return;
      }
      if (frame.type === "status") {
        hooks.onStatus?.(frame);
        return;
      }
      if (frame.type === "desktop") {
        hooks.onDesktop?.(frame);
        return;
      }
      if (frame.type === "cancel") controlJob(frame.requestId, "kill");
      if (frame.type === "detach") controlJob(frame.requestId, "detach");
    });
    current.on("close", (code, reason) => {
      hooks.onClosed?.();
      const why = reason.toString();
      if (why) console.error(why);
      if (code === REJECT_CODE) finish("rejected");
      else if (code === ALREADY_CONNECTED_CODE) finish("busy");
      else finish("closed");
    });
    current.on("error", (error) => {
      console.error(error.message);
    });
  });

  return {
    done,
    welcomed: () => welcomed,
    send(frame) {
      if (!welcomed || socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(frame));
      return true;
    },
    close() {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "bridge stopping");
      else socket?.terminate();
    }
  };
}
