import { DurableObject } from "cloudflare:workers";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, GenerationTask, Harness, hook, ToolTask } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
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
import { isComputerPolicy, NEW_COMPUTER_POLICY } from "./bridge/policy";
import {
  BRIDGE_PATH,
  BRIDGE_PING,
  BRIDGE_PONG,
  BRIDGE_TAG,
  isBridgeRequest,
  newDeviceToken,
  tokenFromRequest,
  tokenHash,
  type BrowserFrame
} from "./bridge/protocol";
import { ComputerStore } from "./bridge/store";
import { ANY_COMPUTER, FollowUpStore } from "./bridge/followups";
import { createComputerTools } from "./bridge/tools";
import { ModelRelay } from "./bridge/model-relay";
import { probeModel } from "./model/probe";
import { ROUTER_MODEL, routerProvider } from "./model/router";
import { modelView, parseChoice, type ModelView } from "./model/settings";
import { ModelStore } from "./model/store";
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
  mayConnect,
  mayInvite,
  mayManageInvites,
  mayRemoveMember,
  mayRevoke,
  memberName,
  MemberStore,
  memberView,
  removeMember,
  type Actor,
  type MemberRole,
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
import { handbackNotice, handoffMessage, noticeMessage, type Sender } from "./messages";
import { AVATAR_PRESETS } from "./avatar-presets";
import {
  AvatarStore,
  checkUpload,
  formatChoice,
  isPreset,
  MAX_AVATAR_BYTES,
  PUPU_AVATAR_KEY,
  PUPU_AVATAR_META,
  pupuAvatarUrl,
  type AvatarTarget,
  type StoredAvatar,
  type UploadCheck
} from "./avatars";
import { REVOKED_CLOSE_CODE, type ServerMessage } from "./protocol";
import type { Project, SpaceMode } from "./projects";
import { progressLine, ProjectStore } from "./projects";
import { renderPrompt } from "./prompt";
import { asksUser, failureSummary, reportCards, ReportStore, STOPPED_SUMMARY, type ReportCard } from "./reports";
import { Apns, apnsKeyFrom, type ApnsEnv } from "./push/apns";
import { ApprovalPusher } from "./push/approvals";
import { LivePusher, liveDue, type LiveInput } from "./push/live";
import { PushStore, type PushTokenType } from "./push/store";
import { pushTakeover } from "./push/takeover";
import { PiSessionSockets } from "./sockets";
import { dailyLimitFrom, dayOf, USAGE_LIMIT_MESSAGE, UsageStore, withDailyLimit } from "./usage";
import { maySeeSpace } from "./access.ts";
import { DOC_BODY_LIMIT, DocStore, docScope, SKILL_LIST_LIMIT, viewerScope, viewerTarget, type Doc, type DocKind, type DocMeta } from "./docs.ts";
import { createDocTools } from "./docs-tools.ts";
import { checkSpaceChange, parseSpaceChange, readableReports, SPACE_ERRORS, type SpaceChange, type SpaceVerdict } from "./spaces.ts";
import { childReport, COORDINATOR_TOOLS, createDelegationTools, mayCall, reportsWait, SpaceSessionStore } from "./delegation.ts";
import { chatSessions, mayOpen, ThreadStore, workFilter, type ChatsView, type PrivateChatRow, type Thread } from "./threads";
import { createPupuTools } from "./tools";

/**
 * 我们自带的模型：DeepSeek 官方接口的 V4.1 Flash，支持工具调用，也能看截图。费用从 DeepSeek 开放平台的充值余额里扣，
 * key 用 `wrangler secret put DEEPSEEK_API_KEY` 设置。之前用的 Workers AI gpt-oss-120b 只认文字。
 */
const PUPU_MODEL_ID = "deepseek-flash";
/** 会话里记的是路由模型，每次调用按设置换成上面这个或者主人自己的（model/router.ts）。 */
const MODEL = ROUTER_MODEL;
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
/** 新手机登录的确认到期：没有事件，到点把手机上带按钮的通知换掉。 */
const SIGN_IN_JOB = "sign-in-expiry";

/** v0 只有一个用户，所以只有一个 Pupu 实例。 */

/** 空间里的一个子会话，任务卡和子会话页用。`busy`：派了活还没回报。 */
export type ChildView = {
  readonly session: string;
  readonly title: string;
  readonly createdAt: number;
  readonly busy: boolean;
  /** 子会话里有电脑动作在等批准。 */
  readonly waiting: boolean;
  readonly reportedAt: number | null;
  readonly summary: string;
};

/** 资料页：看得到的资料，和上传时能选的地方（id 为 null 是组织层）。 */
export type DocsView = { docs: DocMeta[]; places: { id: string | null; name: string }[] };

/** 状态里的空间：项目本身加上它的子会话。 */
export type ProjectView = Project & { readonly children: readonly ChildView[] };

export type PupuState = {
  readonly projects: readonly ProjectView[];
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
  /** 成员能选的预设头像，`url` 相对这个 Pupu 的网址。 */
  readonly avatarPresets: readonly { readonly id: string; readonly name: string; readonly url: string }[];
  /** Pupu 自己的头像，相对地址。null 是没换过，用各端自带的。 */
  readonly pupuAvatar: string | null;
  /** 用哪个模型，没有 key。`mayEdit`：这个人能不能改（只有创建者）。 */
  readonly model: { readonly current: ModelView; readonly mayEdit: boolean };
  /** 本人的通行密钥和能不能再加一把（见 passkeys.ts 的 `addRule`）。不是成员是 null。 */
  readonly passkeys: { readonly keys: readonly PasskeyView[]; readonly add: AddRule } | null;
};

/** 配对的结果。失败时带上给 Worker 回的状态码。 */
export type PairResult =
  | { readonly ok: true; readonly id: string; readonly name: string; readonly token: string }
  | { readonly ok: false; readonly status: 400 | 401 | 403 | 429; readonly error: string };

/** `/api/orgs`：这个账号在的 Pupu，和现在看的是哪个。 */
export type OrgList = {
  readonly current: string;
  readonly orgs: readonly {
    readonly id: string;
    readonly name: string;
    readonly creator: string | null;
    readonly members: number;
    readonly role: MemberRole;
    readonly current: boolean;
  }[];
  /** 还没有自己的 Pupu、又开放了名额：能填邀请码开一个。 */
  readonly canOpenOwn: boolean;
};

/** 切换列表里一个 Pupu 的样子，见 `Pupu.orgCard`。 */
export type OrgCard = {
  /** 创建者的名字。还没有创建者是 null。 */
  readonly creator: string | null;
  readonly members: number;
  /** 来看的人在这里的角色。不在名单上（被移除了、正在移除）是 null。 */
  readonly role: MemberRole | null;
};

/** 切进一个 Pupu 的结果，见 `Pupu.switchIn`。 */
export type SwitchGrant =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "refused"; readonly error: string };

/** 一张新凭据：明文发给对方，这边只存哈希。 */
type Minted = { readonly token: string; readonly hash: string };

const NOT_MEMBER = "你已经不在这个 Pupu 的成员名单上了。";
const AVATAR_NOT_MEMBER = "用 Google 登录之后才能换头像";
const AVATAR_CREATOR_ONLY = "只有创建者能换 Pupu 的头像";

/**
 * 一个用户的 Pupu：一个 Durable Object，里面跑 pi-durable。
 * 主会话是 pi 的根会话，每人的私聊和每个项目各开一个 pi 会话，共用这个对象的 SQLite。
 */
