import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createRegistry, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { ApprovalStore, type ApprovalView } from "./bridge/approvals";
import { ComputerGate } from "./bridge/gate";
import { ComputerBridge } from "./bridge/hub";
import { isComputerPolicy } from "./bridge/policy";
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
import {
  browserName,
  DEVICE_HEADER,
  DeviceStore,
  deviceTag,
  deviceView,
  newPairingCode,
  normalizePairingCode,
  PAIRING_TTL_MS,
  SOURCE_LIMIT,
  sourceOf,
  TOKEN_BUCKET,
  TOKEN_LIMIT,
  type DeviceKind,
  type DeviceView
} from "./devices";
import { handoffMessage } from "./messages";
import { REVOKED_CLOSE_CODE } from "./protocol";
import type { Project } from "./projects";
import { ProjectStore } from "./projects";
import { renderPrompt } from "./prompt";
import { PiSessionSockets } from "./sockets";
import { createPupuTools } from "./tools";

/**
 * DeepSeek 官方接口的 V4.1 Flash：支持工具调用，也能看截图。费用从 DeepSeek 开放平台的充值余额里扣，
 * key 用 `wrangler secret put DEEPSEEK_API_KEY` 设置。之前用的 Workers AI gpt-oss-120b 只认文字。
 */
const MODEL = { provider: "deepseek", id: "deepseek-flash" } as const;
/** 记在 meta 里，用来判断已有会话要不要切模型。 */
const MODEL_KEY = `${MODEL.provider}/${MODEL.id}`;

/** v0 只有一个用户，所以只有一个 Pupu 实例。 */
export const PUPU_INSTANCE = "me";

export type PupuState = {
  readonly projects: readonly Project[];
  readonly computers: ReturnType<ComputerBridge["list"]>;
  /** 等用户批准的电脑动作，先来的在前。 */
  readonly approvals: readonly ApprovalView[];
  /** 配对过的手机和浏览器，新连上的在前。 */
  readonly devices: readonly DeviceView[];
};

/** 配对的结果。失败时带上给 Worker 回的状态码。 */
export type PairResult =
  | { readonly ok: true; readonly id: string; readonly name: string; readonly token: string }
  | { readonly ok: false; readonly status: 400 | 401 | 429; readonly error: string };

/**
 * 一个用户的 Pupu：一个 Durable Object，里面跑 pi-durable。
 * 聊天（主对话）是 pi 的根会话，每个项目各开一个 pi 会话，共用这个对象的 SQLite。
 */
