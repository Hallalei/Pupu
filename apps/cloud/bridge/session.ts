import os from "node:os";
import WebSocket from "ws";
import { cancelCall, detachCall, perform, type ActionHost } from "./actions.ts";
import { configPath, requestsDir, terminalsDir, type BridgeConfig } from "./config.ts";
import {
  ALREADY_CONNECTED_CODE,
  BRIDGE_PING,
  BRIDGE_PONG,
  HEARTBEAT_MS,
  OUTDATED_CODE,
  PROTOCOL_VERSION,
  REJECT_CODE,
  bridgeWebSocketUrl,
  parseDownFrame,
  type DownFrame,
  type UpFrame
} from "../src/bridge/protocol.ts";

/** rejected：凭据被拒。outdated：凭据没事，这边的协议版本和云端对不上，要更新。busy：这台电脑已经有桥连着。 */
export type ConnectEnd = "closed" | "rejected" | "busy" | "outdated";

export type BridgeConnection = {
  readonly done: Promise<ConnectEnd>;
  /** 收到过 welcome。用来判断重连要不要退避。 */
  welcomed(): boolean;
  /** 往云端发一帧。云端还没收下 hello 就返回 false。 */
  send(frame: UpFrame): boolean;
  close(): void;
};

/** 连接上的事，菜单栏要知道。 */
export type BridgeHooks = {
  /** 云端收下了 hello。它收下时会先推一帧 status，以这个为准，不以 welcome 为准。 */
  onReady?(): void;
  onStatus?(status: Extract<DownFrame, { type: "status" }>): void;
  onDesktop?(frame: Extract<DownFrame, { type: "desktop" }>): void;
  /** 经这台电脑转发的模型请求。 */
  onModel?(frame: Extract<DownFrame, { type: "model" }>): void;
  onClosed?(): void;
};

/** 连上云端，直到这条连接关掉。`blocked` 是文件工具不让碰的路径，默认挡住桥的凭据。 */
export function openBridge(
  config: BridgeConfig,
  hooks: BridgeHooks = {},
  blocked: readonly string[] = [configPath()]
): BridgeConnection {
  /** 等 welcome、hello 发出去了、云端收下了 hello。 */
  let stage: "opening" | "welcomed" | "accepted" = "opening";
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
        stage = "welcomed";
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
        return;
      }
      if (frame.type === "exec") {
        void perform(frame.requestId, frame.action, host, frame.approved === true);
        return;
      }
      if (frame.type === "status") {
        if (stage === "welcomed") {
          stage = "accepted";
          console.log(`已连上 ${config.url}，这台电脑是「${config.name}」。`);
          hooks.onReady?.();
        }
        hooks.onStatus?.(frame);
        return;
      }
      if (frame.type === "desktop") {
        hooks.onDesktop?.(frame);
        return;
      }
      if (frame.type === "model") {
        hooks.onModel?.(frame);
        return;
      }
      if (frame.type === "cancel") cancelCall(frame.requestId);
      if (frame.type === "detach") detachCall(frame.requestId);
    });
    current.on("close", (code, reason) => {
      hooks.onClosed?.();
      const why = reason.toString();
      if (why) console.error(why);
      if (code === REJECT_CODE) finish("rejected");
      else if (code === OUTDATED_CODE) finish("outdated");
      else if (code === ALREADY_CONNECTED_CODE) finish("busy");
      else finish("closed");
    });
    current.on("error", (error) => {
      console.error(error.message);
    });
  });

  return {
    done,
    welcomed: () => stage !== "opening",
    send(frame) {
      if (stage !== "accepted" || socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(frame));
      return true;
    },
    close() {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "bridge stopping");
      else socket?.terminate();
    }
  };
}