export class Pupu extends DurableObject<Env> {
  /** 这是不是第一个 Pupu。按 Durable Object 的 id 认，不靠 meta 里记的名字：第一个 Pupu 从来不记。 */
  readonly #root = this.ctx.id.equals(this.env.Pupu.idFromName(ROOT_PUPU));
  readonly store = new ProjectStore(this.ctx.storage.sql);
  readonly children = new SpaceSessionStore(this.ctx.storage.sql);
  readonly docs = new DocStore(this.ctx.storage.sql);
  readonly threads = new ThreadStore(this.ctx.storage.sql, this.store, (session) => {
    const child = this.children.bySession(session);
    const project = child && this.store.getProject(child.projectId);
    return project && { project, title: child.title };
  });
  readonly reports = new ReportStore(this.ctx.storage.sql);
  readonly computers = new ComputerStore(this.ctx.storage.sql);
  readonly devices = new DeviceStore(this.ctx.storage.sql);
  readonly members = new MemberStore(this.ctx.storage.sql);
  readonly avatars = new AvatarStore(this.ctx.storage.sql);
  readonly passkeys = new PasskeyStore(this.ctx.storage.sql);
  /** 后台命令跑完、离线的电脑连上了，要回到哪条对话。 */
  readonly followUps = new FollowUpStore(this.ctx.storage.sql);
  readonly connectors = new ConnectorStore(this.ctx.storage.sql);
  readonly usage = new UsageStore(this.ctx.storage.sql);
  /** 用哪个模型。 */
  readonly modelChoice = new ModelStore(this.ctx.storage.sql);
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
  /** 经电脑转发的模型请求。 */
  readonly relay = new ModelRelay({ send: (computerId, message) => this.bridge.sendModel(computerId, message) });
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
    pupu: () => (this.#root ? ROOT_PUPU : (this.store.meta("pupu") ?? null)),
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
  #signInDue: number | null = null;
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
  /** 每台电脑最近一次浏览器调用在哪个会话里，浏览器画面按它决定发给谁。只在内存里。 */
  readonly #browserSessions = new Map<string, string>();
  /** 交给人接手、还在等人接手完的电脑 → 哪条对话在等。人收起放大视图时叫醒它；Pupu 又动了浏览器就不等了。只在内存里。 */
  readonly #handovers = new Map<string, string>();
  /** 每台电脑最后一帧浏览器画面，刚连上、刚切过来的设备先拿到它，卡片不空着。只在内存里，不存。 */
  readonly #lastFrames = new Map<string, ServerMessage>();
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
                },
                thread.kind === "project" ? this.children.ofProject(thread.project.id) : [],
                this.docs.list(docScope(thread, this.store.listProjects()), "skill").slice(0, SKILL_LIST_LIMIT)
              );
            }
          }
        ],
        tools: [
          ...this.#pupuTools,
          ...this.#delegationTools,
          ...this.#docTools,
          ...createComputerTools(this.bridge),
          ...createConnectorTools(this.#connectorDeps)
        ],
        hooks: [
          hook(ToolTask, {
            beforeTool: (call, api, context) => {
              const session = String(api.conversationId);
              this.#callSessions.remember(call.id, session);
              // 空间主会话只做委派：先拦，被拦的调用不会生成审批卡。
              const blocked = mayCall(this.threads.of(session), call.name);
              if (blocked) return blocked;
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
              const thread = this.threads.of(session);
              if (thread?.kind === "child") this.#reportToSpace(thread, reply);
              const progressed = this.store.recordReply(session, reply);
              // 协调模式的主会话派完活就会回一句「派出去了」，这时从聊天转来的事还没做完，等子会话都回报了再报。
              const waiting = reportsWait(thread, this.children, this.#askedAt.get(session) ?? Date.now());
              const reported =
                !waiting &&
                this.reports.settle(
                  session,
                  this.#askedAt.get(session) ?? Date.now(),
                  asksUser(reply) ? "asking" : "done",
                  progressLine(reply),
                  Date.now()
                );
              const replied = Boolean(reply.trim()) && (thread?.kind === "main" || thread?.kind === "private");
              if (replied) this.threads.recordReply(thread, Date.now());
              if (progressed || reported || replied) this.#changed();
              return undefined;
            }
          })
        ]
      });
      // Workers 里没有本机环境变量，key 只从 secret 里拿。路由 provider 自己按路线换 key。
      const models = createModels({
        authContext: { env: async () => undefined, fileExists: async () => false }
      });
      const deepseek = deepseekProvider();
      const pupuModel = deepseek.getModels().find((model) => model.id === PUPU_MODEL_ID);
      if (!pupuModel) throw new Error(`pi-ai 里没有 ${PUPU_MODEL_ID}`);
      models.setProvider(
        routerProvider({
          choice: () => this.modelChoice.get(),
          // 只有用我们的模型（包括电脑离线时顶上）才过每日额度。
          pupu: {
            provider: withDailyLimit(deepseek, () => this.#refusal()),
            model: pupuModel,
            apiKey: () => this.env.DEEPSEEK_API_KEY
          },
          openai: openAICompletionsApi(),
          computerModel: (computerId) => this.bridge.modelOf(computerId),
          computerName: (computerId) => this.#computerName(computerId),
          relayFetch: (computerId) => this.relay.fetch(computerId)
        })
      );
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
    mayView: (device, computerId, ticket) =>
      mayViewDesktop(this.#actor(device), this.#ownerOf(computerId), this.#useDesktopTicket(ticket, device, computerId)),
    iceServers: () => iceServersFrom(this.env),
    deviceName: (device) => this.devices.list().find((row) => row.id === device)?.name ?? "别的设备",
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
      // 人在子会话里按了停：主会话那边也要知道，不然空间一直等它。
      const thread = this.threads.of(session);
      if (thread?.kind === "child") this.#reportToSpace(thread, STOPPED_SUMMARY, true);
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
    ],
    (session, device) => this.#framesFor(session, device)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 在构造时就接上，DO 重启后 pi 恢复的调用跑到桥上之前，审批已经能查了。
    this.bridge.approvedFor = (input) => this.gate.approved(input);
    this.bridge.onReady = (computerId) => {
      this.bridge.sendStatus(computerId, this.gate.statusFor(computerId));
      this.#computerArrived(computerId);
    };
    this.bridge.onUnavailable = (callId, computerId) => {
      const session = this.#callSessions.of(callId);
      if (session) this.followUps.wait(computerId ?? ANY_COMPUTER, session, Date.now());
    };
    this.bridge.onDetached = (callId, computerId, command) => {
      const session = this.#callSessions.of(callId);
      if (session) this.followUps.detached({ requestId: callId, session, computerId, command, startedAt: Date.now() });
    };
    this.bridge.onFinished = (computerId, frame) => {
      const call = this.followUps.finished(frame.requestId, computerId, Date.now());
      if (call) this.#notifyLater(call.session, finishedNotice(this.#computerName(computerId), call, frame, Date.now()));
    };
    this.bridge.onTakeback = (computerId) => this.gate.takeback(computerId);
    this.bridge.onDesktop = (computerId, session, message) => this.desktop.fromBridge(computerId, session, message);
    this.bridge.onGone = (computerId) => {
      this.desktop.bridgeGone(computerId);
      this.#browserSessions.delete(computerId);
      this.#handovers.delete(computerId);
      this.#lastFrames.delete(computerId);
    };
    this.bridge.onBrowserFrame = (computerId, frame) => this.#browserFrame(computerId, frame);
    this.bridge.onHandback = (computerId) => this.#handedBack(computerId);
    this.bridge.onTakeover = (computerId, requestId) => {
      const session = this.#sessionOfCall(requestId);
      if (session) this.#handovers.set(computerId, session);
      void pushTakeover({
        apns: this.#apnsClient(),
        tokens: this.push.tokens("alert"),
        to: this.#phonesOf(computerId),
        requestId,
        computerName: this.#computerName(computerId),
        now: Date.now(),
        remove: (token) => this.push.remove(token),
        log: (message) => console.warn(message)
      }).catch((error: unknown) => console.warn(`接手提醒没推出去：${String(error)}`));
    };
    this.bridge.onModel = (computerId, message) => this.relay.receive(computerId, message);
    this.bridge.onModelGone = (computerId) => this.relay.gone(computerId);
    // 不等 onStart：没启动 pi 的 RPC（登录、配对、移除成员）改了电脑，网页和灵动岛也要跟上。
    this.bridge.onChange = () => {
      this.sockets.broadcast({ type: "computers_changed" });
      this.#activityChanged();
    };
    this.bridge.onActivity = () => {
      this.#noteBrowserCalls();
      this.#activityChanged();
    };
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
    // 子会话出错也要报回主会话，不然空间一直等它。
    const thread = this.threads.of(session);
    if (thread?.kind === "child") this.#reportToSpace(thread, summary);
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
    this.#scheduleSignInExpiry();
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
        const thread = session ? this.threads.of(session) : undefined;
        return thread?.kind === "project" || thread?.kind === "child"
          ? { id: thread.project.id, name: thread.project.name }
          : null;
      }
    });
  }

  /**
   * 浏览器画面只发给看得到这件事的人：帧上不带调用 id，按这台电脑上最近一次浏览器调用所在的会话算。
   * 一次也没见过的电脑不发（比如云端刚重启、Pupu 还没再动浏览器），等下一步浏览器调用。
   */
  #browserFrame(computerId: string, frame: BrowserFrame): void {
    this.#noteBrowserCalls();
    const session = this.#browserSessions.get(computerId);
    if (!session) return;
    const message: ServerMessage = {
      type: "browser_frame",
      computerId,
      session,
      jpeg: frame.jpeg,
      width: frame.width,
      height: frame.height,
      url: frame.url,
      title: frame.title,
      at: frame.at
    };
    this.#lastFrames.set(computerId, message);
    this.sockets.broadcastBy((device) => (this.#seenBy(this.#viewer(device))(session, computerId) ? message : null));
  }

  /** 刚打开这条对话的设备先拿到各台电脑最后一帧（只给这条对话的、这个人看得到的），卡片不用等下一帧。 */
  #framesFor(session: string, device: string | null): ServerMessage[] {
    const sees = this.#seenBy(this.#viewer(device));
    return [...this.#lastFrames.entries()].flatMap(([computerId, message]) =>
      message.type === "browser_frame" && message.session === session && sees(session, computerId) ? [message] : []
    );
  }

  /** 浏览器调用一开始就记下它在哪个会话：一步做得快，第一帧到的时候调用可能已经结束了。 */
  #noteBrowserCalls(): void {
    for (const call of this.bridge.running()) {
      if (call.action.kind !== "browser") continue;
      // Pupu 自己又动了浏览器（人在对话里说过好了），不用再等人收起放大视图。
      if (call.action.op !== "show") this.#handovers.delete(call.computerId);
      const session = this.#sessionOfCall(call.callId);
      if (session) this.#browserSessions.set(call.computerId, session);
    }
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

  /** 最早到期的那条等批登录，到点再看一次。 */
  #scheduleSignInExpiry(): void {
    const waiting = this.signIns.pending(Date.now());
    const due = waiting.length === 0 ? null : Math.min(...waiting.map((row) => row.expiresAt));
    if (due === this.#signInDue) return;
    this.#signInDue = due;
    const { jobs } = this.lifecycle;
    const scheduled = due === null ? jobs.cancel(SIGN_IN_JOB) : jobs.push({ id: SIGN_IN_JOB, fn: SIGN_IN_JOB, time: due + 500 });
    this.ctx.waitUntil(scheduled.then(() => undefined, (error) => console.warn("登录确认的到期排不上", error)));
  }

  /** Lifecycle 的任务队列到点了。 */
  onJob({ job }: LifecycleJobContext): void {
    if (job.fn === SIGN_IN_JOB) {
      this.#signInDue = null;
      this.#approvalsChanged([]);
      return;
    }
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
    const waitingSessions = new Set(this.approvals.pending(Date.now()).map((row) => row.session));
    return {
      projects: this.store
        .listProjects()
        .filter((project) => maySeeSpace(project, viewer))
        .map((project) => ({
          ...project,
          children: this.children.ofProject(project.id).map((child) => ({
            session: child.session,
            title: child.title,
            createdAt: child.createdAt,
            busy: child.busySince !== null,
            waiting: waitingSessions.has(child.session),
            reportedAt: child.reportedAt,
            summary: child.summary
          }))
        })),
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
      avatarPresets: AVATAR_PRESETS.map((preset) => ({ ...preset, url: `/avatars/${preset.id}.png` })),
      pupuAvatar: pupuAvatarUrl(this.store.meta(PUPU_AVATAR_META) ?? null),
      model: { current: modelView(this.modelChoice.get()), mayEdit: mayChangeModel(this.#actor(current)) },
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
    const projects = new Map(this.store.listProjects().map((project) => [project.id, project]));
    // 空间后来收窄了：以前报到这条聊天的卡，这条聊天的受众不再都看得到，就不再给。
    const rows = readableReports(this.reports.visible(chatSessions(own)), projects, (session) => this.threads.of(session));
    return reportCards(rows, (id) => projects.get(id)?.name);
  }

  /**
   * `device` 打开了这个项目：报到他看得到的聊天里的结果都算看过，那几张卡不再合在一起。
   * 主会话的卡谁打开都算；私聊转去的卡只有本人打开才算。
   */
  async markProjectSeen(projectId: string, device: string | null = null): Promise<boolean> {
    const project = this.store.getProject(projectId);
    const viewer = this.#viewer(device);
    if (!project || !maySeeSpace(project, viewer)) return false;
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

  // ---- 一个账号在好几个 Pupu 里（docs/协作方案.md 第 1、9 节）----

  /** 切换列表里这个 Pupu 的样子：创建者是谁、几个人。`email` 是来看的人，看他在不在。 */
  async orgCard(email: string): Promise<OrgCard> {
    const creator = this.members.creator();
    const member = this.members.byEmail(email);
    return { creator: creator ? memberName(creator) : null, members: this.members.list().length, role: member?.role ?? null };
  }

  /** 发请求的设备是谁的、什么设备：切到别的 Pupu 时，那边按这个给同一个人发同一种设备。 */
  async whoIs(device: string | null): Promise<{ email: string; name: string | null; kind: DeviceKind; deviceName: string } | null> {
    if (device === null) return null;
    const row = this.devices.list().find((each) => each.id === device);
    const member = row?.memberId ? this.members.byId(row.memberId) : undefined;
    if (!row || row.revokedAt !== null || !member) return null;
    return { email: member.email, name: member.name, kind: row.kind, deviceName: row.name };
  }

  /**
   * 同一个人从别的 Pupu 切进来。目录已经核对过他在这里（`home`）。门照这个 Pupu 自己的来：
   * - 浏览器和电脑 App 的窗口直接发一张同种的凭据（和 Google 登录发的一样，都只认他是不是成员）；
   * - 手机发一个一次性的码，手机带自己的 verifier 去 `/api/auth/redeem` 换，走 `redeemStep`：
   *   这里已经有手机了，就要已有的手机点允许，和新手机用 Google 登录一样。
   */
  async switchIn(input: {
    email: string;
    displayName: string | null;
    kind: DeviceKind;
    deviceName: string;
    challenge: string | null;
    home: Home;
  }): Promise<SwitchGrant> {
    if (input.home.pupu !== ROOT_PUPU) this.store.setMeta("pupu", input.home.pupu);
    const member = this.#admit(input.email, input.displayName, Date.now(), input.home.founder);
    if (!member) return { kind: "refused", error: NOT_MEMBER };
    if (input.kind !== "phone") {
      const credential = await this.#credential(input.kind, input.deviceName, member.id);
      return credential ? { kind: "token", token: credential.token } : { kind: "refused", error: NOT_MEMBER };
    }
    if (!input.challenge) return { kind: "refused", error: "手机切换要带 challenge" };
    const code = scopedCredential(this.#pupu(), randomToken());
    this.signIns.add({
      codeHash: await tokenHash(code),
      client: "phone",
      email: member.email,
      challenge: input.challenge,
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
      const row = this.computers.insert({
        name: name || "电脑",
        ownerId: input.memberId,
        tokenHash: minted.hash,
        policy: NEW_COMPUTER_POLICY
      });
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

  /**
   * 换模型。只有创建者能改：用谁的模型、内容发到哪，是整个 Pupu 的事。
   * 自带 key 先试一次能不能调工具，不过不存；经电脑转发的在那台电脑上存的时候已经试过。
   */
  async setModel(input: unknown, device: string | null = null): Promise<{ ok: true } | { ok: false; status: 400 | 403; error: string }> {
    await this.lifecycle.start();
    if (!mayChangeModel(this.#actor(device))) return { ok: false, status: 403, error: "只有创建者能换模型。" };
    const parsed = parseChoice(input, this.modelChoice.get());
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const choice = parsed.choice;
    if (choice.source === "computer" && !this.computers.list().some((row) => row.id === choice.computerId)) {
      return { ok: false, status: 400, error: "没有这台电脑。" };
    }
    if (choice.source === "key") {
      const probe = await probeModel({ baseUrl: choice.baseUrl, apiKey: choice.apiKey, model: choice.model });
      if (!probe.ok) return { ok: false, status: 400, error: probe.error };
    }
    this.modelChoice.set(choice);
    this.sockets.broadcast({ type: "computers_changed" });
    return { ok: true };
  }

  /** 改分级：主人在哪个端都能改，不用再确认；别人只能往严里改。见 `mayChangePolicy`。 */
  async setComputerPolicy(id: string, policy: string, device: string | null = null): Promise<"ok" | "missing" | "owner_only"> {
    await this.lifecycle.start();
    if (!isComputerPolicy(policy)) throw new Error("没有这个分级");
    const computer = this.computers.list().find((row) => row.id === id);
    if (!computer) return "missing";
    if (!mayChangePolicy(computer.policy, policy, this.#actor(device), computer.ownerId)) return "owner_only";
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
    this.followUps.forgetComputer(id);
    this.bridge.onChange();
    return true;
  }

  // ---- 电脑那边晚些才有的消息（bridge/followups.ts）----

  /** 刚才因为它离线没做成事的对话，叫醒它们。 */
  #computerArrived(computerId: string): void {
    const sessions = this.followUps.arrived(computerId, Date.now());
    if (sessions.length === 0) return;
    const text = `「${this.#computerName(computerId)}」连上了。刚才因为电脑不在线没做成的事，现在可以接着做；已经不需要了就不用做。`;
    for (const session of sessions) this.#notifyLater(session, text);
  }

  /**
   * 电脑前的人接手完浏览器（登录、过验证码），在 Pupu 主窗口里收起了放大视图。等着的那条对话自己接着做，
   * 人不用再回来说一声。只叫醒一次：没在等（Pupu 没交给人、或者已经接着做了）就不管。
   */
  #handedBack(computerId: string): void {
    const session = this.#handovers.get(computerId);
    if (!session) return;
    this.#handovers.delete(computerId);
    this.#notifyLater(session, handbackNotice(this.#computerName(computerId)));
  }

  #computerName(computerId: string): string {
    return this.bridge.list().find((computer) => computer.id === computerId)?.name ?? "电脑";
  }

  #notifyLater(session: string, text: string): void {
    this.ctx.waitUntil(this.#notify(session, text).catch((error) => console.warn("系统消息没送进对话", error)));
  }

  /** 以系统消息叫醒这条对话：闲着就开一轮，正忙就排在这一轮后面。对话没了就算了。 */
  async #notify(session: string, text: string): Promise<void> {
    await this.lifecycle.start();
    if (!this.threads.of(session)) {
      this.followUps.forgetSession(session);
      return;
    }
    await this.harness.session(session).submit(noticeMessage(text), { whenBusy: "followUp" });
    this.store.touchSession(session);
    this.#changed();
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
    // 已经有自己的 Pupu、或者在别的 Pupu 里的人也能邀请：一个账号能在好几个 Pupu 里。
    const assignment = await directory(this.env).assign(email, this.#pupu());
    if (assignment !== "ok") return assignment;
    if (!this.members.invite(email, actor?.memberId ?? null, Date.now())) return "exists";
    this.#devicesChanged();
    return "ok";
  }

  /**
   * 创建者移除一个成员，步骤见 members.ts 的 `removeMember`。他连的账号有一个断不开是 failed，
   * 他留在名单上、登录不了，创建者再点一次接着做完。
   * 他的个人入口留着：挂在他的 id 上，id 不再发出去，谁也打不开，创建者也一样；再邀请回来用回这个 id，就回来了。
   * 只断这一个 Pupu，他自己的和别的 Pupu 不动。
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
        leaveSpaces: async (memberId) => {
          for (const project of this.store.listProjects()) {
            if (project.members.includes(memberId)) await this.store.removeMember(this.#sqlWriter, project.id, memberId);
          }
        },
        release: (email) => directory(this.env).release(email, this.#pupu())
      },
      Date.now()
    );
    if (result === "ok") {
      this.passkeys.revokeMember(id, Date.now());
      this.avatars.remove(id);
    }
    this.#devicesChanged();
    return result;
  }

  /**
   * 换头像：`me` 是发请求的设备的主人自己（见 avatars.ts），`pupu` 是 Pupu 自己的，只有创建者能换。
   * 选一个预设，或者 null 换回默认（成员是名字的第一个字，Pupu 是自带的图）。
   */
  async setAvatar(
    device: string | null,
    preset: string | null,
    target: AvatarTarget = "me"
  ): Promise<"ok" | "not_member" | "creator_only" | "invalid"> {
    const key = this.#avatarKey(device, target);
    if (key === "not_member" || key === "creator_only") return key;
    if (preset !== null && !isPreset(preset)) return "invalid";
    this.#saveAvatarChoice(target, key, preset === null ? null : formatChoice({ kind: "preset", id: preset }));
    this.avatars.remove(key);
    this.#devicesChanged();
    return "ok";
  }

  /** 上传头像。客户端已经裁成方形缩小了，这边只验，规则见 avatars.ts 的 `checkUpload`。 */
  async uploadAvatar(
    device: string | null,
    bytes: Uint8Array,
    target: AvatarTarget = "me"
  ): Promise<UploadCheck | { ok: false; error: "not_member" | "creator_only" }> {
    const key = this.#avatarKey(device, target);
    if (key === "not_member" || key === "creator_only") return { ok: false, error: key };
    const check = checkUpload(bytes);
    if (!check.ok) return check;
    const now = Date.now();
    this.avatars.put(key, check.type, bytes, now);
    this.#saveAvatarChoice(target, key, formatChoice({ kind: "upload", at: now }));
    this.#devicesChanged();
    return check;
  }

  /** 换谁的头像：成员 id，或者 Pupu 自己的键。 */
  #avatarKey(device: string | null, target: AvatarTarget): string | "not_member" | "creator_only" {
    if (target === "pupu") {
      const actor = this.#actor(device);
      return actor?.role === "creator" ? PUPU_AVATAR_KEY : "creator_only";
    }
    return this.#viewer(device) ?? "not_member";
  }

  #saveAvatarChoice(target: AvatarTarget, key: string, value: string | null): void {
    if (target === "pupu") this.store.setMeta(PUPU_AVATAR_META, value ?? "");
    else this.members.setAvatar(key, value);
  }

  /** Pupu 自己上传的头像。同一个 Pupu 的设备都能看。 */
  async pupuAvatar(): Promise<StoredAvatar | null> {
    return this.avatars.get(PUPU_AVATAR_KEY) ?? null;
  }

  /** 一个成员上传的头像。同一个 Pupu 的设备都能看。 */
  async avatarOf(memberId: string): Promise<StoredAvatar | null> {
    if (!this.members.byId(memberId)) return null;
    return this.avatars.get(memberId) ?? null;
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

  /** 网页开远程桌面换来的票，见 `desktopTicket`。 */
  readonly #desktopTickets = new Map<
    string,
    { readonly device: string | null; readonly computerId: string; readonly memberId: string; readonly expiresAt: number }
  >();

  /**
   * 网页或电脑 App 要开远程桌面：主人刚用通行密钥为这台电脑确认过，换一张一次性的票，马上拿去连
   * `/api/desktop/:id?ticket=`。票只在内存里，30 秒过期，用一次就没了：信令断了要人再按一次，
   * 不让一次确认变成之后谁都能悄悄连回来的通行证。没主人的电脑、别人的电脑都换不到。
   */
  async desktopTicket(device: string | null, computerId: string, proof: PasskeyProof | null): Promise<string | null> {
    const owner = this.computers.list().find((row) => row.id === computerId)?.ownerId ?? null;
    if (owner === null) return null;
    if ((await this.#proven(device, { kind: "desktop", computerId }, proof)) !== owner) return null;
    const now = Date.now();
    for (const [key, row] of this.#desktopTickets) if (row.expiresAt <= now) this.#desktopTickets.delete(key);
    const ticket = crypto.randomUUID();
    this.#desktopTickets.set(ticket, { device, computerId, memberId: owner, expiresAt: now + 30_000 });
    return ticket;
  }

  /** 用掉一张票：是这台设备为这台电脑换的、没过期，返回确认的成员。 */
  #useDesktopTicket(ticket: string | null, device: string | null, computerId: string): string | null {
    if (!ticket) return null;
    const row = this.#desktopTickets.get(ticket);
    this.#desktopTickets.delete(ticket);
    if (!row || row.expiresAt <= Date.now() || row.device !== device || row.computerId !== computerId) return null;
    return row.memberId;
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
   * `/api/connectors/done`，见 `finishConnector`。谁能连见 members.ts 的 `mayConnect`；`device` 是 null 是本机开发。
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
    if (!mayConnect(actor)) {
      const error = actor?.kind === "phone" ? "这台手机不属于哪个成员，先用 Google 登录" : "连账号要在手机 App 上做";
      return { ok: false, status: 403, error };
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

  readonly #pupuTools = createPupuTools({
    store: this.store,
    threadOf: (session) => this.threads.of(session),
    createProject: (input) => this.#createProject(input),
    handOff: (project, task, operationId, origin) => this.#handOff(project, task, operationId, origin)
  });

  /** 空间的密级、成员、模式走 pi 的写队列，见 projects.ts 的 `SpaceWriter`。 */
  readonly #sqlWriter = new DurableObjectSqliteDatabase(this.ctx.storage);

  /** 共享资料和 skill 的工具，按会话的受众筛，见 docs.ts、docs-tools.ts。 */
  readonly #docTools = createDocTools({
    docs: this.docs,
    threadOf: (session) => this.threads.of(session),
    spaces: () => this.store.listProjects(),
    now: () => Date.now(),
    changed: () => this.#changed()
  });

  /** 委派工具。`deferred`，只有切成协调模式的主会话会被提供，见 delegation.ts。 */
  readonly #delegationTools = createDelegationTools({
    threadOf: (session) => this.threads.of(session),
    children: this.children,
    createSession: async () => (await this.harness.sessions.create()).id,
    submit: async (session, text, operationId) => {
      await this.harness.session(session).submit(text, { whenBusy: "followUp", operationId });
    },
    stop: (session) => this.harness.session(session).abort(),
    now: () => Date.now(),
    changed: () => this.#changed()
  });

  /**
   * 子会话回完一轮，把结果送回空间的主会话。人直接在子会话里说的也报。
   * 用这一轮的提问时间去重，重启后重放不会报两次。不在钩子里等提交：钩子可能在 pi 的事务里。
   */
  #reportToSpace(thread: Extract<Thread, { kind: "child" }>, reply: string, stopped = false): void {
    const run = this.#askedAt.get(thread.session) ?? Date.now();
    // 停下时 pi 把排着的也撤了，直接空出来。
    this.children.markIdle(thread.session, stopped ? undefined : run);
    this.children.markReported(thread.session, Date.now(), progressLine(reply));
    this.ctx.waitUntil(
      this.harness
        .session(thread.project.session)
        .submit(childReport(thread.title, reply), {
          whenBusy: "followUp",
          operationId: `child-report:${thread.session}:${run}`
        })
        .catch((error) => console.warn("子会话回报失败", error))
    );
  }

  /** 成员在界面上建空间：L3，只有他自己和 Pupu。不是成员（本机开发没登录）的建不了。 */
  async createSpace(input: { name: string; goal: string }, device: string | null = null): Promise<Project | null> {
    await this.lifecycle.start();
    const owner = this.#viewer(device);
    if (owner === null) return null;
    const name = input.name.trim();
    if (!name) throw new Error("空间名不能为空");
    const session = await this.harness.sessions.create();
    const project = await this.store.createSpace(
      this.#sqlWriter,
      { session: session.id, name, goal: input.goal.trim(), background: "", ownerId: owner },
      Date.now()
    );
    this.#changed();
    return project;
  }

  /** 界面上的资料列表：这个人看得到的资料，和他能把资料放到哪。 */
  async listDocs(device: string | null = null): Promise<DocsView> {
    await this.lifecycle.start();
    const viewer = this.#viewer(device);
    const spaces = this.store.listProjects();
    const visible = spaces.filter((space) => viewerTarget(viewer, space.id, spaces) !== undefined);
    return {
      docs: this.docs.list(viewerScope(viewer, spaces)),
      places: [{ id: null, name: "组织" }, ...visible.map((space) => ({ id: space.id, name: space.name }))]
    };
  }

  async readDoc(id: string, device: string | null = null): Promise<Doc | undefined> {
    await this.lifecycle.start();
    return this.docs.read(viewerScope(this.#viewer(device), this.store.listProjects()), id);
  }

  /** 人上传一份资料。放到哪由他选，只能是他看得到的地方；算他写的。 */
  async uploadDoc(
    input: { title: string; summary: string; body: string; kind: DocKind; spaceId: string | null; operation: string },
    device: string | null = null
  ): Promise<DocMeta | "invalid" | "forbidden"> {
    await this.lifecycle.start();
    const viewer = this.#viewer(device);
    const title = input.title.trim();
    if (!title || !input.body.trim() || input.body.length > DOC_BODY_LIMIT) return "invalid";
    const target = viewerTarget(viewer, input.spaceId, this.store.listProjects());
    if (target === undefined) return "forbidden";
    const meta = this.docs.write(
      {
        spaceId: target,
        kind: input.kind,
        title,
        summary: input.summary.trim(),
        body: input.body,
        authorId: viewer,
        fromSession: null,
        operation: `upload:${viewer ?? "local"}:${input.operation}`
      },
      Date.now()
    );
    this.#changed();
    return meta;
  }

  /** 主人改空间：拉人、移人、改密级、切模式。规则见 spaces.ts。受众变了，开着的连接重新过一遍。 */
  async changeSpace(projectId: string, change: SpaceChange, device: string | null = null): Promise<SpaceVerdict> {
    await this.lifecycle.start();
    const project = this.store.getProject(projectId);
    const verdict = checkSpaceChange(project, this.#viewer(device), change, (id) => this.members.byId(id) !== undefined);
    if (verdict !== "ok" || !project) return verdict;
    const now = Date.now();
    switch (change.kind) {
      case "add":
        await this.store.addMember(this.#sqlWriter, projectId, change.memberId, this.#viewer(device)!, now);
        break;
      case "remove":
        await this.store.removeMember(this.#sqlWriter, projectId, change.memberId);
        break;
      case "level":
        await this.store.setLevel(this.#sqlWriter, projectId, change.level, now);
        break;
      case "mode":
        await this.setSpaceMode(projectId, change.mode);
        break;
    }
    this.sockets.revalidate();
    this.#changed();
    this.#activityChanged();
    return "ok";
  }

  /**
   * 把空间切成协调模式：主会话只留委派工具。主人在界面上切（`changeSpace`），本机开发另有 `/api/projects/:id/mode`。
   */
  async setSpaceMode(projectId: string, mode: SpaceMode): Promise<boolean> {
    await this.lifecycle.start();
    const project = this.store.getProject(projectId);
    if (!project) return false;
    await this.store.setMode(this.#sqlWriter, projectId, mode, Date.now());
    const pi = await this.harness.pi();
    const conversation = await pi.conversation(project.session as never, BACKGROUND_CONTEXT);
    if (!conversation) return false;
    const tools = [...this.#pupuTools, ...this.#delegationTools, ...this.#docTools].filter((tool) => COORDINATOR_TOOLS.includes(tool.name));
    await conversation.configure(
      mode === "coordinator" ? { modelTools: tools } : { modelTools: { remove: [] } },
      BACKGROUND_CONTEXT
    );
    this.#changed();
    return true;
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

  async memberships(email: string): Promise<Home[]> {
    return this.store.memberships(email);
  }

  async openOwn(email: string, code: string): Promise<Home | "exists" | "wrong" | "full" | "limited"> {
    return this.store.openOwn(email, code, seatsFrom(this.env), Date.now());
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
  const token = cookiesOf(request).get(TOKEN_COOKIE);
  return token ? { token, cookie: true } : null;
}

function cookiesOf(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (value && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/**
 * 网页和电脑 App 的窗口靠 cookie：`pupu_token` 是登录时发的那张，切到别的 Pupu 拿到的放在 `pupu_org_<id>`，
 * `pupu_active` 记着现在看的是哪个。按「选中的、登录的、其余的」顺序试，第一张还认的就用它：
 * 在选中的那个 Pupu 里被移除了，自动回到别的，不会整页 401。
 */
function cookieCandidates(request: Request): { name: string; token: string }[] {
  const cookies = cookiesOf(request);
  const active = cookies.get(ACTIVE_COOKIE);
  const all: { name: string; token: string }[] = [];
  const push = (name: string) => {
    const token = cookies.get(name);
    if (token && !all.some((each) => each.name === name)) all.push({ name, token });
  };
  if (active && ORG_ID.test(active)) push(orgCookieName(active));
  push(TOKEN_COOKIE);
  for (const name of cookies.keys()) if (name.startsWith(ORG_COOKIE_PREFIX)) push(name);
  return all;
}

const ACTIVE_COOKIE = "pupu_active";
const ORG_COOKIE_PREFIX = "pupu_org_";
const ORG_ID = /^(me|[0-9a-f]{32})$/;

function orgCookieName(pupu: string): string {
  return `${ORG_COOKIE_PREFIX}${pupu}`;
}

function cookieHeader(url: URL, name: string, value: string | null): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const body = value ? `${value}; Max-Age=31536000` : "; Max-Age=0";
  return `${name}=${body}; Path=/; HttpOnly${secure}; SameSite=Lax`;
}

type PupuStub = DurableObjectStub<Pupu>;

/**
 * 发请求的设备和它所在的 Pupu。`device` 是 null：本机开发、没设访问口令、什么凭据都没带。
 */
type Caller = {
  readonly device: string | null;
  readonly pupu: PupuStub;
  readonly name: string;
  /** 凭据是哪个 cookie 里的。用 Authorization 头或者本机没带凭据是 null。 */
  readonly cookie: string | null;
};

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
  if (credential && !credential.cookie) return deviceOf(env, credential.token, null);
  const candidates = cookieCandidates(request);
  if (candidates.length > 0) {
    // cookie 是浏览器自己带上的：别的网站发起的请求和 WebSocket（Origin 对不上）不认。
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== new URL(request.url).origin) return null;
    for (const candidate of candidates) {
      const caller = await deviceOf(env, candidate.token, candidate.name);
      if (caller) return caller;
    }
    return null;
  }
  return isLocal(request) && !env.ACCESS_TOKEN ? { device: null, pupu: root(env), name: ROOT_PUPU, cookie: null } : null;
}

async function deviceOf(env: Env, token: string, cookie: string | null): Promise<Caller | null> {
  const name = pupuOfCredential(token);
  const home = await knownPupu(env, name);
  const device = await home?.authenticateDevice(token);
  return home && device ? { device, pupu: home, name, cookie } : null;
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

/** 后台命令跑完时送进对话的那句话。 */
function finishedNotice(
  computer: string,
  call: { readonly command: string; readonly startedAt: number },
  frame: { readonly code: number | null; readonly outputPath: string; readonly tail: string; readonly stopped?: "user" | "cloud" },
  now: number
): string {
  const minutes = Math.max(1, Math.round((now - call.startedAt) / 60_000));
  const how =
    frame.stopped === "user"
      ? "被用户在电脑上停掉了"
      : frame.stopped === "cloud"
        ? "被停掉了"
        : frame.code === 0
          ? "跑完了，退出码 0"
          : frame.code === null
            ? "结束了，没有退出码"
            : `跑完了，退出码 ${frame.code}`;
  const tail = frame.tail.trim();
  return [
    `「${computer}」上放到后台的命令${how}（大约跑了 ${minutes} 分钟）：`,
    "```",
    call.command.length > 300 ? `${call.command.slice(0, 300)}…` : call.command,
    "```",
    `完整输出在 ${frame.outputPath}。${tail ? "最后一段：" : "没有输出。"}`,
    ...(tail ? ["```", tail, "```"] : [])
  ].join("\n");
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
  const headers = new Headers();
  for (const cookie of signedInCookies(url, request, result.token)) headers.append("Set-Cookie", cookie);
  return Response.json({ id: result.id, name: result.name }, { headers });
}

/**
 * 这个浏览器重新登录（或配对）了：种下新凭据，切换时留下的别的 Pupu 的 cookie 和选中的都清掉。
 * 换了个 Google 账号登录时，上一个人在别的 Pupu 里的凭据不能留着被用上。
 */
function signedInCookies(url: URL, request: Request, token: string): string[] {
  const stale = [...cookiesOf(request).keys()].filter((name) => name.startsWith(ORG_COOKIE_PREFIX) || name === ACTIVE_COOKIE);
  return [deviceCookie(url, token), ...stale.map((name) => cookieHeader(url, name, null))];
}

/** 这个账号在的所有 Pupu：目录里记的，加上第一个 Pupu（它的老成员不在目录里）。 */
async function orgsOf(env: Env, email: string): Promise<Home[]> {
  const homes = await directory(env).memberships(email);
  if (!homes.some((each) => each.pupu === ROOT_PUPU) && (await root(env).admits(email))) {
    homes.push({ pupu: ROOT_PUPU, founder: false });
  }
  return homes;
}

/** 切换列表。只列他还在名单上的；自己开的叫「我的 Pupu」，排第一。 */
async function orgList(env: Env, caller: Caller): Promise<OrgList> {
  const me = await caller.pupu.whoIs(caller.device);
  if (!me) return { current: caller.name, orgs: [], canOpenOwn: false };
  const homes = await orgsOf(env, me.email);
  const cards = await Promise.all(homes.map((home) => pupuNamed(env, home.pupu).orgCard(me.email)));
  const orgs = homes
    .map((home, index) => ({ home, card: cards[index] }))
    .flatMap(({ home, card }) => (card?.role ? [{ home, card, role: card.role }] : []))
    .map(({ home, card, role }) => ({
      id: home.pupu,
      name: role === "creator" ? "我的 Pupu" : `${card.creator ?? "别人"}的 Pupu`,
      creator: card.creator,
      members: card.members,
      role,
      current: home.pupu === caller.name
    }))
    .sort((a, b) => Number(b.role === "creator") - Number(a.role === "creator"));
  return {
    current: caller.name,
    orgs,
    canOpenOwn: seatsFrom(env) > 0 && !orgs.some((each) => each.role === "creator")
  };
}

/**
 * 切到 `home`。网页和电脑 App 的窗口（cookie）：那个 Pupu 的 cookie 还认就只改选中的，没有才让那边发一张新的。
 * 手机（Authorization 头）：手机自己存着各个 Pupu 的凭据，来这里说明没有，那边发一个码，手机去换。
 */
async function switchTo(
  request: Request,
  env: Env,
  url: URL,
  caller: Caller,
  me: { email: string; name: string | null; kind: DeviceKind; deviceName: string },
  home: Home,
  challenge: string | null
): Promise<Response> {
  const active = cookieHeader(url, ACTIVE_COOKIE, home.pupu);
  if (caller.cookie !== null) {
    const cookies = cookiesOf(request);
    for (const name of [orgCookieName(home.pupu), TOKEN_COOKIE]) {
      const token = cookies.get(name);
      const found = token && pupuOfCredential(token) === home.pupu ? await deviceOf(env, token, name) : null;
      // 留着的 cookie 还得是同一个人的：换过账号登录的浏览器里，可能有上一个人的。
      if (found && (await found.pupu.whoIs(found.device))?.email === emailKey(me.email)) {
        return Response.json({ ok: true, org: home.pupu }, { headers: { "Set-Cookie": active } });
      }
    }
  }
  const grant = await pupuNamed(env, home.pupu).switchIn({
    email: me.email,
    displayName: me.name,
    kind: me.kind,
    deviceName: me.deviceName,
    challenge,
    home
  });
  if (grant.kind === "refused") return Response.json({ error: grant.error }, { status: 403 });
  if (grant.kind === "code") return Response.json({ org: home.pupu, code: grant.code });
  if (caller.cookie === null) return Response.json({ org: home.pupu, token: grant.token });
  const headers = new Headers();
  headers.append("Set-Cookie", cookieHeader(url, orgCookieName(home.pupu), grant.token));
  headers.append("Set-Cookie", active);
  return Response.json({ ok: true, org: home.pupu }, { headers });
}

async function handleApi(request: Request, env: Env, url: URL, caller: Caller) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/state" && method === "GET") {
    return Response.json(await caller.pupu.state(caller.device));
  }
  if (pathname === "/api/orgs" && method === "GET") {
    return Response.json(await orgList(env, caller));
  }
  if ((pathname === "/api/orgs/switch" || pathname === "/api/orgs/own") && method === "POST") {
    const me = await caller.pupu.whoIs(caller.device);
    if (!me) return Response.json({ error: "要先用 Google 登录" }, { status: 403 });
    const body = await readJson<{ org?: unknown; code?: unknown; challenge?: unknown }>(request);
    let home: Home | undefined;
    if (pathname === "/api/orgs/own") {
      const opened = await directory(env).openOwn(me.email, typeof body.code === "string" ? body.code : "");
      if (opened === "wrong") return Response.json({ error: INVITE_WRONG }, { status: 400 });
      if (opened === "limited") return Response.json({ error: "填错的次数太多了，过一小时再试" }, { status: 429 });
      if (opened === "full") return Response.json({ error: SEATS_FULL }, { status: 409 });
      if (opened === "exists") return Response.json({ error: "你已经有自己的 Pupu 了" }, { status: 409 });
      home = opened;
    } else {
      const org = typeof body.org === "string" ? body.org : "";
      if (!ORG_ID.test(org)) return Response.json({ error: "没有这个 Pupu" }, { status: 400 });
      home = (await orgsOf(env, me.email)).find((each) => each.pupu === org);
      if (!home) return Response.json({ error: "你不在这个 Pupu 里" }, { status: 403 });
    }
    return switchTo(request, env, url, caller, me, home, typeof body.challenge === "string" ? body.challenge : null);
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
    const headers: HeadersInit =
      id === caller.device && caller.cookie ? { "Set-Cookie": cookieHeader(url, caller.cookie, null) } : {};
    return Response.json({ ok: true }, { headers });
  }
  const policy = pathname.match(/^\/api\/computers\/([^/]+)\/policy$/);
  if (policy && method === "POST") {
    // 老客户端还会带 proof，不用了，忽略。
    const body = await readJson<{ policy?: string }>(request);
    const result = await caller.pupu.setComputerPolicy(decodeURIComponent(policy[1] ?? ""), String(body.policy ?? ""), caller.device);
    if (result === "missing") return Response.json({ error: "没有这台电脑" }, { status: 404 });
    if (result === "owner_only") {
      return Response.json({ error: "别人的电脑只能往严里改，放宽要电脑主人自己改" }, { status: 403 });
    }
    return Response.json({ ok: true });
  }
  if (pathname === "/api/model" && method === "POST") {
    const result = await caller.pupu.setModel(await readJson<unknown>(request), caller.device);
    return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: result.status });
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
    if (result === "full") return Response.json({ error: SEATS_FULL }, { status: 409 });
    if (result === "creator_phone_only") {
      return Response.json({ error: "邀请成员要创建者亲手确认：在手机 App 上做，或者用通行密钥" }, { status: 403 });
    }
    return Response.json({ ok: true });
  }
  const avatarTarget = pathname === "/api/me/avatar" ? "me" : pathname === "/api/pupu/avatar" ? "pupu" : null;
  const avatarDenied = (error: string) =>
    Response.json({ error: error === "creator_only" ? AVATAR_CREATOR_ONLY : AVATAR_NOT_MEMBER }, { status: 403 });
  if (avatarTarget && method === "POST") {
    const body = await readJson<{ preset?: unknown }>(request);
    if (body.preset !== null && typeof body.preset !== "string") {
      return Response.json({ error: "preset 是预设头像的 id，或者 null" }, { status: 400 });
    }
    const result = await caller.pupu.setAvatar(caller.device, body.preset, avatarTarget);
    if (result === "not_member" || result === "creator_only") return avatarDenied(result);
    if (result === "invalid") return Response.json({ error: "没有这个预设头像" }, { status: 400 });
    return Response.json({ ok: true });
  }
  if (avatarTarget && method === "PUT") {
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > MAX_AVATAR_BYTES) return Response.json({ error: "图片太大" }, { status: 413 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_AVATAR_BYTES) return Response.json({ error: "图片太大" }, { status: 413 });
    const result = await caller.pupu.uploadAvatar(caller.device, bytes, avatarTarget);
    if (!result.ok && (result.error === "not_member" || result.error === "creator_only")) return avatarDenied(result.error);
    if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true });
  }
  const avatar = pathname.match(/^\/api\/members\/([^/]+)\/avatar$/);
  if ((avatar || avatarTarget === "pupu") && method === "GET") {
    const stored = avatar ? await caller.pupu.avatarOf(decodeURIComponent(avatar[1] ?? "")) : await caller.pupu.pupuAvatar();
    if (!stored) return new Response(null, { status: 404 });
    return new Response(stored.bytes, {
      headers: {
        "Content-Type": stored.type,
        "X-Content-Type-Options": "nosniff",
        // 地址里带着换的时间，换了地址就变；只给登录了的人看，不进共享缓存。
        "Cache-Control": "private, max-age=31536000, immutable"
      }
    });
  }
  if (pathname === "/api/proofs" && method === "POST") {
    const body = await readJson<{ purpose?: unknown }>(request);
    const purpose = asPurpose(body.purpose);
    if (!purpose) return Response.json({ error: "要确认什么没说清楚" }, { status: 400 });
    const options = await caller.pupu.passkeyProofOptions(caller.device, relyingParty(url), purpose);
    if (!options) return Response.json({ error: `你在 ${url.host} 上还没有通行密钥，先在设置里加一把` }, { status: 409 });
    return Response.json(options);
  }
  if (pathname === "/api/desktop-tickets" && method === "POST") {
    const body = await readJson<{ computerId?: unknown; proof?: unknown }>(request);
    const computerId = typeof body.computerId === "string" ? body.computerId : "";
    const ticket = await caller.pupu.desktopTicket(caller.device, computerId, proofOf(url, body.proof));
    return ticket
      ? Response.json({ ticket })
      : Response.json({ error: "没确认上，只有电脑主人本人能开远程桌面" }, { status: 403 });
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
  // 协调模式这一版还不开放，只有本机开发能切，用来验证委派。
  const mode = pathname.match(/^\/api\/projects\/([^/]+)\/mode$/);
  if (mode && method === "POST" && isLocal(request)) {
    const body = await readJson<{ mode?: string }>(request);
    const next = body.mode === "coordinator" ? "coordinator" : "direct";
    const ok = await caller.pupu.setSpaceMode(decodeURIComponent(mode[1] ?? ""), next);
    if (!ok) return Response.json({ error: "没有这个项目" }, { status: 404 });
    return Response.json({ ok: true, mode: next });
  }
  const seen = pathname.match(/^\/api\/projects\/([^/]+)\/seen$/);
  if (seen && method === "POST") {
    const ok = await caller.pupu.markProjectSeen(decodeURIComponent(seen[1] ?? ""), caller.device);
    if (!ok) return Response.json({ error: "没有这个项目" }, { status: 404 });
    return Response.json({ ok: true });
  }
  if (pathname === "/api/spaces" && method === "POST") {
    const body = await readJson<{ name?: string; goal?: string }>(request);
    const space = await caller.pupu.createSpace({ name: String(body.name ?? ""), goal: String(body.goal ?? "") }, caller.device);
    if (!space) return Response.json({ error: "登录之后才能建空间" }, { status: 403 });
    return Response.json(space);
  }
  const space = pathname.match(/^\/api\/spaces\/([^/]+)$/);
  if (space && method === "POST") {
    const change = parseSpaceChange(await readJson<unknown>(request));
    if (!change) return Response.json({ error: SPACE_ERRORS.invalid.error }, { status: 400 });
    const verdict = await caller.pupu.changeSpace(decodeURIComponent(space[1] ?? ""), change, caller.device);
    if (verdict !== "ok") return Response.json({ error: SPACE_ERRORS[verdict].error }, { status: SPACE_ERRORS[verdict].status });
    return Response.json({ ok: true });
  }
  if (pathname === "/api/docs" && method === "GET") {
    return Response.json(await caller.pupu.listDocs(caller.device));
  }
  if (pathname === "/api/docs" && method === "POST") {
    const body = await readJson<{ title?: unknown; summary?: unknown; body?: unknown; kind?: unknown; spaceId?: unknown; operation?: unknown }>(request);
    const result = await caller.pupu.uploadDoc(
      {
        title: String(body.title ?? ""),
        summary: String(body.summary ?? ""),
        body: String(body.body ?? ""),
        kind: body.kind === "skill" ? "skill" : "doc",
        spaceId: typeof body.spaceId === "string" ? body.spaceId : null,
        operation: typeof body.operation === "string" && body.operation ? body.operation : crypto.randomUUID()
      },
      caller.device
    );
    if (result === "invalid") return Response.json({ error: `标题和正文都要有，正文不超过 ${DOC_BODY_LIMIT} 字` }, { status: 400 });
    if (result === "forbidden") return Response.json({ error: "没有这个空间" }, { status: 404 });
    return Response.json(result);
  }
  const doc = pathname.match(/^\/api\/docs\/([^/]+)$/);
  if (doc && method === "GET") {
    const found = await caller.pupu.readDoc(decodeURIComponent(doc[1] ?? ""), caller.device);
    if (!found) return Response.json({ error: "没有这份资料" }, { status: 404 });
    return Response.json(found);
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
          deviceCookie: (target, token) => signedInCookies(target, request, token),
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

/** 换模型只认创建者。本机开发不带凭据时（`actor` 是 null）当创建者。 */
function mayChangeModel(actor: Actor | null | undefined): boolean {
  return actor === null || actor?.role === "creator";
}
