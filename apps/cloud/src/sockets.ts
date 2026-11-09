// 改编自 Cloudflare agents 仓库的 examples/next/harnesses/pi（MIT 协议，见 licenses/）。
import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEventStream } from "@earendil-works/pi-durable";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import type { PiHarness, PiSessionId } from "agents/harness/pi";
import type { ClientMessage, ServerMessage } from "./protocol";
import type { BridgeSocket } from "./bridge/hub";
import { DEVICE_HEADER, deviceOfTags, deviceTag } from "./devices.ts";
import { sentInput, type Sender } from "./messages.ts";
import { MAIN_SESSION } from "./threads.ts";

const SESSION_TAG_PREFIX = "pi-session:";
const SESSION_QUERY = "session";
/** `WebSocket.OPEN`；不是每个运行时的全局对象上都有这个常量。 */
const OPEN = 1;

function sessionTag(session: PiSessionId): string {
  return `${SESSION_TAG_PREFIX}${session}`;
}

function sessionFromRequest(request: Request): string {
  const session = new URL(request.url).searchParams.get(SESSION_QUERY);
  if (session === null || session === "") return MAIN_SESSION;
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

/** 和会话连接共用一条升级入口时，桥和远程桌面的连接从这里分出去。 */
export type BridgeSocketHandlers = {
  readonly tag: string;
  isRequest(request: Request): boolean;
  /** 除了 `tag` 再打的标签，比如吊销时按设备断开用的。 */
  tags?(request: Request): readonly string[];
  onConnect(socket: BridgeSocket, request: Request): Promise<void>;
  onMessage(socket: BridgeSocket, message: string): Promise<void>;
  onClose(socket: BridgeSocket): void;
};

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
  readonly #getTags: (socket: WebSocket) => readonly string[];
  readonly #onSubmit: (session: PiSessionId) => void;
  readonly #senderOf: (device: string | null) => Sender | null;
  readonly #mayOpen: (session: PiSessionId, device: string | null) => boolean;
  readonly #onAbort: (session: PiSessionId, at: number) => void;
  readonly #routes: readonly BridgeSocketHandlers[];
  readonly #watches = new Map<WebSocket, AgentEventStream>();
  /** 每条连接第几次订阅，见 `#watch`。 */
  readonly #watchTurns = new WeakMap<WebSocket, number>();

  constructor(
    harness: PiHarness,
    getWebSockets: (tag?: string) => WebSocket[],
    getTags: (socket: WebSocket) => readonly string[],
    /** 某个会话收到用户输入时调用。 */
    onSubmit: (session: PiSessionId) => void,
    /** 这台设备是哪个成员的。不属于谁是 null。 */
    senderOf: (device: string | null) => Sender | null,
    /** 这台设备能不能打开这个会话。私聊只有本人能开，见 threads.ts。 */
    mayOpen: (session: PiSessionId, device: string | null) => boolean,
    /** 用户把这个会话停下了。`at` 是停下的时间，这之前提交的都不做了。 */
    onAbort: (session: PiSessionId, at: number) => void,
    routes: readonly BridgeSocketHandlers[] = []
  ) {
    this.#harness = harness;
    this.#getWebSockets = getWebSockets;
    this.#getTags = getTags;
    this.#onSubmit = onSubmit;
    this.#senderOf = senderOf;
    this.#mayOpen = mayOpen;
    this.#onAbort = onAbort;
    this.#routes = routes;
  }

  options(): WebSocketsOptions {
    return {
      // 桥不说 Agent 的身份帧，它有自己的 welcome / hello。
      protocol: (_connection, ctx) => !this.#routeOf(ctx.request),
      // 会话连接再按设备打一个标签（Worker 认出设备后放在请求头里），吊销时按它断开。
      getConnectionTags: (_connection, ctx) => {
        const route = this.#routeOf(ctx.request);
        if (route) return [route.tag, ...(route.tags?.(ctx.request) ?? [])];
        const session = sessionFromRequest(ctx.request);
        const device = ctx.request.headers.get(DEVICE_HEADER);
        // 在这里拒：这一步还没接受连接。接受之后、101 回去之前 close，关闭帧发不出去，对面一直挂着。
        if (!this.#mayOpen(session, device)) throw new Error("打不开这条聊天");
        return device ? [sessionTag(session), deviceTag(device)] : [sessionTag(session)];
      },
      handlers: {
        onConnect: (connection, ctx) => {
          const route = this.#routeFor(connection);
          if (route) return route.onConnect(connection, ctx.request);
          return this.#onConnect(connection, ctx);
        },
        onMessage: (connection, message) => {
          const route = this.#routeFor(connection);
          if (route) return typeof message === "string" ? route.onMessage(connection, message) : undefined;
          return this.#onMessage(connection, message);
        },
        onClose: (connection) => {
          const route = this.#routeFor(connection);
          if (route) {
            route.onClose(connection);
            return;
          }
          return this.#unwatch(connection);
        },
        onError: (connection) => {
          const route = this.#routeFor(connection);
          if (route) {
            route.onClose(connection);
            return;
          }
          return this.#unwatch(connection);
        }
      }
    };
  }

  /** 发给看会话的连接。桥和远程桌面的连接不收这些帧。 */
  broadcast(message: ServerMessage): void {
    this.broadcastBy(() => message);
  }

  /** 按设备发各自的那一份，同一个帧不是人人都能看的时候用。 */
  broadcastBy(messageFor: (device: string | null) => ServerMessage): void {
    for (const socket of this.#getWebSockets()) {
      const tags = this.#getTags(socket);
      if (this.#routes.some((route) => tags.includes(route.tag))) continue;
      send(socket, messageFor(deviceOfTags(tags)));
    }
  }

  #routeOf(request: Request): BridgeSocketHandlers | undefined {
    return this.#routes.find((route) => route.isRequest(request));
  }

  #routeFor(connection: Connection): BridgeSocketHandlers | undefined {
    return this.#routes.find((route) => connection.tags.includes(route.tag));
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
    // 两次订阅重叠时（换会话很快、重连），只留最后一次：先回来的旧订阅自己停掉，不然流式文字会出两遍。
    const turn = (this.#watchTurns.get(socket) ?? 0) + 1;
    this.#watchTurns.set(socket, turn);
    await this.#unwatch(socket);
    const stream = await this.#harness.session(session).events();
    const superseded = () => this.#watchTurns.get(socket) !== turn;
    if (!superseded()) await this.#unwatch(socket);
    if (superseded()) {
      await stream.stop();
      return;
    }
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
    const session = sessionOf(connection.tags) ?? MAIN_SESSION;
    try {
      if (!this.#mayOpen(session, deviceOfTags(connection.tags))) throw new Error("打不开这条聊天");
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
        const sender = this.#senderOf(deviceOfTags(connection.tags));
        const sent = sender ? sentInput(message.input, sender) : null;
        const receipt = await handle.submit(sent?.content ?? message.input, {
          ...(sent ? { entry: sent.entry } : {}),
          ...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
          ...(message.operationId ? { operationId: message.operationId } : {})
        });
        this.#onSubmit(session);
        return receipt;
      }
      case "abort": {
        const at = Date.now();
        const result = await handle.abort();
        this.#onAbort(session, at);
        return result;
      }
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