export class Pupu extends DurableObject<Env> {
  readonly store = new ProjectStore(this.ctx.storage.sql);
  readonly computers = new ComputerStore(this.ctx.storage.sql);
  readonly devices = new DeviceStore(this.ctx.storage.sql);
  readonly bridge = new ComputerBridge({
    directory: this.computers,
    sockets: () => this.ctx.getWebSockets(BRIDGE_TAG),
    now: () => Date.now(),
    heartbeatAt: (socket) => {
      const at = this.ctx.getWebSocketAutoResponseTimestamp(socket as WebSocket);
      return at ? at.getTime() : null;
    }
  });
  readonly approvals = new ApprovalStore(this.ctx.storage.sql);
  readonly gate = new ComputerGate({
    computers: () => this.bridge.list(),
    directory: this.computers,
    approvals: this.approvals,
    now: () => Date.now(),
    onChange: (computerIds) => this.#approvalsChanged(computerIds)
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
        ],
        hooks: [
          hook(ToolTask, {
            beforeTool: (call, _api, context) => this.gate.beforeTool(call, context.abortSignal)
          })
        ]
      });
      // Workers 里没有本机环境变量，key 只从 secret 里拿。
      const models = createModels({
        authContext: {
          env: async (name) => (name === "DEEPSEEK_API_KEY" ? this.env.DEEPSEEK_API_KEY : undefined),
          fileExists: async () => false
        }
      });
      models.setProvider(deepseekProvider());
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
    defaults: { model: MODEL, thinkingLevel: "low" }
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 在构造时就接上，DO 重启后 pi 恢复的调用跑到桥上之前，审批已经能查了。
    this.bridge.approvedFor = (input) => this.gate.approved(input);
    this.bridge.onReady = (computerId) => this.bridge.sendStatus(computerId, this.gate.statusFor(computerId));
    this.bridge.onTakeback = (computerId) => this.gate.takeback(computerId);
  }

  /** 宿主启动，harness 已经打开 pi 之后。 */
  async onStart(): Promise<void> {
    // 心跳是固定字符串，运行时直接回 pong，不把这个对象叫醒。
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(BRIDGE_PING, BRIDGE_PONG));
    this.bridge.onChange = () => this.sockets.broadcast({ type: "computers_changed" });
    await this.#syncModel();
    await this.sockets.reattach();
  }

  /** `defaults` 只管新会话；换了 MODEL 之后，把已有会话也切过去。 */
  async #syncModel(): Promise<void> {
    if (this.store.meta("model") === MODEL_KEY) return;
    for (const { id } of await this.harness.sessions.list()) {
      await this.harness.session(id).setModel(MODEL);
    }
    this.store.setMeta("model", MODEL_KEY);
  }

  #changed(): void {
    this.sockets.broadcast({ type: "projects_changed" });
  }

  /** 审批或屏幕授权变了：网页重新拉状态，菜单栏换显示。 */
  #approvalsChanged(computerIds: readonly string[]): void {
    this.sockets.broadcast({ type: "approvals_changed" });
    for (const id of computerIds) this.bridge.sendStatus(id, this.gate.statusFor(id));
  }

  #devicesChanged(): void {
    this.sockets.broadcast({ type: "devices_changed" });
  }

  // 下面是给 Worker 调的 RPC。原生 RPC 不经过 fetch，所以要自己先启动 Lifecycle。

  /** `current` 是发请求的设备，列表里给它打个标记。 */
  async state(current: string | null = null): Promise<PupuState> {
    await this.lifecycle.start();
    return {
      projects: this.store.listProjects(),
      computers: this.bridge.list(),
      approvals: this.gate.pending(),
      devices: this.devices.list().map((row) => deviceView(row, current))
    };
  }

  /** Worker 每个请求都先来这里认设备，认出来返回设备 id。只碰 SQLite，不用把 pi 拉起来。 */
  async authenticateDevice(token: string): Promise<string | null> {
    const row = this.devices.byTokenHash(await tokenHash(token));
    if (!row || row.revokedAt !== null) return null;
    this.devices.touch(row, Date.now());
    return row.id;
  }

  /** 已经连上的设备要一个配对码，给新设备用。明文只在这一次返回。 */
  async createPairingCode(): Promise<{ code: string; expiresAt: number }> {
    const now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS;
    for (;;) {
      const code = newPairingCode();
      if (this.devices.addCode(await tokenHash(code.replace("-", "")), expiresAt, now)) {
        return { code, expiresAt };
      }
    }
  }

  /**
   * 新设备拿配对码换自己的凭据，电脑换桥的凭据。访问口令也能换，当救急钥匙。
   * 同一个来源错多了先停 10 分钟；访问口令另记一桶，换着地址也没法一个个试。
   * `source` 是 Worker 按 CF-Connecting-IP 算的来源。
   * `trusted` 是本机开发、又没设访问口令：什么都不带也放行。
   */
  async pair(input: {
    kind: DeviceKind | "computer";
    name: string;
    code?: string;
    accessToken?: string;
    source: string;
    trusted: boolean;
  }): Promise<PairResult> {
    if (!input.code && !input.accessToken) {
      return input.trusted ? this.#issue(input) : { ok: false, status: 400, error: "要填配对码。" };
    }
    const code = input.code ? normalizePairingCode(input.code) : null;
    if (input.code && !code) {
      return { ok: false, status: 400, error: "配对码是 8 位字母和数字，比如 7K3M-Q9TX。" };
    }
    const now = Date.now();
    const source = `source:${input.source}`;
    if (this.devices.failures(source, now) >= SOURCE_LIMIT) {
      return { ok: false, status: 429, error: "这里试错的次数太多了，过 10 分钟再试。" };
    }
    if (!code && this.devices.failures(TOKEN_BUCKET, now) >= TOKEN_LIMIT) {
      return { ok: false, status: 429, error: "访问口令试错的次数太多了。过 10 分钟再试，或者用配对码。" };
    }
    const attempt = this.devices.addAttempt(code ? [source] : [source, TOKEN_BUCKET], now);
    const matched = code
      ? this.devices.takeCode(await tokenHash(code), now)
      : await this.#isAccessToken(input.accessToken ?? "");
    if (!matched) {
      return { ok: false, status: 401, error: code ? "配对码不对，或者已经用过、过期了。" : "访问口令不对。" };
    }
    this.devices.forgive(attempt);
    return this.#issue(input);
  }

  async #isAccessToken(token: string): Promise<boolean> {
    const expected = this.env.ACCESS_TOKEN;
    if (!expected) return false;
    return (await tokenHash(token)) === (await tokenHash(expected));
  }

  /** 配对过了关：电脑发桥的凭据，手机和浏览器发设备凭据。 */
  async #issue(input: { kind: DeviceKind | "computer"; name: string }): Promise<PairResult> {
    if (input.kind === "computer") {
      return { ok: true, ...(await this.createComputer(input.name)) };
    }
    const token = newDeviceToken();
    const row = this.devices.insert({
      name: input.name.trim().slice(0, 80) || (input.kind === "phone" ? "手机" : "浏览器"),
      kind: input.kind,
      tokenHash: await tokenHash(token)
    });
    this.#devicesChanged();
    return { ok: true, id: row.id, name: row.name, token };
  }

  /** 吊销手机或浏览器，它开着的连接马上断开。 */
  async revokeDevice(id: string): Promise<boolean> {
    const row = this.devices.revoke(id);
    if (!row || row.revokedAt === null) return false;
    for (const socket of this.ctx.getWebSockets(deviceTag(id))) {
      try {
        socket.close(REVOKED_CLOSE_CODE, "设备已吊销");
      } catch {
        // 已经断了。
      }
    }
    this.#devicesChanged();
    return true;
  }

  /** 用户在手机上点了允许或拒绝。 */
  async decideApproval(id: string, decision: "allow" | "deny"): Promise<"ok" | "missing" | "settled"> {
    // 等着的那次调用可能在 DO 被回收时断了。先把 pi 拉起来，它会重跑那次调用，读到这里的决定。
    await this.lifecycle.start();
    return this.gate.decide(id, decision);
  }

  async setComputerPolicy(id: string, policy: string): Promise<boolean> {
    await this.lifecycle.start();
    if (!isComputerPolicy(policy)) throw new Error("没有这个分级");
    return this.gate.setPolicy(id, policy);
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

  /** 桥拿自己的凭据注销自己，不用访问口令。 */
  async revokeComputerByToken(token: string): Promise<boolean> {
    const row = this.computers.byTokenHash(await tokenHash(token));
    if (!row || row.revokedAt !== null) return false;
    return this.revokeComputer(row.id);
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

/** 手机和桥把凭据放在 Authorization 头里，浏览器放在 cookie 里。 */
function credentialOf(request: Request): { token: string; cookie: boolean } | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return { token, cookie: false };
  }
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === TOKEN_COOKIE && value) return { token: value, cookie: true };
  }
  return null;
}

