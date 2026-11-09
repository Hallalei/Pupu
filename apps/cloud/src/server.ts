import { DurableObject } from "cloudflare:workers";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { createRegistry, GenerationTask, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { googleClientFrom, randomToken } from "./auth/oidc";
import { AUTH_PREFIX, handleAuth, type AuthBackend, type RedeemResult, type SignInCredential, type SignInGrant } from "./auth/routes";
import {
  FLOW_TTL_MS,
  redeemStep,
  signInApprovalRow,
  signInApprovalView,
  SignInStore,
  type SignInFlow
} from "./auth/sign-ins";
import { CallSessions, computerActivity, describeWaiting, type ComputerActivity } from "./bridge/activity";
import { ApprovalStore, type ApprovalRow, type ApprovalView } from "./bridge/approvals";
import {
  DirectoryStore,
  pupuOfCredential,
  ROOT_PUPU,
  scopedCredential,
  seatsFrom,
  type Activation,
  type Assignment,
  type HeldSignIn,
  type Home,
  type InviteList
} from "./directory";
import { DESKTOP_TAG, RemoteDesktopHub, computerIdOfPath, iceServersFrom, mayViewDesktop } from "./bridge/desktop";
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
  tokenFromRequest,
  tokenHash
} from "./bridge/protocol";
import { ComputerStore } from "./bridge/store";
import { createComputerTools } from "./bridge/tools";
import { ConnectorClient, connectorConfigFrom, connectorMessage } from "./connectors/client";
import {
  CONNECTOR_SERVICES,
  ConnectorStore,
  finishAttempt,
  serviceOf,
  type AttemptResult,
  type ConnectorService,
  type ConnectorView
} from "./connectors/store";
import {
  connectorIdOf,
  createConnectorTools,
  describeAccount,
  planConnectorCall,
  type ConnectorDeps
} from "./connectors/tools";
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
  type CodeMaker,
  type DeviceKind,
  type DeviceView
} from "./devices";
import {
  actorOf,
  emailKey,
  isEmail,
  mayInvite,
  mayManageInvites,
  mayRemoveMember,
  mayRevoke,
  memberName,
  MemberStore,
  memberView,
  removeMember,
  type Actor,
  type MemberRow,
  type MemberView
} from "./members";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import {
  addRule,
  asAuthentication,
  asPurpose,
  asRegistration,
  PasskeyStore,
  proofOptions,
  register,
  registrationOptions,
  verifyProof,
  type AddRule,
  type PasskeyView,
  type Purpose,
  type RelyingParty
} from "./passkeys";
import { handoffMessage, type Sender } from "./messages";
import { REVOKED_CLOSE_CODE } from "./protocol";
import type { Project } from "./projects";
import { progressLine, ProjectStore } from "./projects";
import { renderPrompt } from "./prompt";
import { asksUser, failureSummary, reportCards, ReportStore, type ReportCard } from "./reports";
import { Apns, apnsKeyFrom, type ApnsEnv } from "./push/apns";
import { ApprovalPusher } from "./push/approvals";
import { LivePusher, liveDue, type LiveInput } from "./push/live";
import { PushStore, type PushTokenType } from "./push/store";
import { PiSessionSockets } from "./sockets";
import { dailyLimitFrom, dayOf, USAGE_LIMIT_MESSAGE, UsageStore, withDailyLimit } from "./usage";
import { chatSessions, mayOpen, ThreadStore, workFilter, type ChatsView, type PrivateChatRow } from "./threads";
import { createPupuTools } from "./tools";

/**
 * DeepSeek 官方接口的 V4.1 Flash：支持工具调用，也能看截图。费用从 DeepSeek 开放平台的充值余额里扣，
 * key 用 `wrangler secret put DEEPSEEK_API_KEY` 设置。之前用的 Workers AI gpt-oss-120b 只认文字。
 */
const MODEL = { provider: "deepseek", id: "deepseek-flash" } as const;
/** 模型出错时自动重试几次。报告要知道重试完了还没回上，才算出错。 */
const MAX_RETRIES = 5;

const SEATS_FULL = "内测名额已经满了。可以到 getpupu.com 申请，有名额了我们告诉你。";
const INVITE_WRONG = "邀请码不对，或者已经用过了。";
/** 记在 meta 里，用来判断已有会话要不要切模型。 */
const MODEL_KEY = `${MODEL.provider}/${MODEL.id}`;
/** 灵动岛到点重新看一眼：命令跑满 30 秒、屏幕授权到期。 */
const LIVE_JOB = "live-activity";
/** 屏幕授权到期：改回没有，菜单栏、网页、手机和灵动岛跟着换。 */
const SCREEN_JOB = "screen-grant";

/** v0 只有一个用户，所以只有一个 Pupu 实例。 */

export type PupuState = {
  readonly projects: readonly Project[];
  readonly computers: ReturnType<ComputerBridge["list"]>;
  /** 等用户批准的电脑动作，先来的在前。 */
  readonly approvals: readonly ApprovalView[];
  /** 配对过的手机和浏览器，新连上的在前。 */
  readonly devices: readonly DeviceView[];
  /** 每台电脑在做什么，顺序和 `computers` 一样。聊天顶部的「正在做」用。 */
  readonly activity: readonly ComputerActivity[];
  /** 成员名单，创建者在前。设备的 `memberId`、电脑的 `ownerId` 对的是这里的 id。 */
  readonly members: readonly MemberView[];
  /** 账户（连接器）。`enabled` 是 Pupu 这边配没配 open-connector。 */
  readonly connectors: {
    readonly enabled: boolean;
    readonly services: readonly ConnectorService[];
    readonly accounts: readonly ConnectorView[];
  };
  /** 项目报给聊天的结果，按时间先后。聊天里穿插在消息之间，卡上的 `chat` 说是哪一条。 */
  readonly reports: readonly ReportCard[];
  /** 这个人能进的两条聊天。没有成员身份时没有私聊。 */
  readonly chats: ChatsView;
  /** 本人的通行密钥和能不能再加一把（见 passkeys.ts 的 `addRule`）。不是成员是 null。 */
  readonly passkeys: { readonly keys: readonly PasskeyView[]; readonly add: AddRule } | null;
};

/** 配对的结果。失败时带上给 Worker 回的状态码。 */
export type PairResult =
  | { readonly ok: true; readonly id: string; readonly name: string; readonly token: string }
  | { readonly ok: false; readonly status: 400 | 401 | 403 | 429; readonly error: string };

/** 一张新凭据：明文发给对方，这边只存哈希。 */
type Minted = { readonly token: string; readonly hash: string };

const NOT_MEMBER = "你已经不在这个 Pupu 的成员名单上了。";

/**
 * 一个用户的 Pupu：一个 Durable Object，里面跑 pi-durable。
 * 主会话是 pi 的根会话，每人的私聊和每个项目各开一个 pi 会话，共用这个对象的 SQLite。
 */
