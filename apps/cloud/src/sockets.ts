// 改编自 Cloudflare agents 仓库的 examples/next/harnesses/pi（MIT 协议，见 licenses/）。
import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEventStream } from "@earendil-works/pi-durable";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import {
  ROOT_SESSION,
  type PiHarness,
  type PiSessionId
} from "agents/harness/pi";
import type { ClientMessage, ServerMessage } from "./protocol";

const SESSION_TAG_PREFIX = "pi-session:";
const SESSION_QUERY = "session";
/** `WebSocket.OPEN`；不是每个运行时的全局对象上都有这个常量。 */
const OPEN = 1;

function sessionTag(session: PiSessionId): string {
  return `${SESSION_TAG_PREFIX}${session}`;
}

function sessionFromRequest(request: Request): string {
  const session = new URL(request.url).searchParams.get(SESSION_QUERY);
  if (session === null || session === "") return ROOT_SESSION;
  if (!/^[1-9][0-9]{0,15}$/.test(session)) {
    throw new Error(`Invalid pi session ${JSON.stringify(session)}`);
  }
  return session;
}

function sessionOf(tags: readonly string[]): string | undefined {
  const tag = tags.find((candidate) =>
    candidate.startsWith(SESSION_TAG_PREFIX)
  );
  return tag?.slice(SESSION_TAG_PREFIX.length);
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // 检查状态和发送之间连接断了。
  }
}

/**
 * 把 pi 会话放到 WebSocket 上，只用 harness 的公开 API。
 *
 * 每条连接通过自己的 `session.events()` 跟随一个会话：先一份 `snapshot`，
 * 之后每次提交一批 pi 事件。订阅只在内存里，所以宿主在 `onStart` 里调
 * `reattach()`，给休眠后还活着的连接重新订阅并发一份新快照。
 */
export class PiSessionSockets {
  readonly #harness: PiHarness;
  readonly #getWebSockets: (tag?: string) => WebSocket[];
  readonly #onSubmit: (session: PiSessionId) => void;
  readonly #watches = new Map<WebSocket, AgentEventStream>();

  constructor(
    harness: PiHarness,
    getWebSockets: (tag?: string) => WebSocket[],
    /** 某个会话收到用户输入时调用。 */
    onSubmit: (session: PiSessionId) => void
  ) {
    this.#harness = harness;
    this.#getWebSockets = getWebSockets;
    this.#onSubmit = onSubmit;
  }

  options(): WebSocketsOptions {
    return {
      getConnectionTags: (_connection, ctx) => [
        sessionTag(sessionFromRequest(ctx.request))
      ],
      handlers: {
        onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#unwatch(connection),
        onError: (connection) => this.#unwatch(connection)
      }
    };
  }

  /** 发给所有连接，不管它在看哪个会话。 */
  broadcast(message: ServerMessage): void {
    for (const socket of this.#getWebSockets()) send(socket, message);
  }

  /** 对象重启后，给每条休眠的连接重新订阅。 */
  async reattach(): Promise<void> {
    if (this.#getWebSockets().length === 0) return;
    // 只能按标签找连接，不能按连接查标签，所以遍历会话、按会话标签找。
    for (const { id } of await this.#harness.sessions.list()) {
      for (const socket of this.#getWebSockets(sessionTag(id))) {
        await this.#watch(socket, id);
      }
    }
  }

  async #onConnect(connection: Connection, ctx: ConnectionContext) {
    const session = sessionFromRequest(ctx.request);
    send(connection, { type: "hello", session });
    await this.#watch(connection, session);
  }

  async #watch(socket: WebSocket, session: PiSessionId): Promise<void> {
    await this.#unwatch(socket);
    const stream = await this.#harness.session(session).events();
    this.#watches.set(socket, stream);
    send(socket, { type: "events", session, events: [stream.snapshot] });
    stream.start(async (events) => {
      if (socket.readyState !== OPEN) {
        void this.#unwatch(socket);
        return;
      }
      send(socket, { type: "events", session, events });
    });
  }

  async #unwatch(socket: WebSocket): Promise<void> {
    const watch = this.#watches.get(socket);
    if (!watch) return;
    this.#watches.delete(socket);
    await watch.stop();
  }

  async #onMessage(connection: Connection, raw: WebSocketMessage) {
    if (typeof raw !== "string") return;
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      send(connection, { type: "error", message: "Malformed JSON" });
      return;
    }
    const session = sessionOf(connection.tags) ?? ROOT_SESSION;
    try {
      const result = await this.#dispatch(connection, session, message);
      if (message.id !== undefined) {
        send(connection, { type: "result", id: message.id, result });
      }
    } catch (error) {
      send(connection, {
        type: "error",
        ...(message.id === undefined ? {} : { id: message.id }),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #dispatch(
    connection: Connection,
    session: PiSessionId,
    message: ClientMessage
  ): Promise<JsonValue> {
    const handle = this.#harness.session(session);
    switch (message.type) {
      case "submit": {
        const receipt = await handle.submit(message.input, {
          ...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
          ...(message.operationId ? { operationId: message.operationId } : {})
        });
        this.#onSubmit(session);
        return receipt;
      }
      case "abort":
        return await handle.abort();
      case "resync":
        await this.#watch(connection, session);
        return null;
      default:
        throw new Error(
          `Unknown message type ${JSON.stringify((message as { type: string }).type)}`
        );
    }
  }
}
