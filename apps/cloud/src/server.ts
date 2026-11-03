import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { createRegistry, GenerationTask, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { googleClientFrom, randomToken } from "./auth/oidc";
import { AUTH_PREFIX, handleAuth, type RedeemResult, type SignInCredential, type SignInGrant } from "./auth/routes";
import {
  redeemStep,
  signInApprovalRow,
  signInApprovalView,
  SignInStore,
  type SignInFlow
} from "./auth/sign-ins";
import { CallSessions, computerActivity, type ComputerActivity } from "./bridge/activity";
import { ApprovalStore, type ApprovalRow, type ApprovalView } from "./bridge/approvals";
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
  DEFAULT_DEVICE_NAMES,
  DEVICE_HEADER,
  DeviceStore,
  deviceTag,
  deviceView,
  mayChangePolicy,
  mayDecide,
  mayPair,
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
import {
  actorOf,
  emailKey,
  isEmail,
  mayInvite,
  mayRemoveMember,
  mayRevoke,
  MemberStore,
  memberView,
  type Actor,
  type MemberRow,
  type MemberView
} from "./members";
import { handoffMessage } from "./messages";
import { REVOKED_CLOSE_CODE } from "./protocol";
import type { Project } from "./projects";
import { ProjectStore } from "./projects";
import { renderPrompt } from "./prompt";
import { Apns, apnsKeyFrom, type ApnsEnv } from "./push/apns";
import { ApprovalPusher } from "./push/approvals";
import { LivePusher, liveDue, type LiveInput } from "./push/live";
import { PushStore, type PushTokenType } from "./push/store";
import { PiSessionSockets } from "./sockets";
import { createPupuTools } from "./tools";

/**
 * DeepSeek 官方接口的 V4.1 Flash：支持工具调用，也能看截图。费用从 DeepSeek 开放平台的充值余额里扣，
 * key 用 `wrangler secret put DEEPSEEK_API_KEY` 设置。之前用的 Workers AI gpt-oss-120b 只认文字。
 */
const MODEL = { provider: "deepseek", id: "deepseek-flash" } as const;
/** 记在 meta 里，用来判断已有会话要不要切模型。 */
const MODEL_KEY = `${MODEL.provider}/${MODEL.id}`;
/** 灵动岛到点重新看一眼：命令跑满 30 秒、屏幕授权到期。 */
const LIVE_JOB = "live-activity";

/** v0 只有一个用户，所以只有一个 Pupu 实例。 */
export const PUPU_INSTANCE = "me";

export type PupuState = {
  readonly projects: readonly Project[];
  readonly computers: ReturnType<ComputerBridge["list"]>;
  /** 等用户批准的电脑动作，先来的在前。 */
  readonly approvals: readonly ApprovalView[];
  /** 配对过的手机和浏览器，新连上的在前。 */
  readonly devices: readonly DeviceView[];
  /** 每台电脑在做什么，顺序和 `computers` 一样。主页的「正在做」用。 */
  readonly activity: readonly ComputerActivity[];
  /** 成员名单，创建者在前。设备的 `memberId`、电脑的 `ownerId` 对的是这里的 id。 */
  readonly members: readonly MemberView[];
};

/** 配对的结果。失败时带上给 Worker 回的状态码。 */
export type PairResult =
  | { readonly ok: true; readonly id: string; readonly name: string; readonly token: string }
  | { readonly ok: false; readonly status: 400 | 401 | 403 | 429; readonly error: string };

/**
 * 一个用户的 Pupu：一个 Durable Object，里面跑 pi-durable。
 * 聊天（主对话）是 pi 的根会话，每个项目各开一个 pi 会话，共用这个对象的 SQLite。
 */
export class Pupu extends DurableObject<Env> {
  readonly store = new ProjectStore(this.ctx.storage.sql);
  readonly computers = new ComputerStore(this.ctx.storage.sql);
  readonly devices = new DeviceStore(this.ctx.storage.sql);
  readonly members = new MemberStore(this.ctx.storage.sql);
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
  readonly signIns = new SignInStore(this.ctx.storage.sql);
  readonly push = new PushStore(this.ctx.storage.sql);
  /** 没配 APNs 密钥是 null。第一次要用时才建。 */
  #apns: Apns | null | undefined;
  readonly pusher = new ApprovalPusher({
    // 新手机登录等批的那几条也一起推：手机上和电脑审批一样长按就能批。
    approvals: {
      byId: (id) => this.approvals.byId(id) ?? this.#signInApproval(id),
      pending: (now) =>
        [...this.approvals.pending(now), ...this.signIns.pending(now).map(signInApprovalRow)].sort(
          (a, b) => a.createdAt - b.createdAt
        )
    },
    store: this.push,
    // 电脑的审批只推给这台电脑主人的手机；新手机登录的等批推给所有手机（谁的手机都能批，见 sign-ins.ts）。
    audience: (row) => {
      const owner = row.kind === "sign_in" ? null : this.#ownerOf(row.computerId);
      if (owner === null) return () => true;
      const phones = new Set(this.devices.ofMember(owner).map((device) => device.id));
      return (deviceId) => phones.has(deviceId);
    },
    apns: () => this.#apnsClient(),
    now: () => Date.now(),
    log: (message) => console.warn(message)
  });
  readonly live = new LivePusher({
    store: this.push,
    apns: () => this.#apnsClient(),
    state: { get: () => this.store.meta("live.state"), set: (value) => this.store.setMeta("live.state", value) },
    now: () => Date.now(),
    log: (message) => console.warn(message)
  });
  /** 灵动岛下次要重新看一眼的时间，排在 Lifecycle 的任务队列里。 */
  #liveDue: number | null = null;
  readonly gate = new ComputerGate({
    computers: () => this.bridge.list(),
    directory: this.computers,
    approvals: this.approvals,
    now: () => Date.now(),
    onChange: (computerIds) => this.#approvalsChanged(computerIds)
  });
  /** 电脑上的调用是哪个会话发的，「正在做」靠它说出是哪个项目。 */
  readonly #callSessions = new CallSessions();
  /** 上一次发出去的 activity，没变就不再发。 */
  #sentActivity = "";
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
            beforeTool: (call, api, context) => {
              this.#callSessions.remember(call.id, String(api.conversationId));
              return this.gate.beforeTool(call, context.abortSignal);
            }
          }),
          hook(GenerationTask, {
            // 项目里回完一轮，记下最新进展，主页和项目列表上显示。
            onYield: (answer, api) => {
              const reply = answer.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n");
              if (this.store.recordReply(String(api.conversationId), reply)) this.#changed();
              return undefined;
            }
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
    this.bridge.onChange = () => {
      this.sockets.broadcast({ type: "computers_changed" });
      this.#activityChanged();
    };
    this.bridge.onActivity = () => this.#activityChanged();
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

  /** 审批或屏幕授权变了：网页重新拉状态，菜单栏换显示，手机上的通知跟着推或替换。 */
  #approvalsChanged(computerIds: readonly string[]): void {
    this.sockets.broadcast({ type: "approvals_changed" });
    for (const id of computerIds) this.bridge.sendStatus(id, this.gate.statusFor(id));
    this.#activityChanged();
    this.ctx.waitUntil(this.pusher.sync().catch((error) => console.warn("审批推送失败", error)));
  }

  #activity(): ComputerActivity[] {
    return computerActivity({
      computers: this.bridge.list(),
      running: this.bridge.running(),
      pending: this.approvals.pending(Date.now()),
      projectOf: (callId) => {
        const session = this.#callSessions.of(callId);
        const project = session ? this.store.projectBySession(session) : undefined;
        return project ? { id: project.id, name: project.name } : null;
      }
    });
  }

  #activityChanged(): void {
    this.#liveChanged();
    const activity = this.#activity();
    const sent = JSON.stringify(activity);
    if (sent === this.#sentActivity) return;
    this.#sentActivity = sent;
    this.sockets.broadcast({ type: "activity", activity });
  }

  /** 灵动岛：对一遍账，再排好下次该看的时候。 */
  #liveChanged(): void {
    const now = Date.now();
    const input: LiveInput = {
      computers: this.bridge.list(),
      running: this.bridge.running(),
      pending: this.approvals.pending(now),
      screenUntil: (id) => this.computers.list().find((row) => row.id === id)?.screenUntil ?? null
    };
    this.ctx.waitUntil(this.live.sync(input).catch((error) => console.warn("实时活动推送失败", error)));
    const due = liveDue(input, now);
    if (due === this.#liveDue) return;
    this.#liveDue = due;
    const { jobs } = this.lifecycle;
    const scheduled = due === null ? jobs.cancel(LIVE_JOB) : jobs.push({ id: LIVE_JOB, fn: LIVE_JOB, time: due + 500 });
    this.ctx.waitUntil(scheduled.then(() => undefined, (error) => console.warn("灵动岛的定时排不上", error)));
  }

  /** Lifecycle 的任务队列到点了。 */
  onJob({ job }: LifecycleJobContext): void {
    if (job.fn !== LIVE_JOB) return;
    this.#liveDue = null;
    this.#activityChanged();
  }

  #apnsClient(): Apns | null {
    if (this.#apns === undefined) {
      const key = apnsKeyFrom(this.env);
      this.#apns = key
        ? new Apns({
            key,
            cache: {
              get: () => this.store.meta("apns.jwt"),
              set: (value) => this.store.setMeta("apns.jwt", value)
            },
            now: () => Date.now()
          })
        : null;
    }
    return this.#apns;
  }

  #devicesChanged(): void {
    this.sockets.broadcast({ type: "devices_changed" });
  }

  #signInApproval(id: string): ApprovalRow | undefined {
    const row = this.signIns.byId(id);
    return row ? signInApprovalRow(row) : undefined;
  }

  /** 设置里的设备列表，带上是谁的。 */
  #deviceViews(current: string | null): DeviceView[] {
    const members = new Map(this.members.list().map((member) => [member.id, member.email]));
    return this.devices.list().map((row) => deviceView(row, current, members));
  }

  /**
   * 发请求的是谁，见 members.ts 的 `Actor`。null 是本机开发没带凭据；undefined 是查不到（刚吊销）。
   * 还没有创建者时，不属于谁的设备按创建者算。
   */
  #actor(device: string | null): Actor | null | undefined {
    if (device === null) return null;
    return actorOf(
      this.devices.list().find((row) => row.id === device),
      this.members.list()
    );
  }

  /** 电脑的主人。没有这台电脑或者还没主人是 null。 */
  #ownerOf(computerId: string): string | null {
    return this.computers.list().find((row) => row.id === computerId)?.ownerId ?? null;
  }

  /** 访问口令和本机开发配的设备算创建者的；还没有创建者时先不属于谁。 */
  #fallbackOwner(): string | null {
    return this.members.creator()?.id ?? null;
  }

  /**
   * Google 认过的邮箱能不能进：在名单上就记下第一次登录；还没有创建者、邮箱又是 `CREATOR_EMAIL`，
   * 他就是创建者，之前连上的设备和电脑都归他。都不是返回 undefined。
   */
  #admit(email: string, now: number): MemberRow | undefined {
    const member = this.members.byEmail(email);
    if (member) {
      this.members.markJoined(member.id, now);
      return member;
    }
    const creatorEmail = this.env.CREATOR_EMAIL?.trim();
    if (this.members.creator() || !creatorEmail || emailKey(creatorEmail) !== emailKey(email)) return undefined;
    const creator = this.members.addCreator(email, now);
    if (!creator) return undefined;
    this.devices.claimUnowned(creator.id);
    this.computers.claimUnowned(creator.id);
    this.bridge.onChange();
    this.#devicesChanged();
    return creator;
  }

  // 下面是给 Worker 调的 RPC。原生 RPC 不经过 fetch，所以要自己先启动 Lifecycle。

  /** `current` 是发请求的设备，列表里给它打个标记。 */
  async state(current: string | null = null): Promise<PupuState> {
    await this.lifecycle.start();
    return {
      projects: this.store.listProjects(),
      computers: this.bridge.list(),
      approvals: [...this.gate.pending(), ...this.signIns.pending(Date.now()).map(signInApprovalView)],
      devices: this.#deviceViews(current),
      activity: this.#activity(),
      members: this.members.list().map((row) => memberView(row, this.#actor(current)?.memberId ?? null))
    };
  }

  /** Worker 每个请求都先来这里认设备，认出来返回设备 id。只碰 SQLite，不用把 pi 拉起来。 */
  async authenticateDevice(token: string): Promise<string | null> {
    const row = this.devices.byTokenHash(await tokenHash(token));
    if (!row || row.revokedAt !== null) return null;
    this.devices.touch(row, Date.now());
    return row.id;
  }

  /**
   * 已经连上的设备要一个配对码，给新设备用。明文只在这一次返回。
   * `device` 是要码的设备，记下它是不是手机（见 `mayPair`）、属于谁；本机开发不带设备，当手机算。
   */
  async createPairingCode(device: string | null = null): Promise<{ code: string; expiresAt: number }> {
    const row = device === null ? undefined : this.devices.list().find((each) => each.id === device);
    const from = { byPhone: device === null || row?.kind === "phone", memberId: row?.memberId ?? null };
    const now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS;
    for (;;) {
      const code = newPairingCode();
      if (this.devices.addCode(await tokenHash(code.replace("-", "")), expiresAt, now, from)) {
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
      return input.trusted
        ? this.#issue({ ...input, memberId: this.#fallbackOwner() })
        : { ok: false, status: 400, error: "要填配对码。" };
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
    const taken = code ? this.devices.takeCode(await tokenHash(code), now) : undefined;
    const matched = code ? taken !== undefined : await this.#isAccessToken(input.accessToken ?? "");
    if (!matched) {
      return { ok: false, status: 401, error: code ? "配对码不对，或者已经用过、过期了。" : "访问口令不对。" };
    }
    this.devices.forgive(attempt);
    if (taken && !mayPair(input.kind, taken.byPhone, this.devices.hadPhone())) {
      return {
        ok: false,
        status: 403,
        error: "新手机要用已经连上的手机生成的配对码：在那台手机的设置里点「生成配对码」。"
      };
    }
    // 配对码换的设备和电脑归生成码的那个人；访问口令是创建者的救急钥匙，换的算创建者的。
    return this.#issue({ ...input, memberId: taken ? taken.memberId : this.#fallbackOwner() });
  }

  async #isAccessToken(token: string): Promise<boolean> {
    const expected = this.env.ACCESS_TOKEN;
    if (!expected) return false;
    return (await tokenHash(token)) === (await tokenHash(expected));
  }

  // ---- 用 Google 登录（Worker 那一半在 src/auth/routes.ts）----

  async addSignInFlow(flow: SignInFlow): Promise<void> {
    this.signIns.addFlow(flow);
  }

  async takeSignInFlow(state: string): Promise<SignInFlow | null> {
    return this.signIns.takeFlow(state, Date.now()) ?? null;
  }

  /**
   * Google 认过是成员了：浏览器直接发凭据，种进 cookie；App 拿一个一次性的码，带着自己的 verifier 来换。
   * 发出去的设备凭据都挂在这个成员下面。
   */
  async finishSignIn(input: { flow: SignInFlow; email: string; name: string }): Promise<SignInGrant> {
    const { flow } = input;
    const member = this.#admit(input.email, Date.now());
    if (!member) {
      return {
        kind: "refused",
        error: this.members.creator()
          ? "这个 Google 账号不在这个 Pupu 的成员名单上。请创建者在手机 App 的设置里邀请你。"
          : "这个 Pupu 还没有创建者，先要用部署时填的创建者账号登录一次。"
      };
    }
    if (flow.client === "browser") {
      return { kind: "cookie", token: (await this.#credential("browser", input.name, member.id)).token };
    }
    if (!flow.challenge) throw new Error("App 的登录缺少 challenge");
    const code = randomToken();
    this.signIns.add({
      codeHash: await tokenHash(code),
      client: flow.client,
      email: input.email,
      challenge: flow.challenge,
      now: Date.now()
    });
    return { kind: "code", code };
  }

  /**
   * App 拿码换凭据，规则见 `redeemStep`。新手机要已有手机点允许时，第一次来就开始等、推通知，
   * 之后每隔几秒再来问，等到允许才发凭据。码不对按来源记失败次数，和配对码共用一个上限。
   */
  async redeemSignIn(input: {
    codeHash: string;
    challenge: string;
    name: string;
    place: string;
    source: string;
    computer: boolean;
  }): Promise<RedeemResult> {
    const now = Date.now();
    const bucket = `source:${input.source}`;
    if (this.devices.failures(bucket, now) >= SOURCE_LIMIT) {
      return { status: "refused", code: 429, error: "这里试错的次数太多了，过 10 分钟再试。" };
    }
    const row = this.signIns.byCode(input.codeHash);
    const step = redeemStep(row, {
      now,
      verifierMatches: row?.challenge === input.challenge,
      hadPhone: this.devices.hadPhone()
    });
    if (step.action === "refuse") {
      if (!row || step.burn) this.devices.addAttempt([bucket], now);
      if (row && step.burn) this.signIns.burn(row.id);
      // 等批的那条没了（作废或过期）：手机上带按钮的通知换成「已处理」。
      if (row?.status === "waiting") this.#approvalsChanged([]);
      return { status: "refused", code: step.status, error: step.error };
    }
    if (!row) throw new Error("登录记录不见了");
    const name = input.name.trim().slice(0, 80) || DEFAULT_DEVICE_NAMES[row.client];
    if (step.action === "confirm") {
      this.signIns.confirm(row.id, { name, place: input.place, now });
      this.#approvalsChanged([]);
      return { status: "waiting", expiresAt: this.signIns.byId(row.id)?.expiresAt ?? now };
    }
    if (step.action === "waiting") return { status: "waiting", expiresAt: row.expiresAt };
    if (!this.signIns.use(row.id)) {
      return { status: "refused", code: 400, error: "这次登录已经用过了。重新登录一次。" };
    }
    // 从登录到来换凭据这几分钟里被移除了，就不发。
    const member = this.members.byEmail(row.email);
    if (!member) return { status: "refused", code: 403, error: "你已经不在这个 Pupu 的成员名单上了。" };
    if (row.client === "phone") {
      return { status: "ok", device: await this.#credential("phone", row.name ?? name, member.id), computer: null };
    }
    // 用谁的账号登录电脑 App，这台电脑就是谁的。
    const device = await this.#credential("desktop", name, member.id);
    const computer = input.computer ? await this.#credential("computer", name, member.id) : null;
    return { status: "ok", device, computer };
  }

  async #credential(kind: DeviceKind | "computer", name: string, memberId: string | null): Promise<SignInCredential> {
    const result = await this.#issue({ kind, name, memberId });
    if (!result.ok) throw new Error(result.error);
    return { id: result.id, name: result.name, token: result.token };
  }

  /** 配对过了关：电脑发桥的凭据，手机和浏览器发设备凭据。 */
  async #issue(input: { kind: DeviceKind | "computer"; name: string; memberId: string | null }): Promise<PairResult> {
    if (input.kind === "computer") {
      return { ok: true, ...(await this.createComputer(input.name, input.memberId)) };
    }
    const token = newDeviceToken();
    const row = this.devices.insert({
      name: input.name.trim().slice(0, 80) || DEFAULT_DEVICE_NAMES[input.kind],
      kind: input.kind,
      memberId: input.memberId,
      tokenHash: await tokenHash(token)
    });
    this.#devicesChanged();
    return { ok: true, id: row.id, name: row.name, token };
  }

  /**
   * 吊销手机或浏览器，它开着的连接马上断开，推送 token 一起删掉。
   * `device` 是发请求的设备：自己名下的自己能吊销，创建者能吊销所有人的（`mayRevoke`）。
   */
  async revokeDevice(id: string, device: string | null = null): Promise<"ok" | "missing" | "forbidden"> {
    const target = this.devices.list().find((row) => row.id === id);
    if (!target) return "missing";
    if (!mayRevoke(this.#actor(device), target.memberId)) return "forbidden";
    return this.#revokeDevice(id) ? "ok" : "missing";
  }

  #revokeDevice(id: string): boolean {
    const row = this.devices.revoke(id);
    if (!row || row.revokedAt === null) return false;
    this.push.removeDevice(id);
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

  /**
   * 用户在手机上点了允许或拒绝。`device` 是点的那台设备；「允许」只认这台电脑主人的手机，
   * 新手机登录的等批谁的手机都行，见 `mayDecide`。
   */
  async decideApproval(
    id: string,
    decision: "allow" | "deny",
    device: string | null = null
  ): Promise<"ok" | "missing" | "settled" | "phone_only"> {
    const signIn = this.signIns.byId(id);
    const computerId = signIn ? null : this.approvals.byId(id)?.computerId;
    const owner = computerId ? this.#ownerOf(computerId) : null;
    if (!mayDecide(decision, this.#actor(device), owner)) return "phone_only";
    if (signIn) {
      const result = this.signIns.decide(id, decision, Date.now());
      if (device) this.pusher.decidedBy(id, device);
      if (result !== "missing") this.#approvalsChanged([]);
      return result;
    }
    // 等着的那次调用可能在 DO 被回收时断了。先把 pi 拉起来，它会重跑那次调用，读到这里的决定。
    await this.lifecycle.start();
    if (device) this.pusher.decidedBy(id, device);
    return this.gate.decide(id, decision);
  }

  /** 手机登记推送 token。只收手机的：浏览器和电脑 App 收不到 APNs。 */
  async savePushToken(input: {
    device: string;
    token: string;
    type: PushTokenType;
    env: ApnsEnv;
  }): Promise<"ok" | "not_phone"> {
    const row = this.devices.list().find((device) => device.id === input.device);
    if (row?.kind !== "phone") return "not_phone";
    this.push.save({ deviceId: input.device, token: input.token, type: input.type, env: input.env }, Date.now());
    if (input.type === "alert") {
      // 登记之前就在等的审批，这台手机也该收到。已经推过的不会再推。
      this.ctx.waitUntil(this.pusher.sync().catch((error) => console.warn("审批推送失败", error)));
    } else {
      // 能开实时活动了，或者活动开起来报上了 token：照现在的样子开、补一条更新或者结束。
      this.#liveChanged();
    }
    return "ok";
  }

  /** 手机上的实时活动结束或被划掉了，它的 token 用不着了。 */
  async removePushToken(device: string, token: string): Promise<void> {
    this.push.removeOwn(device, token);
  }

  /** 给这台设备发一条测试通知，把 APNs 的回答原样带回来，排查密钥、topic 和环境用。 */
  async testPush(device: string): Promise<
    | { readonly ok: false; readonly error: string }
    | { readonly ok: true; readonly results: readonly { env: ApnsEnv; status: number; reason: string | null }[] }
  > {
    const apns = this.#apnsClient();
    if (!apns) return { ok: false, error: "云端还没配 APNs 密钥（APNS_KEY、APNS_KEY_ID、APNS_TEAM_ID）。" };
    const tokens = this.push.tokens("alert").filter((token) => token.deviceId === device);
    if (tokens.length === 0) return { ok: false, error: "这台设备还没登记推送 token。" };
    const results = await Promise.all(
      tokens.map(async (token) => {
        const result = await apns.send({
          token: token.token,
          env: token.env,
          type: "alert",
          priority: 10,
          payload: { aps: { alert: { title: "Pupu", body: "推送通了。有要批准的事，会这样出现在锁屏上。" }, sound: "default" } }
        });
        if (result.gone) this.push.remove(token.token);
        return { env: token.env, status: result.status, reason: result.reason };
      })
    );
    return { ok: true, results };
  }

  /** 锁屏上的「收回」：和电脑菜单栏上的收回走同一段逻辑。 */
  async takeback(computerId: string): Promise<boolean> {
    await this.lifecycle.start();
    if (!this.computers.list().some((row) => row.id === computerId)) return false;
    this.gate.takeback(computerId);
    return true;
  }

  /** 往宽里改只认手机，见 `mayChangePolicy`。 */
  async setComputerPolicy(
    id: string,
    policy: string,
    device: string | null = null
  ): Promise<"ok" | "missing" | "phone_only"> {
    await this.lifecycle.start();
    if (!isComputerPolicy(policy)) throw new Error("没有这个分级");
    const computer = this.computers.list().find((row) => row.id === id);
    if (!computer) return "missing";
    if (!mayChangePolicy(computer.policy, policy, this.#actor(device), computer.ownerId)) return "phone_only";
    return this.gate.setPolicy(id, policy) ? "ok" : "missing";
  }

  /** 发一张设备凭据。明文只在这一次返回。`ownerId` 是这台电脑的主人。 */
  async createComputer(name: string, ownerId: string | null): Promise<{ id: string; name: string; token: string }> {
    await this.lifecycle.start();
    const trimmed = name.trim().slice(0, 80) || "电脑";
    const token = newDeviceToken();
    const row = this.computers.insert({ name: trimmed, ownerId, tokenHash: await tokenHash(token) });
    this.bridge.onChange();
    return { id: row.id, name: row.name, token };
  }

  /** 吊销一台电脑。主人自己能吊销，创建者能吊销所有人的（`mayRevoke`）。 */
  async revokeComputer(id: string, device: string | null = null): Promise<"ok" | "missing" | "forbidden"> {
    await this.lifecycle.start();
    const target = this.computers.list().find((row) => row.id === id);
    if (!target) return "missing";
    if (!mayRevoke(this.#actor(device), target.ownerId)) return "forbidden";
    return this.#revokeComputer(id) ? "ok" : "missing";
  }

  #revokeComputer(id: string): boolean {
    const row = this.computers.revoke(id);
    if (!row || row.revokedAt === null) return false;
    this.bridge.disconnect(id, 1008, "凭据已吊销");
    this.bridge.onChange();
    return true;
  }

  // ---- 成员（需求说明 4.7）----

  /** 创建者在手机 App 上邀请一个人，见 `mayInvite`。之后那个人用这个 Google 账号登录就放行。 */
  async inviteMember(
    email: string,
    device: string | null = null
  ): Promise<"ok" | "invalid" | "exists" | "creator_phone_only"> {
    const actor = this.#actor(device);
    if (!mayInvite(actor)) return "creator_phone_only";
    if (!isEmail(email)) return "invalid";
    if (!this.members.invite(email, actor?.memberId ?? null, Date.now())) return "exists";
    this.#devicesChanged();
    return "ok";
  }

  /**
   * 创建者移除一个成员：他名下的设备和电脑一起吊销，开着的连接马上断开。
   * 以后有了各人的聊天和个人记忆，也在这里一起删。
   */
  async removeMember(id: string, device: string | null = null): Promise<"ok" | "missing" | "creator_only"> {
    const target = this.members.byId(id);
    if (!target) return "missing";
    if (!mayRemoveMember(this.#actor(device), target)) return "creator_only";
    await this.lifecycle.start();
    for (const row of this.devices.ofMember(id)) this.#revokeDevice(row.id);
    for (const row of this.computers.list()) if (row.ownerId === id) this.#revokeComputer(row.id);
    this.members.remove(id);
    this.#devicesChanged();
    return "ok";
  }

  /** 桥拿自己的凭据注销自己，不用访问口令。 */
  async revokeComputerByToken(token: string): Promise<boolean> {
    const row = this.computers.byTokenHash(await tokenHash(token));
    if (!row || row.revokedAt !== null) return false;
    await this.lifecycle.start();
    return this.#revokeComputer(row.id);
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

/** 手机和桥把凭据放在 Authorization 头里，浏览器放在 cookie 里。电脑 App 的窗口也用 cookie，由 App 自己种。 */
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
 * 新设备换凭据，不用先登录。手机、电脑和电脑 App 在响应里拿到凭据，自己存好；
 * 浏览器拿到的是 cookie。
 */
async function handlePair(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await readJson<{ kind?: unknown; name?: unknown; code?: unknown; accessToken?: unknown }>(request);
  const kind = body.kind;
  if (kind !== "phone" && kind !== "browser" && kind !== "desktop" && kind !== "computer") {
    return Response.json({ error: "kind 只能是 phone、browser、desktop 或 computer" }, { status: 400 });
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
    return Response.json(await pupu(env).createPairingCode(caller.device));
  }
  const device = pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/);
  if (device && method === "POST") {
    const id = decodeURIComponent(device[1] ?? "");
    const result = await pupu(env).revokeDevice(id, caller.device);
    if (result === "missing") return Response.json({ error: "没有这台设备" }, { status: 404 });
    if (result === "forbidden") return Response.json({ error: "别人的设备只有创建者能吊销" }, { status: 403 });
    // 吊销的是自己：浏览器顺手清掉 cookie。
    const headers: HeadersInit = id === caller.device ? { "Set-Cookie": deviceCookie(url, null) } : {};
    return Response.json({ ok: true }, { headers });
  }
  const policy = pathname.match(/^\/api\/computers\/([^/]+)\/policy$/);
  if (policy && method === "POST") {
    const body = await readJson<{ policy?: string }>(request);
    const result = await pupu(env).setComputerPolicy(
      decodeURIComponent(policy[1] ?? ""),
      String(body.policy ?? ""),
      caller.device
    );
    if (result === "missing") return Response.json({ error: "没有这台电脑" }, { status: 404 });
    if (result === "phone_only") {
      return Response.json({ error: "放宽权限要在这台电脑主人的手机 App 上改" }, { status: 403 });
    }
    return Response.json({ ok: true });
  }
  const approval = pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (approval && method === "POST") {
    const body = await readJson<{ decision?: string }>(request);
    if (body.decision !== "allow" && body.decision !== "deny") {
      return Response.json({ error: "decision 只能是 allow 或 deny" }, { status: 400 });
    }
    const result = await pupu(env).decideApproval(decodeURIComponent(approval[1] ?? ""), body.decision, caller.device);
    if (result === "missing") return Response.json({ error: "没有这条请示" }, { status: 404 });
    if (result === "settled") return Response.json({ error: "这条请示已经处理过或过期了" }, { status: 409 });
    if (result === "phone_only") return Response.json({ error: "要在这台电脑主人的手机 App 上批准" }, { status: 403 });
    return Response.json({ ok: true });
  }
  if (pathname === "/api/push-tokens" && method === "POST") {
    if (!caller.device) return Response.json({ error: "要先配对，才能登记推送" }, { status: 400 });
    const body = await readJson<{ token?: unknown; type?: unknown; env?: unknown }>(request);
    const token = typeof body.token === "string" ? body.token.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64,400}$/.test(token)) {
      return Response.json({ error: "token 是 APNs 给的十六进制字符串" }, { status: 400 });
    }
    if (body.type !== "alert" && body.type !== "start" && body.type !== "activity") {
      return Response.json({ error: "type 只能是 alert、start 或 activity" }, { status: 400 });
    }
    if (body.env !== "sandbox" && body.env !== "production") {
      return Response.json({ error: "env 只能是 sandbox 或 production" }, { status: 400 });
    }
    const result = await pupu(env).savePushToken({ device: caller.device, token, type: body.type, env: body.env });
    if (result === "not_phone") return Response.json({ error: "只有手机 App 能登记推送" }, { status: 403 });
    return Response.json({ ok: true });
  }
  const pushToken = pathname.match(/^\/api\/push-tokens\/([0-9a-f]{64,400})$/);
  if (pushToken && method === "DELETE") {
    if (!caller.device) return Response.json({ error: "要先配对" }, { status: 400 });
    await pupu(env).removePushToken(caller.device, pushToken[1] ?? "");
    return Response.json({ ok: true });
  }
  if (pathname === "/api/push-tokens/test" && method === "POST") {
    if (!caller.device) return Response.json({ error: "要先配对" }, { status: 400 });
    const result = await pupu(env).testPush(caller.device);
    return Response.json(result, { status: result.ok ? 200 : 409 });
  }
  const takeback = pathname.match(/^\/api\/computers\/([^/]+)\/takeback$/);
  if (takeback && method === "POST") {
    const ok = await pupu(env).takeback(decodeURIComponent(takeback[1] ?? ""));
    if (!ok) return Response.json({ error: "没有这台电脑" }, { status: 404 });
    return Response.json({ ok: true });
  }
  const revoke = pathname.match(/^\/api\/computers\/([^/]+)\/revoke$/);
  if (revoke && method === "POST") {
    const result = await pupu(env).revokeComputer(decodeURIComponent(revoke[1] ?? ""), caller.device);
    if (result === "missing") return Response.json({ error: "没有这台电脑" }, { status: 404 });
    if (result === "forbidden") return Response.json({ error: "别人的电脑只有创建者能吊销" }, { status: 403 });
    return Response.json({ ok: true });
  }
  if (pathname === "/api/members" && method === "POST") {
    const body = await readJson<{ email?: unknown }>(request);
    const result = await pupu(env).inviteMember(typeof body.email === "string" ? body.email : "", caller.device);
    if (result === "invalid") return Response.json({ error: "填一个 Google 账号的邮箱" }, { status: 400 });
    if (result === "exists") return Response.json({ error: "这个人已经在成员名单上了" }, { status: 409 });
    if (result === "creator_phone_only") {
      return Response.json({ error: "邀请成员要创建者在手机 App 上做" }, { status: 403 });
    }
    return Response.json({ ok: true });
  }
  const member = pathname.match(/^\/api\/members\/([^/]+)\/remove$/);
  if (member && method === "POST") {
    const result = await pupu(env).removeMember(decodeURIComponent(member[1] ?? ""), caller.device);
    if (result === "missing") return Response.json({ error: "没有这个成员" }, { status: 404 });
    if (result === "creator_only") return Response.json({ error: "只有创建者能移除成员，创建者自己移除不了" }, { status: 403 });
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
      // 这几条在设备鉴权之前：配对和登录时还没有凭据，桥注销用的是桥自己的凭据。
      if (url.pathname === "/api/pair" && request.method === "POST") {
        return await handlePair(request, env, url);
      }
      if (url.pathname.startsWith(AUTH_PREFIX)) {
        const response = await handleAuth(request, url, {
          backend: pupu(env),
          google: googleClientFrom(env, isLocal(request)),
          browserName,
          deviceCookie: (target, token) => deviceCookie(target, token),
          source: (incoming) => sourceOf(incoming.headers.get("CF-Connecting-IP"))
        });
        if (response) return response;
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
