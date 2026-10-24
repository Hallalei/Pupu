import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { ComputerBridge } from "./bridge/hub";
import {
  BRIDGE_PATH,
  BRIDGE_PING,
  BRIDGE_PONG,
  BRIDGE_TAG,
  isBridgeRequest,
  newDeviceToken,
  tokenHash
} from "./bridge/protocol";
import { ComputerStore } from "./bridge/store";
import { createComputerTools } from "./bridge/tools";
import { handoffMessage } from "./messages";
import type { Project } from "./projects";
import { ProjectStore } from "./projects";
import { renderPrompt } from "./prompt";
import { PiSessionSockets } from "./sockets";
import { createPupuTools } from "./tools";

/**
 * Workers AI 上的模型，不需要额外的 API key。2026-10-17 实测：免费套餐可用、支持工具调用，
 * 响应最快（简单问答约 1.5 秒；Qwen 3.8 约 6 秒，GLM-4.7-Flash 超时）。kimi-k2.7-code 要付费套餐。
 */
const MODEL_ID = "@cf/openai/gpt-oss-120b";

/** v0 只有一个用户，所以只有一个 Pupu 实例。 */
export const PUPU_INSTANCE = "me";

export type PupuState = {
  readonly projects: readonly Project[];
  readonly computers: ReturnType<ComputerBridge["list"]>;
};

/**
 * 一个用户的 Pupu：一个 Durable Object，里面跑 pi-durable。
 * 聊天（主对话）是 pi 的根会话，每个项目各开一个 pi 会话，共用这个对象的 SQLite。
 */
export class Pupu extends DurableObject<Env> {
  readonly ai = createAI({ binding: this.env.AI });
  readonly store = new ProjectStore(this.ctx.storage.sql);
  readonly computers = new ComputerStore(this.ctx.storage.sql);
  readonly bridge = new ComputerBridge({
    directory: this.computers,
    sockets: () => this.ctx.getWebSockets(BRIDGE_TAG),
    now: () => Date.now(),
    heartbeatAt: (socket) => {
      const at = this.ctx.getWebSocketAutoResponseTimestamp(socket as WebSocket);
      return at ? at.getTime() : null;
    }
  });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install({
        name: "pupu",
        sections: [
          {
            key: "pupu",
            tag: false,
            render: (input) =>
              renderPrompt(String(input.conversationId), this.store, this.bridge.list())
          }
        ],
        tools: [
          ...createPupuTools({
            store: this.store,
            createProject: (input) => this.#createProject(input),
            handOff: (project, task, operationId) =>
              this.#handOff(project, task, operationId)
          }),
          ...createComputerTools(this.bridge)
        ]
      });
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          settings: {
            // 每次重试前的等待翻倍：1、2、4、8、16 秒，被限流的模型大约有 30 秒恢复。
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: { model: this.ai(MODEL_ID), thinkingLevel: "low" }
  });
  readonly sockets = new PiSessionSockets(
    this.harness,
    (tag) => this.ctx.getWebSockets(tag),
    (socket) => this.ctx.getTags(socket),
    (session) => this.store.touchSession(session),
    {
      tag: BRIDGE_TAG,
      isRequest: isBridgeRequest,
      onConnect: (socket, request) => this.bridge.onConnect(socket, request),
      onMessage: (socket, message) => this.bridge.onMessage(socket, message),
      onClose: (socket) => this.bridge.onClose(socket)
    }
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** 宿主启动，harness 已经打开 pi 之后。 */
  async onStart(): Promise<void> {
    // 心跳是固定字符串，运行时直接回 pong，不把这个对象叫醒。
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(BRIDGE_PING, BRIDGE_PONG));
    this.bridge.onChange = () => this.sockets.broadcast({ type: "computers_changed" });
    await this.#syncModel();
    await this.sockets.reattach();
  }

  /** `defaults` 只管新会话；换了 MODEL_ID 之后，把已有会话也切过去。 */
  async #syncModel(): Promise<void> {
    if (this.store.meta("model") === MODEL_ID) return;
    for (const { id } of await this.harness.sessions.list()) {
      await this.harness.session(id).setModel(this.ai(MODEL_ID));
    }
    this.store.setMeta("model", MODEL_ID);
  }

  #changed(): void {
    this.sockets.broadcast({ type: "projects_changed" });
  }

  // 下面是给 Worker 调的 RPC。原生 RPC 不经过 fetch，所以要自己先启动 Lifecycle。

  async state(): Promise<PupuState> {
    await this.lifecycle.start();
    return { projects: this.store.listProjects(), computers: this.bridge.list() };
  }

  /** 发一张设备凭据。明文只在这一次返回。 */
  async createComputer(name: string): Promise<{ id: string; name: string; token: string }> {
    await this.lifecycle.start();
    const trimmed = name.trim().slice(0, 80) || "电脑";
    const token = newDeviceToken();
    const row = this.computers.insert({ name: trimmed, tokenHash: await tokenHash(token) });
    this.bridge.onChange();
    return { id: row.id, name: row.name, token };
  }

  async revokeComputer(id: string): Promise<boolean> {
    await this.lifecycle.start();
    const row = this.computers.revoke(id);
    if (!row || row.revokedAt === null) return false;
    this.bridge.disconnect(id, 1008, "凭据已吊销");
    this.bridge.onChange();
    return true;
  }

  /** 本地把一条命令直接送到桥上，不经过模型。线上没有这条路。 */
  async runCommand(input: {
    command: string;
    computerId?: string;
    requestId: string;
    background?: boolean;
  }) {
    await this.lifecycle.start();
    return this.bridge.exec({
      requestId: input.requestId,
      computerId: input.computerId,
      action: {
        kind: "run",
        command: input.command,
        background: input.background === true
      }
    });
  }

  async createProject(input: { name: string; goal: string }): Promise<Project> {
    await this.lifecycle.start();
    return this.#createProject({ ...input, background: "" });
  }

  async #createProject(input: {
    name: string;
    goal: string;
    background: string;
  }): Promise<Project> {
    const name = input.name.trim();
    if (!name) throw new Error("项目名不能为空");
    const session = await this.harness.sessions.create();
    const project = this.store.insertProject({
      session: session.id,
      name,
      goal: input.goal.trim(),
      background: input.background.trim()
    });
    this.#changed();
    return project;
  }

  /** 聊天把一件事交给项目：作为一条消息提交到项目会话，项目自己接着做。 */
  async #handOff(
    project: Project,
    task: string,
    operationId: string
  ): Promise<void> {
    await this.harness.session(project.session).submit(handoffMessage(task), {
      whenBusy: "followUp",
      operationId
    });
    this.store.touchSession(project.session);
    this.#changed();
  }
}

