import type { RunningCall } from "../bridge/activity.ts";
import type { ApprovalRow } from "../bridge/approvals.ts";
import { describeAction } from "../bridge/policy.ts";
import type { ComputerView } from "../bridge/protocol.ts";
import type { ApnsPush } from "./apns.ts";
import type { PushSender } from "./approvals.ts";
import type { PushDirectory, PushTokenRow } from "./store.ts";

/**
 * 灵动岛和锁屏上的实时活动：Pupu 在哪台电脑上、在做什么，有请示时在上面就能批。
 * 照「Pupu 设计规范」的 LiveActivity：操作屏幕期间一直在；命令跑了 30 秒还没完才出现；
 * 有请示时换成批准的样子；做完 2 分钟后消失。好几台电脑合成一个，不同时开好几个。
 * 每台手机只看自己主人的电脑：上面能批、能收回，所以和审批推送一样不给别人看。
 *
 * 云端是唯一开、改、关它的地方：手机登记 push-to-start token，这里用它开一个活动；
 * 活动开起来后手机再登记这个活动自己的 token，之后的更新和结束都推给它。
 * 写法参照了 home-assistant/iOS（服务端推 start/update/end、按 started_at 去重）
 * 和 LoopFollow（start 必须带 alert，不然 iOS 整条丢掉）。代码是自己写的。
 */

/** 和 iOS 的 `PupuActivityAttributes` 一字不差：push-to-start 按这个名字找结构体，上线后不能改名。 */
export const ATTRIBUTES_TYPE = "PupuActivityAttributes";
/** 命令跑了这么久还没完，才上灵动岛。短命令不打扰。 */
export const LONG_RUN_MS = 30_000;
/** 做完以后在锁屏上再留这么久。 */
export const LINGER_S = 120;
/** 开活动的推送发出去后，这么久内不再对同一台手机重发：等它报上活动的 token。 */
const START_WAIT_MS = 2 * 60_000;
/** 第二行最多这么多字，锁屏上两行放得下。 */
const DETAIL_CHARS = 100;
/** 推送在 APNs 那里最多等一小时，手机一直不在线就算了。 */
const EXPIRY_S = 60 * 60;

export type LiveMode = "approval" | "screen" | "command";

/** 实时活动的内容。字段名和 iOS 的 `PupuActivityAttributes.ContentState` 一一对应：只加不改。 */
export type LiveContent = {
  /** done：事情做完了，结束时最后显示的样子。 */
  readonly mode: LiveMode | "done";
  readonly computerId: string;
  readonly computerName: string;
  /** 大标题：「Pupu 正在操作「mbpro」的屏幕」「Pupu 想在「mbpro」上跑命令」。 */
  readonly title: string;
  /** 第二行：命令或者摘要。null 时手机上显示已经多久。 */
  readonly detail: string | null;
  /** 从什么时候开始，1970 年起的秒。ActivityKit 解 Date 按 2001 年起算，所以不传 Date。 */
  readonly since: number;
  /** 批准样子时，按钮批的是这一条。 */
  readonly approvalId: string | null;
  /** 一共几条请示在等批。 */
  readonly pending: number;
  /** 屏幕授权还在：显示「收回」。 */
  readonly screen: boolean;
  /** 紧凑态左边的图标：screen 是 cursorarrow.rays，command 是 terminal。 */
  readonly icon: "screen" | "command";
};