export class Pupu extends DurableObject<Env> {
  /** 这是不是第一个 Pupu。按 Durable Object 的 id 认，不靠 meta 里记的名字：第一个 Pupu 从来不记。 */
  readonly #root = this.ctx.id.equals(this.env.Pupu.idFromName(ROOT_PUPU));
  readonly store = new ProjectStore(this.ctx.storage.sql);
  readonly threads = new ThreadStore(this.ctx.storage.sql, this.store);
  readonly reports = new ReportStore(this.ctx.storage.sql);
  readonly computers = new ComputerStore(this.ctx.storage.sql);
  readonly devices = new DeviceStore(this.ctx.storage.sql);
  readonly members = new MemberStore(this.ctx.storage.sql);
  readonly passkeys = new PasskeyStore(this.ctx.storage.sql);
  readonly connectors = new ConnectorStore(this.ctx.storage.sql);
  readonly usage = new UsageStore(this.ctx.storage.sql);
  /** 连接器工具和审批要用的状态。 */
  readonly #connectorDeps: ConnectorDeps = {
    client: () => this.#connectorClient(),
    accounts: () => this.connectors.list(),
    emailOf: (memberId) => (memberId ? (this.members.byId(memberId)?.email ?? null) : null),
    threadOf: (session) => this.threads.of(session)
  };
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
    // 新手机登录的等批推给所有手机（谁的手机都能批，见 sign-ins.ts）。
    audience: (row) => (row.kind === "sign_in" ? () => true : this.#phonesOf(row.computerId)),
    apns: () => this.#apnsClient(),
    now: () => Date.now(),
    log: (message) => console.warn(message)
  });
  readonly live = new LivePusher({
    store: this.push,
    apns: () => this.#apnsClient(),
    state: { get: () => this.store.meta("live.state"), set: (value) => this.store.setMeta("live.state", value) },
    audience: (computerId) => this.#phonesOf(computerId),
    now: () => Date.now(),
    log: (message) => console.warn(message)
  });
  /** 灵动岛下次要重新看一眼的时间，排在 Lifecycle 的任务队列里。 */
  #liveDue: number | null = null;
  /** 排好的屏幕授权到期时间。屏幕操作会顺延授权，到点时 `expireScreens` 没收掉的就再排一次。 */
  #screenDue: number | null = null;
  readonly gate = new ComputerGate({
    computers: () => this.bridge.list(),
    directory: this.computers,
    approvals: this.approvals,
    now: () => Date.now(),
    onChange: (computerIds) => this.#approvalsChanged(computerIds),
    plan: (call) => planConnectorCall(call, this.#connectorDeps),
    subjectName: (subjectId) => {
      const row = this.connectors.byId(connectorIdOf(subjectId) ?? "");
      return row ? describeAccount(row, () => null) : undefined;
    }
  });
  /** 电脑上的调用是哪个会话发的，「正在做」靠它说出是哪个项目。 */
  readonly #callSessions = new CallSessions();
  /** 上一次发出去的 activity，没变就不再发。 */
  #sentActivity = "";
  /**
   * 每个项目会话正在答的那条用户消息是什么时候的。这之前转交的事归这一轮报，之后的还排在队里。
   * 只在内存里：DO 重启后 pi 重发请求，会再经过 beforeRequest。
   */
  readonly #askedAt = new Map<string, number>();
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install({
        name: "pupu",
        sections: [
          {
            key: "pupu",
            tag: false,
            render: (input) => {
              const session = String(input.conversationId);
              const thread = this.threads.of(session);
              if (!thread) throw new Error(`会话 ${session} 既不是聊天也不是项目`);
              return renderPrompt(
                thread,
                this.store,
                this.reports,
                this.bridge.list(),
                this.connectors.list().map((row) => describeAccount(row, this.#connectorDeps.emailOf)),
                (memberId) => {
                  const member = this.members.byId(memberId);
                  return member ? memberName(member) : "这位成员";
                }
              );
            }
          }
        ],
        tools: [
          ...createPupuTools({
            store: this.store,
            threadOf: (session) => this.threads.of(session),
            createProject: (input) => this.#createProject(input),
            handOff: (project, task, operationId, origin) =>
              this.#handOff(project, task, operationId, origin)
          }),
          ...createComputerTools(this.bridge),
          ...createConnectorTools(this.#connectorDeps)
        ],
        hooks: [
          hook(ToolTask, {
            beforeTool: (call, api, context) => {
              const session = String(api.conversationId);
              this.#callSessions.remember(call.id, session);
              return this.gate.beforeTool({ ...call, session }, context.abortSignal);
            }
          }),
          hook(GenerationTask, {
            beforeRequest: (request, api) => {
              this.#rememberAsk(String(api.conversationId), request.messages);
              return undefined;
            },
            afterResponse: (message, api) => {
              this.usage.add(dayOf(Date.now()), message.usage.cost.total);
              this.#reportError(String(api.conversationId), message);
            },
            // 项目里回完一轮，记下最新进展，项目列表上显示；从聊天转来的事报回聊天。
            // 聊天里回完一轮，记下时间，客户端用它亮新消息的圆点。
            onYield: (answer, api) => {
              const session = String(api.conversationId);
              const reply = answer.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n");
              const progressed = this.store.recordReply(session, reply);
              const reported = this.reports.settle(
                session,
                this.#askedAt.get(session) ?? Date.now(),
                asksUser(reply) ? "asking" : "done",
                progressLine(reply),
                Date.now()
              );
              const thread = this.threads.of(session);
              const replied = Boolean(reply.trim()) && (thread?.kind === "main" || thread?.kind === "private");
              if (replied) this.threads.recordReply(thread, Date.now());
              if (progressed || reported || replied) this.#changed();
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
      models.setProvider(withDailyLimit(deepseekProvider(), () => this.#refusal()));
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          settings: {
            // 每次重试前的等待翻倍：1、2、4、8、16 秒，被限流的模型大约有 30 秒恢复。
            retry: { enabled: true, maxRetries: MAX_RETRIES, baseDelayMs: 1000 }
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: { model: MODEL, thinkingLevel: "low" }
  });
  readonly desktop = new RemoteDesktopHub({
    sockets: () => this.ctx.getWebSockets(DESKTOP_TAG),
    deviceOf: (request) => request.headers.get(DEVICE_HEADER),
    toBridge: (computerId, session, message) => this.bridge.sendDesktop(computerId, session, message),
    mayView: (device, computerId) => mayViewDesktop(this.#actor(device), this.#ownerOf(computerId)),
    iceServers: () => iceServersFrom(this.env),
    deviceName: (device) => this.devices.list().find((row) => row.id === device)?.name ?? "别的手机",
    newSession: () => crypto.randomUUID()
  });
  readonly sockets = new PiSessionSockets(
    this.harness,
    (tag) => this.ctx.getWebSockets(tag),
    (socket) => this.ctx.getTags(socket),
    (session) => this.store.touchSession(session),
    (device) => this.#senderOf(device),
    (session, device) => mayOpen(this.threads.of(session), this.#viewer(device)),
    (session, at) => {
      if (this.reports.stop(session, at, Date.now())) this.#changed();
    },
    [
      {
        tag: BRIDGE_TAG,
        isRequest: isBridgeRequest,
        onConnect: (socket, request) => this.bridge.onConnect(socket, request),
        onMessage: (socket, message) => this.bridge.onMessage(socket, message),
        onClose: (socket) => this.bridge.onClose(socket)
      },
      {
        tag: DESKTOP_TAG,
        isRequest: (request) => this.desktop.isRequest(request),
        tags: (request) => {
          const device = request.headers.get(DEVICE_HEADER);
          return device ? [deviceTag(device)] : [];
        },
        onConnect: (socket, request) => this.desktop.onConnect(socket, request),
        onMessage: (socket, message) => this.desktop.onMessage(socket, message),
        onClose: (socket) => this.desktop.onClose(socket)
      }
    ]
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
    this.bridge.onDesktop = (computerId, session, message) => this.desktop.fromBridge(computerId, session, message);
    this.bridge.onGone = (computerId) => this.desktop.bridgeGone(computerId);
    // 不等 onStart：没启动 pi 的 RPC（登录、配对、移除成员）改了电脑，网页和灵动岛也要跟上。
    this.bridge.onChange = () => {
      this.sockets.broadcast({ type: "computers_changed" });
      this.#activityChanged();
    };
    this.bridge.onActivity = () => this.#activityChanged();
  }

  /** 宿主启动，harness 已经打开 pi 之后。 */
  async onStart(): Promise<void> {
    // 心跳是固定字符串，运行时直接回 pong，不把这个对象叫醒。
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(BRIDGE_PING, BRIDGE_PONG));
    this.#revokeOrphans();
    // 这个任务上线之前开的屏幕授权，还没排到期。
    this.#scheduleScreen();
    await this.#syncModel();
    await this.sockets.reattach();
  }

  /** 以前移除成员没做完，可能留下挂在已经不在的人名下的设备和电脑。启动时补上吊销。 */
  #revokeOrphans(): void {
    const members = new Set(this.members.list().map((row) => row.id));
    const gone = (memberId: string | null) => memberId !== null && !members.has(memberId);
    for (const row of this.devices.list()) if (gone(row.memberId)) this.#revokeDevice(row.id);
    for (const row of this.computers.list()) if (gone(row.ownerId)) this.#revokeComputer(row.id);
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

  /** 项目会话这一轮在答的用户消息：取最后一条用户消息的时间。 */
  #rememberAsk(session: string, messages: readonly Message[]): void {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.role !== "user") continue;
      this.#askedAt.set(session, message.timestamp);
      return;
    }
  }

  /** 模型出错，重试完了还没回上：从聊天转来的事报「出错了」。还会重试的只记次数。 */
  #reportError(session: string, message: AssistantMessage): void {
    if (message.stopReason !== "error") {
      this.reports.clearErrors(session);
      return;
    }
    // 上下文太长会先压缩再试，不算出错。
    if (isContextOverflow(message)) return;
    const upTo = this.#askedAt.get(session) ?? Date.now();
    const errors = this.reports.countError(session, upTo);
    if (isRetryableAssistantError(message) && errors <= MAX_RETRIES) return;
    const summary = failureSummary(message.errorMessage ?? "");
    if (this.reports.settle(session, upTo, "failed", summary, Date.now())) this.#changed();
  }

  /** 项目会话停在一步等批：从聊天转来的事报「卡住了要你定」；批完了改回在做，等这一轮结束再报。 */
  #syncWaitingReports(): void {
    const waiting = new Map<string, { summary: string; upTo: number }>();
    for (const row of this.approvals.pending(Date.now())) {
      const session = this.#sessionOfCall(row.callId);
      if (!session || waiting.has(session)) continue;
      waiting.set(session, {
        summary: `等你批准：${describeWaiting(row)}`,
        upTo: this.#askedAt.get(session) ?? Date.now()
      });
    }
    if (this.reports.syncWaiting(waiting, Date.now())) this.#changed();
  }

  /** 审批或屏幕授权变了：网页重新拉状态，菜单栏换显示，手机上的通知跟着推或替换。 */
  #approvalsChanged(computerIds: readonly string[]): void {
    this.sockets.broadcast({ type: "approvals_changed" });
    this.#syncWaitingReports();
    for (const id of computerIds) this.bridge.sendStatus(id, this.gate.statusFor(id));
    this.#scheduleScreen();
    this.#activityChanged();
    this.ctx.waitUntil(this.pusher.sync().catch((error) => console.warn("审批推送失败", error)));
  }

  /** 这次工具调用在哪个会话里：等批的记在审批行上，别的只在内存里。 */
  #sessionOfCall(callId: string): string | null {
    return this.approvals.byCall(callId)?.session ?? this.#callSessions.of(callId);
  }

  /** 这个人看得到哪些调用，见 `seesWork`。 */
  #seenBy(viewer: string | null): (session: string | null, computerId: string) => boolean {
    return workFilter(this.threads, (computerId) => this.#ownerOf(computerId), viewer);
  }

  /** 每台电脑在做什么。`sees` 滤掉这个人看不到的调用，不给就是全部。 */
  #activity(sees: (session: string | null, computerId: string) => boolean = () => true): ComputerActivity[] {
    return computerActivity({
      computers: this.bridge.list(),
      running: this.bridge.running().filter((call) => sees(this.#sessionOfCall(call.callId), call.computerId)),
      pending: this.approvals.pending(Date.now()).filter((row) => sees(row.session, row.computerId)),
      projectOf: (callId) => {
        const session = this.#sessionOfCall(callId);
        const project = session ? this.store.projectBySession(session) : undefined;
        return project ? { id: project.id, name: project.name } : null;
      }
    });
  }

  #activityChanged(): void {
    this.#liveChanged();
    const sent = JSON.stringify(this.#activity());
    if (sent === this.#sentActivity) return;
    this.#sentActivity = sent;
    this.sockets.broadcastBy((device) => ({ type: "activity", activity: this.#activity(this.#seenBy(this.#viewer(device))) }));
  }

  /** 灵动岛：对一遍账，再排好下次该看的时候。 */
  #liveChanged(): void {
    const now = Date.now();
    const input: LiveInput = {
      computers: this.bridge.list(),
      running: this.bridge.running(),
      pending: this.approvals.pending(now),
      screenUntil: (id) => {
        const grant = this.computers.list().find((row) => row.id === id)?.screen;
        return grant?.kind === "active" ? grant.until : null;
      }
    };
    this.ctx.waitUntil(this.live.sync(input).catch((error) => console.warn("实时活动推送失败", error)));
    const due = liveDue(input, now);
    if (due === this.#liveDue) return;
    this.#liveDue = due;
    const { jobs } = this.lifecycle;
    const scheduled = due === null ? jobs.cancel(LIVE_JOB) : jobs.push({ id: LIVE_JOB, fn: LIVE_JOB, time: due + 500 });
    this.ctx.waitUntil(scheduled.then(() => undefined, (error) => console.warn("灵动岛的定时排不上", error)));
  }

  #scheduleScreen(): void {
    const due = this.gate.screenDue();
    if (due === this.#screenDue) return;
    this.#screenDue = due;
    const { jobs } = this.lifecycle;
    const scheduled = due === null ? jobs.cancel(SCREEN_JOB) : jobs.push({ id: SCREEN_JOB, fn: SCREEN_JOB, time: due + 500 });
    this.ctx.waitUntil(scheduled.then(() => undefined, (error) => console.warn("屏幕授权的到期排不上", error)));
  }

  /** Lifecycle 的任务队列到点了。 */
  onJob({ job }: LifecycleJobContext): void {
    if (job.fn === SCREEN_JOB) {
      this.#screenDue = null;
      this.gate.expireScreens();
      this.#scheduleScreen();
      return;
    }
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

  /** 这台设备是哪个成员的。不属于哪个成员、本机开发没带凭据、刚吊销的都是 null。 */
  #viewer(device: string | null): string | null {
    return this.#actor(device)?.memberId ?? null;
  }

  /** 这台设备发的消息算谁发的。不属于哪个成员是 null。 */
  #senderOf(device: string | null): Sender | null {
    const memberId = this.#viewer(device);
    const member = memberId ? this.members.byId(memberId) : undefined;
    return member ? { id: member.id, name: memberName(member) } : null;
  }

  /** 电脑的主人。没有这台电脑或者还没主人是 null。连接器的请示（见 connectors/tools.ts）是连这个账号的人。 */
  #ownerOf(computerId: string): string | null {
    const connector = connectorIdOf(computerId);
    if (connector !== null) return this.connectors.byId(connector)?.memberId ?? null;
    return this.computers.list().find((row) => row.id === computerId)?.ownerId ?? null;
  }

  /** 这台电脑的事推给哪些手机：只给主人的；还没主人的谁的手机都推。 */
  #phonesOf(computerId: string): (deviceId: string) => boolean {
    const owner = this.#ownerOf(computerId);
    if (owner === null) return () => true;
    const phones = new Set(this.devices.ofMember(owner).map((device) => device.id));
    return (deviceId) => phones.has(deviceId);
  }

  /**
   * 这个 Pupu 的 id，别的 Pupu 第一次有人登录时记下（Durable Object 自己不知道名字）。
   * 没记下就不是谁登录进来的，发不出凭据，抛错。
   */
  #pupu(): string {
    if (this.#root) return ROOT_PUPU;
    const pupu = this.store.meta("pupu");
    if (!pupu) throw new Error("这个 Pupu 还没记下自己的 id");
    return pupu;
  }

  /** 现在不再调模型的原因：当天额度用完了。第一个 Pupu 不限额。 */
  #refusal(): string | null {
    const limit = dailyLimitFrom(this.env);
    if (limit === null || this.#root) return null;
    return this.usage.spent(dayOf(Date.now())) >= limit ? USAGE_LIMIT_MESSAGE : null;
  }

  /**
   * 没配 CONNECTOR_URL 和 CONNECTOR_TOKEN 是 null。别的 Pupu 先不开连接器：
   * 大家共用一把管理员 token，隔离还没验过。
   */
  #connectorClient(): ConnectorClient | null {
    const config = this.#root ? connectorConfigFrom(this.env) : null;
    return config ? new ConnectorClient(config) : null;
  }

  #connectorViews(current: string | null): ConnectorView[] {
    const actor = this.#actor(current);
    return this.connectors.list().map((row) => ({
      id: row.id,
      service: row.service,
      name: serviceOf(row.service)?.name ?? row.service,
      account: row.account,
      memberId: row.memberId,
      ownerEmail: this.#connectorDeps.emailOf(row.memberId),
      removable: mayRevoke(actor, row.memberId),
      createdAt: row.createdAt
    }));
  }

  /** 访问口令和本机开发配的设备算创建者的；还没有创建者时先不属于谁。 */
  #fallbackOwner(): string | null {
    return this.members.creator()?.id ?? null;
  }

  /**
   * Google 认过的邮箱能不能进：在名单上就记下第一次登录；还没有创建者、邮箱又是 `CREATOR_EMAIL`，
   * 他就是创建者，之前连上的设备和电脑都归他。都不是返回 undefined。
   */
  #admit(email: string, displayName: string | null, now: number, founder: boolean): MemberRow | undefined {
    const member = this.members.byEmail(email);
    if (member) {
      this.members.markJoined(member.id, now);
      this.members.setName(member.id, displayName);
      return member;
    }
    const creatorEmail = founder ? email : this.env.CREATOR_EMAIL?.trim();
    if (this.members.creator() || !creatorEmail || emailKey(creatorEmail) !== emailKey(email)) return undefined;
    const creator = this.members.addCreator(email, now);
    if (!creator) return undefined;
    this.members.setName(creator.id, displayName);
    this.devices.claimUnowned(creator.id);
    this.computers.claimUnowned(creator.id);
    this.connectors.claimUnowned(creator.id);
    this.bridge.onChange();
    this.#devicesChanged();
    return creator;
  }

  // 下面是给 Worker 调的 RPC。原生 RPC 不经过 fetch，所以要自己先启动 Lifecycle。

  /** `current` 是发请求的设备，列表里给它打个标记。 */
  async state(current: string | null = null): Promise<PupuState> {
    await this.lifecycle.start();
    const viewer = this.#viewer(current);
    const own = viewer === null ? null : await this.#ensurePrivateChat(viewer);
    const sees = this.#seenBy(viewer);
    return {
      projects: this.store.listProjects(),
      computers: this.bridge.list(),
      approvals: [
        ...this.gate.pending((row) => sees(row.session, row.computerId)),
        ...this.signIns.pending(Date.now()).map(signInApprovalView)
      ],
      devices: this.#deviceViews(current),
      activity: this.#activity(sees),
      members: this.members.list().map((row) => memberView(row, viewer)),
      connectors: {
        enabled: connectorConfigFrom(this.env) !== null,
        services: CONNECTOR_SERVICES,
        accounts: this.#connectorViews(current)
      },
      reports: this.#reportCards(own),
      chats: this.threads.chats(own),
      passkeys:
        viewer === null
          ? null
          : {
              keys: this.passkeys.views(viewer),
              add: addRule(this.passkeys.everHad(viewer), this.devices.memberHadPhone(viewer))
            }
    };
  }

  #ensurePrivateChat(memberId: string): Promise<PrivateChatRow> {
    return this.threads.ensurePrivateChat(
      memberId,
      async () => (await this.harness.sessions.create()).id,
      Date.now()
    );
  }

  /** 主会话的卡大家都看，别人私聊转交的不发给你。 */
  #reportCards(own: PrivateChatRow | null): ReportCard[] {
    const names = new Map(this.store.listProjects().map((project) => [project.id, project.name]));
    return reportCards(this.reports.visible(chatSessions(own)), (id) => names.get(id));
  }

  /**
   * `device` 打开了这个项目：报到他看得到的聊天里的结果都算看过，那几张卡不再合在一起。
   * 主会话的卡谁打开都算；私聊转去的卡只有本人打开才算。
   */
  async markProjectSeen(projectId: string, device: string | null = null): Promise<boolean> {
    if (!this.store.getProject(projectId)) return false;
    const viewer = this.#viewer(device);
    const own = viewer === null ? undefined : this.threads.byMember(viewer);
    if (this.reports.markSeen(projectId, chatSessions(own), Date.now())) this.#changed();
    return true;
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
   * `device` 是要码的设备，记下是哪台、是不是手机（见 `mayPair`）、属于谁；本机开发不带设备，当手机算。
   * 这台设备已经吊销了是 null。
   */
  async createPairingCode(device: string | null = null): Promise<{ code: string; expiresAt: number } | null> {
    const now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS;
    for (;;) {
      const code = newPairingCode();
      const hash = await tokenHash(code.replace("-", ""));
      // 查设备和记下码之间不 await：设备这时被吊销了，码就不会漏下来。
      const from = this.#codeMaker(device);
      if (!from) return null;
      if (this.devices.addCode(hash, expiresAt, now, from)) {
        if (!this.#root) await directory(this.env).rememberCode(hash, this.#pupu(), expiresAt);
        return { code, expiresAt };
      }
    }
  }

  #codeMaker(device: string | null): CodeMaker | undefined {
    if (device === null) return { byPhone: true, memberId: null, deviceId: null };
    const row = this.devices.list().find((each) => each.id === device);
    return row && { byPhone: row.kind === "phone", memberId: row.memberId, deviceId: row.id };
  }

  /** 配对码试错到顶了：Worker 就不去查别的 Pupu 的码，由这里回 429。 */
  async pairLimited(source: string): Promise<boolean> {
    return this.devices.failures(`source:${source}`, Date.now()) >= SOURCE_LIMIT;
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
      if (!input.trusted) return { ok: false, status: 400, error: "要填配对码。" };
      const minted = await this.#mint();
      return this.#issue({ ...input, memberId: this.#fallbackOwner() }, minted);
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
    const hash = code ? await tokenHash(code) : null;
    const tokenMatched = hash === null && (await this.#isAccessToken(input.accessToken ?? ""));
    const minted = await this.#mint();
    // 从这里到发出凭据不再 await：码在这之前作废了（吊销、移除成员）就换不到，之后作废的跟着新设备一起吊销。
    const taken = hash === null ? undefined : this.devices.takeCode(hash, now);
    if (!taken && !tokenMatched) {
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
    return this.#issue({ ...input, memberId: taken ? taken.memberId : this.#fallbackOwner() }, minted);
  }

  async #isAccessToken(token: string): Promise<boolean> {
    const expected = this.env.ACCESS_TOKEN;
    if (!expected) return false;
    return (await tokenHash(token)) === (await tokenHash(expected));
  }

  // ---- 用 Google 登录（Worker 那一半在 src/auth/routes.ts）----

  /** 目录里还没记、但已经是这里的成员，或者是部署时填的创建者。 */
  async admits(email: string): Promise<boolean> {
    if (this.members.byEmail(email)) return true;
    const creator = this.env.CREATOR_EMAIL?.trim();
    return !this.members.creator() && Boolean(creator) && emailKey(creator ?? "") === emailKey(email);
  }

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
  async finishSignIn(input: {
    flow: SignInFlow;
    email: string;
    name: string;
    displayName: string | null;
    home: Home;
  }): Promise<SignInGrant> {
    const { flow, home } = input;
    if (home.pupu !== ROOT_PUPU) this.store.setMeta("pupu", home.pupu);
    const member = this.#admit(input.email, input.displayName, Date.now(), home.founder);
    if (!member) {
      return {
        kind: "refused",
        error: this.members.creator()
          ? "这个 Google 账号不在这个 Pupu 的成员名单上。请创建者在手机 App 的设置里邀请你。"
          : "这个 Pupu 还没有创建者，先要用部署时填的创建者账号登录一次。"
      };
    }
    if (flow.client === "browser") {
      const credential = await this.#credential("browser", input.name, member.id);
      return credential ? { kind: "cookie", token: credential.token } : { kind: "refused", error: NOT_MEMBER };
    }
    if (!flow.challenge) throw new Error("App 的登录缺少 challenge");
    const code = scopedCredential(this.#pupu(), randomToken());
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
    const gone = { status: "refused", code: 403, error: NOT_MEMBER } as const;
    if (!member) return gone;
    if (row.client === "phone") {
      const device = await this.#credential("phone", row.name ?? name, member.id);
      return device ? { status: "ok", device, computer: null } : gone;
    }
    // 用谁的账号登录电脑 App，这台电脑就是谁的。
    const device = await this.#credential("desktop", name, member.id);
    const computer = input.computer ? await this.#credential("computer", name, member.id) : null;
    if (!device || (input.computer && !computer)) return gone;
    return { status: "ok", device, computer };
  }

  /** 给成员发一张凭据。他这时已经不在名单上（正被移除）是 null。 */
  async #credential(kind: DeviceKind | "computer", name: string, memberId: string): Promise<SignInCredential | null> {
    const result = this.#issue({ kind, name, memberId }, await this.#mint());
    return result.ok ? { id: result.id, name: result.name, token: result.token } : null;
  }

  async #mint(): Promise<Minted> {
    const token = scopedCredential(this.#pupu(), newDeviceToken());
    return { token, hash: await tokenHash(token) };
  }

  /**
   * 配对过了关：电脑发桥的凭据，手机和浏览器发设备凭据。凭据要先 `#mint` 好，这里不 await：
   * 核对主人还在名单上和写下凭据是一步，移除成员插不到中间。
   */
  #issue(input: { kind: DeviceKind | "computer"; name: string; memberId: string | null }, minted: Minted): PairResult {
    if (input.memberId !== null && !this.members.byId(input.memberId)) {
      return { ok: false, status: 403, error: NOT_MEMBER };
    }
    const name = input.name.trim().slice(0, 80);
    if (input.kind === "computer") {
      const row = this.computers.insert({ name: name || "电脑", ownerId: input.memberId, tokenHash: minted.hash });
      this.bridge.onChange();
      return { ok: true, id: row.id, name: row.name, token: minted.token };
    }
    const row = this.devices.insert({
      name: name || DEFAULT_DEVICE_NAMES[input.kind],
      kind: input.kind,
      memberId: input.memberId,
      tokenHash: minted.hash
    });
    this.#devicesChanged();
    return { ok: true, id: row.id, name: row.name, token: minted.token };
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
    // 先收起灵动岛再删 token，删了就推不到这台手机的灵动岛了。
    this.ctx.waitUntil(this.live.end(id).catch((error) => console.warn("实时活动推送失败", error)));
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
    device: string | null = null,
    proof: PasskeyProof | null = null
  ): Promise<"ok" | "missing" | "settled" | "phone_only"> {
    const signIn = this.signIns.byId(id);
    const computerId = signIn ? null : this.approvals.byId(id)?.computerId;
    const owner = computerId ? this.#ownerOf(computerId) : null;
    const proven = decision === "allow" ? await this.#proven(device, { kind: "approval", id }, proof) : null;
    if (!mayDecide(decision, this.#actor(device), owner, proven)) return "phone_only";
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
    device: string | null = null,
    proof: PasskeyProof | null = null
  ): Promise<"ok" | "missing" | "phone_only"> {
    await this.lifecycle.start();
    if (!isComputerPolicy(policy)) throw new Error("没有这个分级");
    const computer = this.computers.list().find((row) => row.id === id);
    if (!computer) return "missing";
    const proven = await this.#proven(device, { kind: "policy", computerId: id, policy }, proof);
    if (!mayChangePolicy(computer.policy, policy, this.#actor(device), computer.ownerId, proven)) return "phone_only";
    return this.gate.setPolicy(id, policy) ? "ok" : "missing";
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
    this.gate.forgetComputer(id);
    this.bridge.onChange();
    return true;
  }

  // ---- 成员（需求说明 4.7）----

  async managesInvites(device: string | null = null): Promise<boolean> {
    return mayManageInvites(this.#actor(device));
  }

  /** 创建者在手机 App 上邀请一个人，见 `mayInvite`。之后那个人用这个 Google 账号登录就放行。 */
  async inviteMember(
    email: string,
    device: string | null = null,
    proof: PasskeyProof | null = null
  ): Promise<Assignment | "invalid" | "exists" | "creator_phone_only"> {
    const actor = this.#actor(device);
    const proven = await this.#proven(device, { kind: "invite", email: emailKey(email) }, proof);
    if (!mayInvite(actor, proven)) return "creator_phone_only";
    if (!isEmail(email)) return "invalid";
    if (this.members.byEmail(email)) return "exists";
    // 第一个 Pupu 的老成员不在目录里，目录认不出他已经有家了。
    if (!this.#root && (await root(this.env).admits(email))) return "taken";
    const assignment = await directory(this.env).assign(email, this.#pupu());
    if (assignment !== "ok") return assignment;
    if (!this.members.invite(email, actor?.memberId ?? null, Date.now())) return "exists";
    this.#devicesChanged();
    return "ok";
  }

  /**
   * 创建者移除一个成员，步骤见 members.ts 的 `removeMember`。他连的账号有一个断不开是 failed，
   * 他留在名单上、登录不了，创建者再点一次接着做完。
   * 他的私聊留着：映射还在，谁也打不开，创建者也一样。
   */
  async removeMember(id: string, device: string | null = null): Promise<"ok" | "missing" | "creator_only" | "failed"> {
    const target = this.members.list().find((row) => row.id === id);
    if (!target) return "missing";
    if (!mayRemoveMember(this.#actor(device), target)) return "creator_only";
    const result = await removeMember(
      target,
      {
        members: this.members,
        devices: this.devices,
        computers: this.computers,
        connectors: this.connectors,
        revokeDevice: (deviceId) => this.#revokeDevice(deviceId),
        revokeComputer: (computerId) => this.#revokeComputer(computerId),
        disconnect: (connectorId) => this.#disconnect(connectorId),
        release: (email) => directory(this.env).release(email, this.#pupu())
      },
      Date.now()
    );
    if (result === "ok") this.passkeys.revokeMember(id, Date.now());
    this.#devicesChanged();
    return result;
  }

  // ---- 通行密钥（passkeys.ts）----

  /**
   * 这台设备的主人刚为这件事亲手确认过：返回成员 id，否则 null。手机不走这里，手机本身就算确认。
   * 确认一次只对 `purpose` 这一件事有效。
   */
  async #proven(device: string | null, purpose: Purpose, proof: PasskeyProof | null): Promise<string | null> {
    const memberId = this.#viewer(device);
    if (!proof || memberId === null) return null;
    const ok = await verifyProof(this.passkeys, proof.rp, memberId, purpose, proof.response, Date.now());
    if (ok) this.#devicesChanged();
    return ok ? memberId : null;
  }

  /** 网页要确认一件事：先拿挑战。不是成员、或者在这个网址上没有通行密钥是 null。 */
  async passkeyProofOptions(device: string | null, rp: RelyingParty, purpose: Purpose) {
    const memberId = this.#viewer(device);
    if (memberId === null) return null;
    return proofOptions(this.passkeys, rp, memberId, purpose, Date.now());
  }

  /**
   * 加一把通行密钥的选项。只给网页和电脑 App 的窗口：手机本身就算亲手确认，用不着。
   * 规则见 `addRule`；要先确认的，`proof` 是用已有的那把为「add」确认过的结果。
   */
  async passkeyAddOptions(device: string | null, rp: RelyingParty, proof: PasskeyProof | null) {
    const actor = this.#actor(device);
    const member = actor?.memberId ? this.members.byId(actor.memberId) : undefined;
    if (!actor || !member || actor.kind === "phone") return { ok: false as const, reason: "not_member" as const };
    const rule = addRule(this.passkeys.everHad(member.id), this.devices.memberHadPhone(member.id));
    if (rule === "has_phone") return { ok: false as const, reason: rule };
    if (rule === "needs_proof" && (await this.#proven(device, { kind: "add" }, proof)) !== member.id) {
      return { ok: false as const, reason: rule };
    }
    return { ok: true as const, options: await registrationOptions(this.passkeys, rp, member, Date.now()) };
  }

  /** 存下浏览器建好的那把。名字用这台设备的名字，比如「Chrome · Mac」。 */
  async addPasskey(device: string | null, rp: RelyingParty, response: unknown): Promise<boolean> {
    const actor = this.#actor(device);
    const registration = asRegistration(response);
    if (!actor?.memberId || actor.kind === "phone" || !registration) return false;
    const name = this.devices.list().find((row) => row.id === device)?.name ?? "通行密钥";
    const ok = await register(this.passkeys, rp, actor.memberId, registration, name, Date.now());
    if (ok) this.#devicesChanged();
    return ok;
  }

  // ---- 账户（连接器，需求说明 4.8）----

  /**
   * 成员在手机上连一个账号：在 open-connector 发起授权，返回授权页地址。授权完跳回
   * `/api/connectors/done`，见 `finishConnector`。连账号是放宽 Pupu 能做的事，和放宽电脑分级一样
   * 只在手机 App 上做（`mayChangePolicy` 的理由）；`device` 是 null 是本机开发。
   */
  async startConnector(
    service: string,
    origin: string,
    device: string | null = null
  ): Promise<{ ok: true; url: string } | { ok: false; status: 400 | 403 | 409 | 502; error: string }> {
    const client = this.#connectorClient();
    if (!client) return { ok: false, status: 409, error: "这个 Pupu 还没配连接器（open-connector）" };
    if (!serviceOf(service)) return { ok: false, status: 400, error: "现在还不能连这个服务" };
    const actor = this.#actor(device);
    if (actor !== null && actor?.kind !== "phone") return { ok: false, status: 403, error: "连账号要在手机 App 上做" };
    if (actor !== null && actor.memberId === null && this.members.creator()) {
      return { ok: false, status: 403, error: "这台手机不属于哪个成员，先用 Google 登录" };
    }
    const attempt = crypto.randomUUID();
    const returnUri = new URL(`/api/connectors/done?attempt=${attempt}`, origin).toString();
    try {
      const started = await client.start(service, returnUri);
      this.connectors.addAttempt({
        id: attempt,
        requestId: started.requestId,
        service,
        memberId: actor?.memberId ?? this.#fallbackOwner(),
        client: actor === null ? "browser" : "phone",
        createdAt: Date.now()
      });
      return { ok: true, url: started.authorizationUrl };
    } catch (error) {
      return { ok: false, status: 502, error: connectorMessage(error) };
    }
  }

  /** 授权页跳回来，规则见 connectors/store.ts 的 `finishAttempt`。 */
  async finishConnector(attemptId: string): Promise<AttemptResult | undefined> {
    const result = await finishAttempt(
      attemptId,
      {
        store: this.connectors,
        client: this.#connectorClient(),
        memberIn: (memberId) => this.members.byId(memberId) !== undefined
      },
      Date.now()
    );
    if (result?.ok) this.#devicesChanged();
    return result;
  }

  /** 断开一个账号：自己的自己能断，创建者能断所有人的（是收紧，哪个设备上都行）。 */
  async removeConnector(id: string, device: string | null = null): Promise<"ok" | "missing" | "forbidden" | "failed"> {
    const row = this.connectors.byId(id);
    if (!row) return "missing";
    if (!mayRevoke(this.#actor(device), row.memberId)) return "forbidden";
    return (await this.#disconnect(id)) ? "ok" : "failed";
  }

  /** 先在 open-connector 撤销授权，成功了再删这边的记录，免得记录没了凭据还在。那边已经没有这个连接也算成功。 */
  async #disconnect(id: string): Promise<boolean> {
    const row = this.connectors.byId(id);
    if (!row) return true;
    const client = this.#connectorClient();
    if (client) {
      try {
        await client.disconnect(row.service, row.alias);
      } catch (error) {
        console.warn("断开连接器失败", error);
        return false;
      }
    }
    this.connectors.remove(id);
    this.#devicesChanged();
    return true;
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

  /** 聊天把一件事交给项目：作为一条消息提交到项目会话，项目自己接着做。`origin` 是来自哪条聊天，报告卡回到那里。 */
  async #handOff(
    project: Project,
    task: string,
    operationId: string,
    origin: string
  ): Promise<void> {
    // 先记报告再提交：报告的时间要早于项目会话里那条消息，这一轮结束时才认得出是它。
    this.reports.open(
      { id: operationId, projectId: project.id, session: project.session, task, origin },
      Date.now()
    );
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
/** 账号和 Pupu 的对应表，只有一个实例。规则见 directory.ts。 */
export class Directory extends DurableObject<Env> {
  readonly store = new DirectoryStore(this.ctx.storage.sql);

  async home(email: string): Promise<Home | null> {
    return this.store.home(email);
  }

  async holdSignIn(tokenHash: string, signIn: HeldSignIn): Promise<void> {
    const now = Date.now();
    this.store.holdSignIn(tokenHash, signIn, now + FLOW_TTL_MS, now);
  }

  async activate(tokenHash: string, code: string): Promise<Activation> {
    return this.store.activate(tokenHash, code, seatsFrom(this.env), Date.now());
  }

  async invites(): Promise<InviteList> {
    return this.store.invites(seatsFrom(this.env));
  }

  async createInvite(): Promise<string | null> {
    return this.store.createInvite(seatsFrom(this.env), Date.now());
  }

  async revokeInvite(code: string): Promise<boolean> {
    return this.store.revokeInvite(code);
  }

  async assign(email: string, pupu: string): Promise<Assignment> {
    return this.store.assign(email, pupu, seatsFrom(this.env), Date.now());
  }

  async release(email: string, pupu: string): Promise<void> {
    this.store.release(email, pupu);
  }

  async knows(pupu: string): Promise<boolean> {
    return this.store.knows(pupu);
  }

  async rememberCode(codeHash: string, pupu: string, expiresAt: number): Promise<void> {
    this.store.rememberCode(codeHash, pupu, expiresAt, Date.now());
  }

  async pupuOfCode(codeHash: string): Promise<string | null> {
    return this.store.pupuOfCode(codeHash, Date.now());
  }
}

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

type PupuStub = DurableObjectStub<Pupu>;

/**
 * 发请求的设备和它所在的 Pupu。`device` 是 null：本机开发、没设访问口令、什么凭据都没带。
 */
type Caller = { readonly device: string | null; readonly pupu: PupuStub; readonly name: string };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * 授权完从 open-connector 跳回来。没有设备凭据（手机上是系统的登录页），靠 attempt 这个一次性的随机 id 认。
 * 手机跳回 App（`pupu://connector`，登录会话接住）；浏览器显示一页说结果。
 */
async function handleConnectorDone(env: Env, url: URL): Promise<Response> {
  const attempt = url.searchParams.get("attempt") ?? "";
  const result = /^[0-9a-f-]{36}$/.test(attempt) ? await root(env).finishConnector(attempt) : undefined;
  if (result?.client === "phone") {
    const back = new URL("pupu://connector");
    back.searchParams.set("status", result.ok ? "connected" : "failed");
    back.searchParams.set("service", result.service);
    back.searchParams.set("message", result.message);
    return Response.redirect(back.toString(), 302);
  }
  const message = result?.message ?? "这个授权链接已经用过或过期了，回 Pupu 再连一次。";
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pupu</title><body style="font:17px/26px -apple-system,system-ui,sans-serif;margin:48px 24px;color:#1f1f1f"><p>${escapeHtml(message)}</p><p>可以关掉这一页了。</p></body>`,
    { status: result ? 200 : 410, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

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
    const name = pupuOfCredential(credential.token);
    const home = await knownPupu(env, name);
    const device = await home?.authenticateDevice(credential.token);
    return home && device ? { device, pupu: home, name } : null;
  }
  return isLocal(request) && !env.ACCESS_TOKEN ? { device: null, pupu: root(env), name: ROOT_PUPU } : null;
}

/** 浏览器的凭据只放进 HttpOnly cookie，页面上的脚本拿不到。`token` 是 null 时清掉。 */
function deviceCookie(url: URL, token: string | null): string {
  // 本机开发是 http，Safari 不收带 Secure 的 cookie。
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const value = token ? `${token}; Max-Age=31536000` : "; Max-Age=0";
  return `${TOKEN_COOKIE}=${value}; Path=/; HttpOnly${secure}; SameSite=Lax`;
}

function pupuNamed(env: Env, name: string): PupuStub {
  return env.Pupu.get(env.Pupu.idFromName(name));
}

function root(env: Env): PupuStub {
  return pupuNamed(env, ROOT_PUPU);
}

function directory(env: Env) {
  return env.Directory.get(env.Directory.idFromName("directory"));
}

/** 目录里认识的 id。Pupu 只增不减，记下来平时就不用问目录。 */
const knownPupus = new Set<string>([ROOT_PUPU]);

/** 凭据前缀是客户端发来的：先问目录，乱填的前缀不会凭空造出一个 Durable Object。 */
async function knownPupu(env: Env, name: string): Promise<PupuStub | null> {
  if (!knownPupus.has(name)) {
    if (!(await directory(env).knows(name))) return null;
    knownPupus.add(name);
  }
  return pupuNamed(env, name);
}

/** 这个账号住哪：目录里有就是那里，第一个 Pupu 的老成员留在那里。其余的还没有家，要邀请码。 */
async function homeOf(env: Env, email: string): Promise<Home | null> {
  const known = await directory(env).home(email);
  if (known) return known;
  return (await root(env).admits(email)) ? { pupu: ROOT_PUPU, founder: false } : null;
}

/** 登录流程还没认出是谁，放在第一个 Pupu；认出来之后才分流。 */
function authBackend(env: Env): AuthBackend {
  return {
    addSignInFlow: (flow) => root(env).addSignInFlow(flow),
    takeSignInFlow: (state) => root(env).takeSignInFlow(state),
    finishSignIn: async (input) => {
      const home = await homeOf(env, input.email);
      if (home) return pupuNamed(env, home.pupu).finishSignIn({ ...input, home });
      if (seatsFrom(env) === 0) return root(env).finishSignIn({ ...input, home: { pupu: ROOT_PUPU, founder: false } });
      const token = randomToken();
      await directory(env).holdSignIn(await tokenHash(token), input);
      return { kind: "invite", token };
    },
    activate: async (token, code) => {
      const result = await directory(env).activate(await tokenHash(token), code);
      if (result.status !== "ok") {
        if (result.status === "gone") return { status: "gone" };
        return { status: "retry", error: result.status === "full" ? SEATS_FULL : INVITE_WRONG };
      }
      const { home, signIn } = result;
      return { status: "ok", flow: signIn.flow, grant: await pupuNamed(env, home.pupu).finishSignIn({ ...signIn, home }) };
    },
    redeemSignIn: async (input) => {
      const home = await knownPupu(env, pupuOfCredential(input.code));
      if (!home) return { status: "refused", code: 400, error: "这次登录已经失效了。重新登录一次。" };
      return home.redeemSignIn(input);
    }
  };
}

/** 一次通行密钥确认：浏览器给的结果，加上它是在哪个网址上做的。 */
type PasskeyProof = { readonly rp: RelyingParty; readonly response: AuthenticationResponseJSON };

/** 网页在哪个网址上：通行密钥绑在主机名上，app.getpupu.com 和 workers.dev 上各是各的。 */
function relyingParty(url: URL): RelyingParty {
  return { id: url.hostname, origin: url.origin };
}

/** 请求里带的确认。没带、形状不对都当没带，由权限判断去拒。 */
function proofOf(url: URL, value: unknown): PasskeyProof | null {
  const response = asAuthentication(value);
  return response ? { rp: relyingParty(url), response } : null;
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
  const code = typeof body.code === "string" ? normalizePairingCode(body.code) : null;
  const source = sourceOf(request.headers.get("CF-Connecting-IP"));
  const owner =
    code && !(await root(env).pairLimited(source)) ? await directory(env).pupuOfCode(await tokenHash(code)) : null;
  const result = await (owner ? pupuNamed(env, owner) : root(env)).pair({
    kind,
    name: kind === "browser" ? browserName(request.headers.get("User-Agent")) : String(body.name ?? ""),
    code: typeof body.code === "string" ? body.code : undefined,
    accessToken: typeof body.accessToken === "string" ? body.accessToken : undefined,
    // 来源只认 Cloudflare 填的这个头，客户端自己写的 X-Forwarded-For 不算。
    source,
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
    return Response.json(await caller.pupu.state(caller.device));
  }
  if (pathname === "/api/pairing-codes" && method === "POST") {
    const code = await caller.pupu.createPairingCode(caller.device);
    return code ? Response.json(code) : Response.json({ error: "这台设备已经吊销了" }, { status: 401 });
  }
  const device = pathname.match(/^\/api\/devices\/([^/]+)\/revoke$/);
  if (device && method === "POST") {
    const id = decodeURIComponent(device[1] ?? "");
    const result = await caller.pupu.revokeDevice(id, caller.device);
    if (result === "missing") return Response.json({ error: "没有这台设备" }, { status: 404 });
    if (result === "forbidden") return Response.json({ error: "别人的设备只有创建者能吊销" }, { status: 403 });
    // 吊销的是自己：浏览器顺手清掉 cookie。
    const headers: HeadersInit = id === caller.device ? { "Set-Cookie": deviceCookie(url, null) } : {};
    return Response.json({ ok: true }, { headers });
  }
  const policy = pathname.match(/^\/api\/computers\/([^/]+)\/policy$/);
  if (policy && method === "POST") {
    const body = await readJson<{ policy?: string; proof?: unknown }>(request);
    const result = await caller.pupu.setComputerPolicy(
      decodeURIComponent(policy[1] ?? ""),
      String(body.policy ?? ""),
      caller.device,
      proofOf(url, body.proof)
    );
    if (result === "missing") return Response.json({ error: "没有这台电脑" }, { status: 404 });
    if (result === "phone_only") {
      return Response.json({ error: "放宽权限要电脑主人亲手确认：在手机 App 上改，或者用通行密钥" }, { status: 403 });
    }
    return Response.json({ ok: true });
  }
  const approval = pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (approval && method === "POST") {
    const body = await readJson<{ decision?: string; proof?: unknown }>(request);
    if (body.decision !== "allow" && body.decision !== "deny") {
      return Response.json({ error: "decision 只能是 allow 或 deny" }, { status: 400 });
    }
    const result = await caller.pupu.decideApproval(
      decodeURIComponent(approval[1] ?? ""),
      body.decision,
      caller.device,
      proofOf(url, body.proof)
    );
    if (result === "missing") return Response.json({ error: "没有这条请示" }, { status: 404 });
    if (result === "settled") return Response.json({ error: "这条请示已经处理过或过期了" }, { status: 409 });
    if (result === "phone_only") {
      return Response.json({ error: "要电脑主人亲手批准：在手机 App 上点，或者用通行密钥" }, { status: 403 });
    }
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
    const result = await caller.pupu.savePushToken({ device: caller.device, token, type: body.type, env: body.env });
    if (result === "not_phone") return Response.json({ error: "只有手机 App 能登记推送" }, { status: 403 });
    return Response.json({ ok: true });
  }
  const pushToken = pathname.match(/^\/api\/push-tokens\/([0-9a-f]{64,400})$/);
  if (pushToken && method === "DELETE") {
    if (!caller.device) return Response.json({ error: "要先配对" }, { status: 400 });
    await caller.pupu.removePushToken(caller.device, pushToken[1] ?? "");
    return Response.json({ ok: true });
  }
  if (pathname === "/api/push-tokens/test" && method === "POST") {
    if (!caller.device) return Response.json({ error: "要先配对" }, { status: 400 });
    const result = await caller.pupu.testPush(caller.device);
    return Response.json(result, { status: result.ok ? 200 : 409 });
  }
  const takeback = pathname.match(/^\/api\/computers\/([^/]+)\/takeback$/);
  if (takeback && method === "POST") {
    const ok = await caller.pupu.takeback(decodeURIComponent(takeback[1] ?? ""));
    if (!ok) return Response.json({ error: "没有这台电脑" }, { status: 404 });
    return Response.json({ ok: true });
  }
  const revoke = pathname.match(/^\/api\/computers\/([^/]+)\/revoke$/);
  if (revoke && method === "POST") {
    const result = await caller.pupu.revokeComputer(decodeURIComponent(revoke[1] ?? ""), caller.device);
    if (result === "missing") return Response.json({ error: "没有这台电脑" }, { status: 404 });
    if (result === "forbidden") return Response.json({ error: "别人的电脑只有创建者能吊销" }, { status: 403 });
    return Response.json({ ok: true });
  }
  if (pathname === "/api/members" && method === "POST") {
    const body = await readJson<{ email?: unknown; proof?: unknown }>(request);
    const result = await caller.pupu.inviteMember(
      typeof body.email === "string" ? body.email : "",
      caller.device,
      proofOf(url, body.proof)
    );
    if (result === "invalid") return Response.json({ error: "填一个 Google 账号的邮箱" }, { status: 400 });
    if (result === "exists") return Response.json({ error: "这个人已经在成员名单上了" }, { status: 409 });
    if (result === "taken") return Response.json({ error: "这个账号已经有自己的 Pupu 了" }, { status: 409 });
    if (result === "full") return Response.json({ error: SEATS_FULL }, { status: 409 });
    if (result === "creator_phone_only") {
      return Response.json({ error: "邀请成员要创建者亲手确认：在手机 App 上做，或者用通行密钥" }, { status: 403 });
    }
    return Response.json({ ok: true });
  }
  if (pathname === "/api/proofs" && method === "POST") {
    const body = await readJson<{ purpose?: unknown }>(request);
    const purpose = asPurpose(body.purpose);
    if (!purpose) return Response.json({ error: "要确认什么没说清楚" }, { status: 400 });
    const options = await caller.pupu.passkeyProofOptions(caller.device, relyingParty(url), purpose);
    if (!options) return Response.json({ error: `你在 ${url.host} 上还没有通行密钥，先在设置里加一把` }, { status: 409 });
    return Response.json(options);
  }
  if (pathname === "/api/passkeys/options" && method === "POST") {
    const body = await readJson<{ proof?: unknown }>(request);
    const result = await caller.pupu.passkeyAddOptions(caller.device, relyingParty(url), proofOf(url, body.proof));
    if (result.ok) return Response.json(result.options);
    const error =
      result.reason === "has_phone"
        ? "你连过手机，在手机 App 上批准就行"
        : result.reason === "needs_proof"
          ? "先用已有的通行密钥确认一次"
          : "要先用 Google 登录，在网页或电脑 App 上加";
    return Response.json({ error, reason: result.reason }, { status: 403 });
  }
  if (pathname === "/api/passkeys" && method === "POST") {
    const body = await readJson<{ response?: unknown }>(request);
    const ok = await caller.pupu.addPasskey(caller.device, relyingParty(url), body.response);
    return ok ? Response.json({ ok }) : Response.json({ error: "没加上，再试一次" }, { status: 400 });
  }
  const inviteRevoke = pathname.match(/^\/api\/invites\/([^/]+)\/revoke$/);
  if (pathname === "/api/invites" || inviteRevoke) {
    if (caller.name !== ROOT_PUPU || !(await caller.pupu.managesInvites(caller.device))) {
      return Response.json({ error: "只有创建者能管邀请码" }, { status: 403 });
    }
    if (method === "GET" && !inviteRevoke) return Response.json(await directory(env).invites());
    if (method === "POST" && inviteRevoke) {
      const ok = await directory(env).revokeInvite(decodeURIComponent(inviteRevoke[1] ?? ""));
      return ok ? Response.json({ ok }) : Response.json({ error: "这个邀请码用过了，或者不存在" }, { status: 404 });
    }
    if (method === "POST") {
      const code = await directory(env).createInvite();
      return code ? Response.json({ code }) : Response.json({ error: SEATS_FULL }, { status: 409 });
    }
  }
  const member = pathname.match(/^\/api\/members\/([^/]+)\/remove$/);
  if (member && method === "POST") {
    const result = await caller.pupu.removeMember(decodeURIComponent(member[1] ?? ""), caller.device);
    if (result === "missing") return Response.json({ error: "没有这个成员" }, { status: 404 });
    if (result === "creator_only") return Response.json({ error: "只有创建者能移除成员，创建者自己移除不了" }, { status: 403 });
    if (result === "failed") return Response.json({ error: "他连的账号有一个没断开，等一下再点一次移除" }, { status: 502 });
    return Response.json({ ok: true });
  }
  const connect = pathname.match(/^\/api\/connectors\/([a-z0-9_]+)\/connect$/);
  if (connect && method === "POST") {
    const result = await caller.pupu.startConnector(connect[1] ?? "", url.origin, caller.device);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ url: result.url });
  }
  const disconnect = pathname.match(/^\/api\/connectors\/([^/]+)\/remove$/);
  if (disconnect && method === "POST") {
    const result = await caller.pupu.removeConnector(decodeURIComponent(disconnect[1] ?? ""), caller.device);
    if (result === "missing") return Response.json({ error: "没有这个账号" }, { status: 404 });
    if (result === "forbidden") return Response.json({ error: "别人连的账号只有创建者能断开" }, { status: 403 });
    if (result === "failed") return Response.json({ error: "连接器那边没断开，等一下再试" }, { status: 502 });
    return Response.json({ ok: true });
  }
  if (pathname === "/api/computers/run" && method === "POST") {
    if (!isLocal(request)) return new Response("Not found", { status: 404 });
    const body = await readJson<{ command?: string; computerId?: string; background?: boolean }>(request);
    const result = await caller.pupu.runCommand({
      command: String(body.command ?? ""),
      computerId: body.computerId,
      background: body.background === true,
      requestId: crypto.randomUUID()
    });
    return Response.json(result);
  }
  const seen = pathname.match(/^\/api\/projects\/([^/]+)\/seen$/);
  if (seen && method === "POST") {
    const ok = await caller.pupu.markProjectSeen(decodeURIComponent(seen[1] ?? ""), caller.device);
    if (!ok) return Response.json({ error: "没有这个项目" }, { status: 404 });
    return Response.json({ ok: true });
  }
  if (pathname === "/api/projects" && method === "POST") {
    const body = await readJson<{ name?: string; goal?: string }>(request);
    const project = await caller.pupu.createProject({
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
      const token = tokenFromRequest(request);
      return ((token && (await knownPupu(env, pupuOfCredential(token)))) || root(env)).fetch(request);
    }

    try {
      // 这几条在设备鉴权之前：配对和登录时还没有凭据，桥注销用的是桥自己的凭据。
      if (url.pathname === "/api/pair" && request.method === "POST") {
        return await handlePair(request, env, url);
      }
      if (url.pathname.startsWith(AUTH_PREFIX)) {
        const response = await handleAuth(request, url, {
          backend: authBackend(env),
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
      if (url.pathname === "/api/connectors/done" && request.method === "GET") {
        return await handleConnectorDone(env, url);
      }
      if (url.pathname === "/api/bridge/revoke" && request.method === "POST") {
        const token = credentialOf(request)?.token;
        const home = token ? await knownPupu(env, pupuOfCredential(token)) : null;
        if (!token || !home || !(await home.revokeComputerByToken(token))) {
          return Response.json({ error: "凭据无效，或者已经吊销了" }, { status: 401 });
        }
        return Response.json({ ok: true });
      }

      const caller = await authenticate(request, env);
      if (!caller) return new Response("Unauthorized", { status: 401 });

      // 远程桌面的信令：能不能看这台电脑由 Durable Object 按设备判断。客户端自己带的设备头不算数。
      if (computerIdOfPath(url.pathname) !== null) {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return new Response("远程桌面要用 WebSocket 连接。", { status: 426 });
        }
        const forwarded = new Request(request);
        forwarded.headers.delete(DEVICE_HEADER);
        if (caller.device) forwarded.headers.set(DEVICE_HEADER, caller.device);
        return caller.pupu.fetch(forwarded);
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url, caller);
      }
      // 客户端永远连 `/agents/pupu/me`，这里换成它自己的 Pupu，路径上选不了别人的。
      // 服务端选实例的做法见 agents 文档 docs/agents/routing.md。
      const agentPath = `/agents/pupu/${ROOT_PUPU}`;
      if (url.pathname.startsWith("/agents/") && !url.pathname.startsWith(agentPath)) {
        return new Response("Not found", { status: 404 });
      }
      const target = new URL(url);
      target.pathname = url.pathname.replace(agentPath, `/agents/pupu/${caller.name}`);
      // 告诉 Pupu 这条连接是哪台设备的，吊销时按设备断开。客户端自己带的这个头不算数。
      const forwarded = new Request(target, request);
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