// ---- Worker：鉴权、REST API，以及把 WebSocket 交给 Pupu ----

const TOKEN_COOKIE = "pupu_token";

function isLocal(request: Request): boolean {
  const { hostname } = new URL(request.url);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * 本地开发没设 ACCESS_TOKEN 时直接放行；线上没设口令就一律拒绝，
 * 免得部署后到设口令之前这段时间对所有人开放。
 */
function authorized(request: Request, env: Env): boolean {
  const expected = env.ACCESS_TOKEN;
  if (!expected) return isLocal(request);
  const header = request.headers.get("Authorization");
  if (header === `Bearer ${expected}`) return true;
  const cookie = request.headers.get("Cookie") ?? "";
  return cookie
    .split(";")
    .some((part) => part.trim() === `${TOKEN_COOKIE}=${expected}`);
}

function pupu(env: Env) {
  return env.Pupu.get(env.Pupu.idFromName(PUPU_INSTANCE));
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("请求体不是合法的 JSON");
  }
}

async function handleApi(request: Request, env: Env, url: URL) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/state" && method === "GET") {
    return Response.json(await pupu(env).state());
  }
  if (pathname === "/api/computers" && method === "POST") {
    const body = await readJson<{ name?: string }>(request);
    const computer = await pupu(env).createComputer(String(body.name ?? ""));
    return Response.json(computer);
  }
  const revoke = pathname.match(/^\/api\/computers\/([^/]+)\/revoke$/);
  if (revoke && method === "POST") {
    const ok = await pupu(env).revokeComputer(decodeURIComponent(revoke[1] ?? ""));
    if (!ok) return Response.json({ error: "没有这台电脑" }, { status: 404 });
    return Response.json({ ok: true });
  }
  if (pathname === "/api/computers/run" && method === "POST") {
    if (!isLocal(request)) return new Response("Not found", { status: 404 });
    const body = await readJson<{ command?: string; computerId?: string; background?: boolean }>(request);
    const result = await pupu(env).runCommand({
      command: String(body.command ?? ""),
      computerId: body.computerId,
      background: body.background === true,
      requestId: crypto.randomUUID()
    });
    return Response.json(result);
  }
  if (pathname === "/api/projects" && method === "POST") {
    const body = await readJson<{ name?: string; goal?: string }>(request);
    const project = await pupu(env).createProject({
      name: String(body.name ?? ""),
      goal: String(body.goal ?? "")
    });
    return Response.json(project);
  }
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 第一次访问带上 ?token=，换成 cookie 后跳回首页。
    if (url.pathname === "/api/login") {
      const token = url.searchParams.get("token") ?? "";
      if (!env.ACCESS_TOKEN || token !== env.ACCESS_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
        }
      });
    }

    // 桥用设备凭据，不走网页口令。凭据对不对由 Durable Object 看。
    if (url.pathname === BRIDGE_PATH) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("桥要用 WebSocket 连接。", { status: 426 });
      }
      return pupu(env).fetch(request);
    }

    if (!authorized(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      // 只开放这一个 Pupu 实例。
      if (
        url.pathname.startsWith("/agents/") &&
        !url.pathname.startsWith(`/agents/pupu/${PUPU_INSTANCE}`)
      ) {
        return new Response("Not found", { status: 404 });
      }
      return (
        (await routeAgentRequest(request, env)) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("Pupu request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
