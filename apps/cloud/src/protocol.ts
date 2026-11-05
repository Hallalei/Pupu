// 改编自 Cloudflare agents 仓库的 examples/next/harnesses/pi（MIT 协议，见 licenses/）。
import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import type { PiSessionId, PiWhenBusy } from "agents/harness/pi";
import type { ComputerActivity } from "./bridge/activity";

/**
 * 浏览器和 Pupu 之间的 WebSocket 协议。每条连接跟随一个 pi 会话（`?session=`）：
 * 主会话是根会话，每人的私聊和每个项目各是一个会话。别人的私聊和查不到的会话连不上，
 * 连接时收到一条 `{ error }` 就以 1011 关闭。
 */

/** 设备被吊销时，Pupu 用这个码关掉它的 WebSocket。客户端收到就别再重连，回登录页。 */
export const REVOKED_CLOSE_CODE = 4003;

/** 浏览器 → Pupu。带 `id` 的命令会收到 `result` 或 `error`。 */
export type ClientMessage =
  | {
      readonly type: "submit";
      readonly id?: string;
      readonly input: UserInput;
      readonly whenBusy?: PiWhenBusy;
      readonly operationId?: string;
    }
  | { readonly type: "abort"; readonly id?: string }
  /** 要一份新的快照。 */
  | { readonly type: "resync"; readonly id?: string };

/** Pupu → 浏览器。 */
export type ServerMessage =
  | { readonly type: "hello"; readonly session: PiSessionId }
  /**
   * pi 自己的 agent 事件。一次订阅的第一批、以及服务端丢了订阅之后的第一批，
   * 都以 `snapshot` 开头，客户端用它整体替换状态。
   */
  | {
      readonly type: "events";
      readonly session: PiSessionId;
      readonly events: readonly AgentEvent[];
    }
  /** 项目变了，客户端重新拉一次 /api/state。 */
  | { readonly type: "projects_changed" }
  /** 电脑连上、断开或吊销了，客户端重新拉一次 /api/state。 */
  | { readonly type: "computers_changed" }
  /** 有新的请示，或者请示处理完了，客户端重新拉一次 /api/state。 */
  | { readonly type: "approvals_changed" }
  /** 有设备配对上或者被吊销了，客户端重新拉一次 /api/state。 */
  | { readonly type: "devices_changed" }
  /**
   * 电脑在做的事变了：开始或做完一步、有请示要批、连上或断开。整份带上，替换 /api/state 里的
   * `activity`，不用重新拉。只在内容变了的时候发。
   */
  | { readonly type: "activity"; readonly activity: readonly ComputerActivity[] }
  | { readonly type: "result"; readonly id: string; readonly result: JsonValue }
  | { readonly type: "error"; readonly id?: string; readonly message: string };

export type {
  PiMessage as TranscriptMessage,
  PiMessagePart as TranscriptPart
} from "./transcript";
export type { PiSessionView as SessionView } from "./view";
