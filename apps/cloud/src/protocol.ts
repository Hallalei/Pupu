// 改编自 Cloudflare agents 仓库的 examples/next/harnesses/pi（MIT 协议，见 licenses/）。
import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import type { PiSessionId, PiWhenBusy } from "agents/harness/pi";

/**
 * 浏览器和 Pupu 之间的 WebSocket 协议。每条连接跟随一个 pi 会话（`?session=`）：
 * 主对话是根会话，每个项目各是一个会话。
 */

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
  | { readonly type: "result"; readonly id: string; readonly result: JsonValue }
  | { readonly type: "error"; readonly id?: string; readonly message: string };

export type {
  PiMessage as TranscriptMessage,
  PiMessagePart as TranscriptPart
} from "./transcript";
export type { PiSessionView as SessionView } from "./view";