export type LiveInput = {
  readonly computers: readonly ComputerView[];
  readonly running: readonly RunningCall[];
  /** 还在等的请示，先来的在前。 */
  readonly pending: readonly ApprovalRow[];
  /** 屏幕授权到什么时候，毫秒。用来在它到期时叫醒自己。 */
  readonly screenUntil: (computerId: string) => number | null;
};

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS)}…` : flat;
}

const seconds = (ms: number) => Math.floor(ms / 1000);

/**
 * 现在锁屏上该显示什么，没什么可显示的是 null。等批 > 操作屏幕 > 跑了 30 秒以上的命令。
 * `screenSince` 是每台电脑的屏幕授权从什么时候起（毫秒），没记的按 `now` 算。
 */
export function liveContent(input: LiveInput, screenSince: ReadonlyMap<string, number>, now: number): LiveContent | null {
  const nameOf = (id: string) => input.computers.find((computer) => computer.id === id)?.name ?? "电脑";
  const screenOn = (id: string) => input.computers.some((computer) => computer.id === id && computer.screen);
  const pending = input.pending.length;

  // 最早来的那条请示最该先批，App 里的卡片也先摊开它。
  const first = input.pending[0];
  if (first) {
    return {
      mode: "approval",
      computerId: first.computerId,
      computerName: nameOf(first.computerId),
      title: `Pupu 想${first.title}`,
      detail: oneLine(first.detail) || null,
      since: seconds(first.createdAt),
      approvalId: first.id,
      pending,
      screen: screenOn(first.computerId),
      icon: first.kind === "screen" || first.screen ? "screen" : "command"
    };
  }

  // 好几台在操作屏幕时，显示最近动过的那台。
  const latestCall = (id: string) =>
    Math.max(0, ...input.running.filter((call) => call.computerId === id).map((call) => call.startedAt));
  const screens = input.computers
    .filter((computer) => computer.online && computer.screen)
    .sort((a, b) => latestCall(b.id) - latestCall(a.id));
  const screen = screens[0];
  if (screen) {
    return {
      mode: "screen",
      computerId: screen.id,
      computerName: screen.name,
      title: `Pupu 正在操作「${screen.name}」的屏幕`,
      detail: null,
      since: seconds(screenSince.get(screen.id) ?? now),
      approvalId: null,
      pending,
      screen: true,
      icon: "screen"
    };
  }

  const long = input.running
    .filter((call) => now - call.startedAt >= LONG_RUN_MS)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (long) {
    const { title, detail } = describeAction(long.action);
    const name = nameOf(long.computerId);
    return {
      mode: "command",
      computerId: long.computerId,
      computerName: name,
      title: `Pupu 正在「${name}」上${title}`,
      detail: oneLine(detail) || null,
      since: seconds(long.startedAt),
      approvalId: null,
      pending,
      screen: screenOn(long.computerId),
      icon: long.action.kind === "computer" ? "screen" : "command"
    };
  }
  return null;
}

/** 这台手机看得到的那部分：别人电脑上的事不上它的灵动岛。 */
function inputFor(input: LiveInput, sees: (computerId: string) => boolean): LiveInput {
  return {
    ...input,
    computers: input.computers.filter((computer) => sees(computer.id)),
    running: input.running.filter((call) => sees(call.computerId)),
    pending: input.pending.filter((row) => sees(row.computerId))
  };
}

/** 下次要重新看一眼的时候（毫秒）：某条命令跑满 30 秒，或者某台的屏幕授权到期。没有就是 null。 */
export function liveDue(input: LiveInput, now: number): number | null {
  const times = [
    ...input.running.map((call) => call.startedAt + LONG_RUN_MS),
    ...input.computers.filter((computer) => computer.screen).map((computer) => input.screenUntil(computer.id) ?? 0)
  ].filter((time) => time > now);
  return times.length > 0 ? Math.min(...times) : null;
}

/** 做完时最后显示的样子：还是那台电脑，说一声做完了。 */
export function doneContent(last: LiveContent): LiveContent {
  return {
    ...last,
    mode: "done",
    title: `Pupu 在「${last.computerName}」上的事做完了`,
    detail: null,
    approvalId: null,
    pending: 0,
    screen: false
  };
}

/** 每台手机上推到了哪一步。存在 pupu_meta 里，DO 重启后接着用。 */
type DeviceState = {
  /** 这台手机上的活动现在显示的内容（JSON）。 */
  readonly sent: string | null;
  /** 推了开活动的那条、还没等到活动 token 的时间。 */
  readonly startAt: number | null;
  /** 上一次的内容，做完时用它说是哪台电脑。 */
  readonly last: LiveContent | null;
};

type State = {
  readonly devices: Record<string, DeviceState>;
  /** 每台电脑的屏幕授权从什么时候起，毫秒。 */
  readonly screenSince: Record<string, number>;
};

const EMPTY: State = { devices: {}, screenSince: {} };

function readState(raw: string | undefined): State {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<State>;
    return { devices: value.devices ?? {}, screenSince: value.screenSince ?? {} };
  } catch {
    return EMPTY;
  }
}

export type LivePusherOptions = {
  readonly store: Pick<PushDirectory, "tokens" | "remove">;
  /** 没配 APNs 密钥时是 null：什么都不推。 */
  readonly apns: () => PushSender | null;
  readonly state: { get(): string | undefined; set(value: string): void };
  /** 这台电脑的事给哪些手机看。不传就是所有手机。 */
  readonly audience?: (computerId: string) => (deviceId: string) => boolean;
  readonly now: () => number;
  readonly log?: (message: string) => void;
};

/**
 * 把实时活动推到手机上。和审批推送一样，每次有变化就对一遍账：
 * - 有内容、手机有这个活动的 token：内容变了就推 update。
 * - 有内容、手机还没有活动：用 push-to-start token 开一个。推过同样内容的不再推，
 *   这样用户在锁屏上划掉了，同一件事不会又冒出来；换了件事才再开。
 * - 没内容了：给开着的活动推 end，在锁屏上留 2 分钟，然后删掉它的 token。
 */
export class LivePusher {
  readonly #options: LivePusherOptions;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: LivePusherOptions) {
    this.#options = options;
  }

  /** 电脑、请示或屏幕授权变了，手机登记了 token，或者定时到了，都调一次。一次只对一轮账。 */
  sync(input: LiveInput): Promise<void> {
    return this.#enqueue(() => this.#sync(input));
  }

  /**
   * 手机被吊销：它开着的活动推 end、马上从锁屏上拿掉，上面的「允许」也跟着没了。
   * 要在删它的 token 之前调：这里当场记下活动的 token，之后推的时候 token 已经删了也不要紧。
   */
  end(deviceId: string): Promise<void> {
    const activity = this.#options.store.tokens("activity").find((row) => row.deviceId === deviceId);
    return this.#enqueue(async () => {
      const state = readState(this.#options.state.get());
      const { [deviceId]: was, ...devices } = state.devices;
      this.#options.state.set(JSON.stringify({ ...state, devices } satisfies State));
      const apns = this.#options.apns();
      if (!apns || !activity || !was?.last) return;
      await this.#send(apns, activity, "end", doneContent(was.last), this.#options.now(), null, 0);
    });
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #sync(input: LiveInput): Promise<void> {
    const apns = this.#options.apns();
    if (!apns) return;
    const now = this.#options.now();
    const previous = readState(this.#options.state.get());

    const screenSince: Record<string, number> = {};
    for (const computer of input.computers) {
      if (computer.screen) screenSince[computer.id] = previous.screenSince[computer.id] ?? now;
    }
    const since = new Map(Object.entries(screenSince));

    const starts = new Map(this.#options.store.tokens("start").map((row) => [row.deviceId, row]));
    const activities = new Map(this.#options.store.tokens("activity").map((row) => [row.deviceId, row]));
    const deviceIds = new Set([...starts.keys(), ...activities.keys()]);
    const devices: Record<string, DeviceState> = {};
    const jobs: Promise<void>[] = [];

    for (const deviceId of deviceIds) {
      const was = previous.devices[deviceId] ?? { sent: null, startAt: null, last: null };
      const activity = activities.get(deviceId);
      const start = starts.get(deviceId);
      const audience = this.#options.audience;
      const mine = audience ? inputFor(input, (computerId) => audience(computerId)(deviceId)) : input;
      const content = liveContent(mine, since, now);
      const key = content ? JSON.stringify(content) : null;

      if (!content) {
        if (activity) {
          // 活动 token 结束后就没用了，先删掉，下件事再开一个新的。
          this.#options.store.remove(activity.token);
          if (was.last) jobs.push(this.#send(apns, activity, "end", doneContent(was.last), now));
        }
        // 留着上一次的：开活动的推送发出去后才报上来的 token，结束时还要说是哪台电脑。
        devices[deviceId] = { sent: null, startAt: null, last: was.last };
        continue;
      }

      if (activity) {
        if (was.sent !== key) {
          const lastMode = was.sent ? (JSON.parse(was.sent) as LiveContent).mode : null;
          jobs.push(this.#send(apns, activity, "update", content, now, lastMode));
        }
        devices[deviceId] = { sent: key, startAt: null, last: content };
        continue;
      }

      // 推过开活动的那条，还在等它报 token：内容变了也先等，token 到了再补一条 update。
      const waiting = was.startAt !== null && now - was.startAt < START_WAIT_MS;
      if (start && was.sent !== key && !waiting) {
        jobs.push(this.#send(apns, start, "start", content, now));
        devices[deviceId] = { sent: key, startAt: now, last: content };
      } else {
        devices[deviceId] = { ...was, last: content };
      }
    }

    this.#options.state.set(JSON.stringify({ devices, screenSince } satisfies State));
    await Promise.all(jobs);
  }

  async #send(
    apns: PushSender,
    token: PushTokenRow,
    event: "start" | "update" | "end",
    content: LiveContent,
    now: number,
    lastMode: LiveContent["mode"] | null = null,
    linger = LINGER_S
  ): Promise<void> {
    const push = livePush(token, event, content, now, lastMode, linger);
    const result = await apns.send(push);
    if (result.gone) {
      this.#options.store.remove(token.token);
      this.#options.log?.(`APNs 说这个实时活动 token 用不了了（${result.status} ${result.reason}），已删掉`);
    } else if (result.status !== 200) {
      this.#options.log?.(`APNs 没收这条实时活动推送（${event}）：${result.status} ${result.reason ?? ""}`);
    }
  }
}

/**
 * 一条实时活动推送。start 要带 attributes 和 alert（没有 alert iOS 会整条丢掉；标题留空、
 * passive，审批已经另有一条带响的通知）。end 带 dismissal-date，在锁屏上留 `linger` 秒，默认 2 分钟。
 * 开活动和变成等批时立刻投，其余的交给系统挑时候。
 */
export function livePush(
  token: Pick<PushTokenRow, "token" | "env">,
  event: "start" | "update" | "end",
  content: LiveContent,
  now: number,
  lastMode: LiveContent["mode"] | null = null,
  linger = LINGER_S
): ApnsPush {
  const timestamp = seconds(now);
  const aps: Record<string, unknown> = { timestamp, event, "content-state": content };
  if (event === "start") {
    aps["attributes-type"] = ATTRIBUTES_TYPE;
    aps.attributes = { startedAt: timestamp };
    aps.alert = { title: "", body: "" };
    aps["interruption-level"] = "passive";
  }
  if (event === "end") aps["dismissal-date"] = timestamp + linger;
  const urgent = event === "start" || (content.mode === "approval" && lastMode !== "approval");
  return {
    token: token.token,
    env: token.env,
    type: "liveactivity",
    priority: urgent ? 10 : 5,
    expiration: timestamp + EXPIRY_S,
    payload: { aps }
  };
}
