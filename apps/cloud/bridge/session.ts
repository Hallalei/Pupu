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
  parseDownFrame
} from "../src/bridge/protocol.ts";

export type ConnectEnd = "closed" | "rejected" | "busy";

export type BridgeConnection = {
  readonly done: Promise<ConnectEnd>;
  /** 连上并且已经 hello 过。用来判断重连要不要退避。 */
  welcomed(): boolean;
  close(): void;
};

/** 连上云端，直到这条连接关掉。 */
export function openBridge(config: BridgeConfig): BridgeConnection {
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
      blocked: [configPath()],
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
        return;
      }
      if (frame.type === "exec") {
        void perform(frame.requestId, frame.action, host);
        return;
      }
      if (frame.type === "cancel") controlJob(frame.requestId, "kill");
      if (frame.type === "detach") controlJob(frame.requestId, "detach");
    });
    current.on("close", (code, reason) => {
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
    close() {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "bridge stopping");
      else socket?.terminate();
    }
  };
}