/** 发请求的设备。`device` 是 null：本机开发、没设访问口令、什么凭据都没带。 */
type Caller = { readonly device: string | null };

/**
 * 带了凭据就一定要对上一台没吊销的设备，本机也一样，吊销马上能看到效果。
 * 什么都不带，只有本机开发又没设 ACCESS_TOKEN 时放行；线上没设口令就一律拒绝，
 * 免得部署后到设口令之前这段时间对所有人开放。
 */
async function authenticate(request: Request, env: Env): Promise<Caller | null> {
  const credential = credentialOf(request);
  if (credential) {
    // cookie 是浏览器自己带上的：别的网站发起的请求和 WebSocket（Origin 对不上）不认。
    const origin = request.headers.get("Origin");
    if (credential.cookie && origin !== null && origin !== new URL(request.url).origin) return null;
    const device = await pupu(env).authenticateDevice(credential.token);
    return device ? { device } : null;
  }
  return isLocal(request) && !env.ACCESS_TOKEN ? { device: null } : null;
}

/** 浏览器的凭据只放进 HttpOnly cookie，页面上的脚本拿不到。`token` 是 null 时清掉。 */
function deviceCookie(url: URL, token: string | null): string {
  // 本机开发是 http，Safari 不收带 Secure 的 cookie。
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const value = token ? `${token}; Max-Age=31536000` : "; Max-Age=0";
  return `${TOKEN_COOKIE}=${value}; Path=/; HttpOnly${secure}; SameSite=Lax`;
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

/**
 * 新设备换凭据，不用先登录。手机和电脑在响应里拿到凭据，自己存好；
 * 浏览器拿到的是 cookie。
 */
async function handlePair(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await readJson<{ kind?: unknown; name?: unknown; code?: unknown; accessToken?: unknown }>(request);
  const kind = body.kind;
  if (kind !== "phone" && kind !== "browser" && kind !== "computer") {
    return Response.json({ error: "kind 只能是 phone、browser 或 computer" }, { status: 400 });
  }
  const result = await pupu(env).pair({
    kind,
    name: kind === "browser" ? browserName(request.headers.get("User-Agent")) : String(body.name ?? ""),
    code: typeof body.code === "string" ? body.code : undefined,
    accessToken: typeof body.accessToken === "string" ? body.accessToken : undefined,
    // 来源只认 Cloudflare 填的这个头，客户端自己写的 X-Forwarded-For 不算。
    source: sourceOf(request.headers.get("CF-Connecting-IP")),
    trusted: isLocal(request) && !env.ACCESS_TOKEN
  });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  if (kind !== "browser") return Response.json({ id: result.id, name: result.name, token: result.token });
  return Response.json(
    { id: result.id, name: result.name },
    { headers: { "Set-Cookie": deviceCookie(url, result.token) } }
  );
}

async function handleApi(request: Request, env: Env, url: URL, caller: Caller) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/state" && method === "GET") {
    return Response.json(await pupu(env).state(caller.device));
  }
  if (pathname === "/api/pairing-codes" && method === "POST") {
    return Response.json(await pupu(env).createPairingCode());
  }
  const device = pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/);
  if (device && method === "POST") {
    const id = decodeURIComponent(device[1] ?? "");
    const ok = await pupu(env).revokeDevice(id);
    if (!ok) return Response.json({ error: "没有这台设备" }, { status: 404 });
    // 吊销的是自己：浏览器顺手清掉 cookie。
    const headers: HeadersInit = id === caller.device ? { "Set-Cookie": deviceCookie(url, null) } : {};
    return Response.json({ ok: true }, { headers });
  }
  const policy = pathname.match(/^\/api\/computers\/([^/]+)\/policy$/);
  if (policy && method === "POST") {
    const body = await readJson<{ policy?: string }>(request);
    const ok = await pupu(env).setComputerPolicy(decodeURIComponent(policy[1] ?? ""), String(body.policy ?? ""));
    if (!ok) return Response.json({ error: "没有这台电脑" }, { status: 404 });
    return Response.json({ ok: true });
  }
  const approval = pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (approval && method === "POST") {
    const body = await readJson<{ decision?: string }>(request);
    if (body.decision !== "allow" && body.decision !== "deny") {
      return Response.json({ error: "decision 只能是 allow 或 deny" }, { status: 400 });
    }
    const result = await pupu(env).decideApproval(decodeURIComponent(approval[1] ?? ""), body.decision);
    if (result === "missing") return Response.json({ error: "没有这条请示" }, { status: 404 });
    if (result === "settled") return Response.json({ error: "这条请示已经处理过或过期了" }, { status: 409 });
    return Response.json({ ok: true });
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

    // 桥用设备凭据，不走网页口令。凭据对不对由 Durable Object 看。
    if (url.pathname === BRIDGE_PATH) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("桥要用 WebSocket 连接。", { status: 426 });
      }
      return pupu(env).fetch(request);
    }

    try {
      // 这三条在设备鉴权之前：配对时还没有凭据，桥注销用的是桥自己的凭据。
      if (url.pathname === "/api/pair" && request.method === "POST") {
        return await handlePair(request, env, url);
      }
      // 老的登录链接 `?token=访问口令`。口令不该出现在地址里（会进历史记录和日志），
      // 不再认，跳到首页的登录页去填。
      if (url.pathname === "/api/login") {
        return Response.redirect(new URL("/", url).toString(), 302);
      }
      if (url.pathname === "/api/bridge/revoke" && request.method === "POST") {
        const token = credentialOf(request)?.token;
        if (!token || !(await pupu(env).revokeComputerByToken(token))) {
          return Response.json({ error: "凭据无效，或者已经吊销了" }, { status: 401 });
        }
        return Response.json({ ok: true });
      }

      const caller = await authenticate(request, env);
      if (!caller) return new Response("Unauthorized", { status: 401 });

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url, caller);
      }
      // 只开放这一个 Pupu 实例。
      if (
        url.pathname.startsWith("/agents/") &&
        !url.pathname.startsWith(`/agents/pupu/${PUPU_INSTANCE}`)
      ) {
        return new Response("Not found", { status: 404 });
      }
      // 告诉 Pupu 这条连接是哪台设备的，吊销时按设备断开。客户端自己带的这个头不算数。
      const forwarded = new Request(request);
      forwarded.headers.delete(DEVICE_HEADER);
      if (caller.device) forwarded.headers.set(DEVICE_HEADER, caller.device);
      return (
        (await routeAgentRequest(forwarded, env)) ??
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
