import type { ApprovalRow } from "./approvals.ts";
import { describeAction } from "./policy.ts";
import type { Action, ComputerView } from "./protocol.ts";

/**
 * 每台电脑现在在干什么：聊天顶上的「正在做」和锁屏的实时活动用的是同一份。
 * 从三样东西算出来：电脑上正在跑的工具调用、等批的请示、屏幕授权。都在云端，不用桥另外报。
 */

/** 电脑上正在跑的一次工具调用。 */
export type RunningCall = {
  readonly callId: string;
  readonly computerId: string;
  readonly action: Action;
  readonly startedAt: number;
};

/**
 * offline：没连上，或者心跳停了。waiting：有请示等你批，Pupu 停在那一步。
 * working：正在电脑上做事。idle：连着，闲着。
 */
export type ActivityState = "offline" | "waiting" | "working" | "idle";

export type ActivityProject = { readonly id: string; readonly name: string };

export type ComputerActivity = {
  readonly computerId: string;
  readonly computerName: string;
  readonly state: ActivityState;
  /** 一句话：在做什么，或者停在哪一步等你批。闲着和离线是 null。 */
  readonly doing: string | null;
  /** 等批的那一步为什么算高风险，比如「推送到远端仓库」。 */
  readonly reason: string | null;
  /** 这件事是哪个项目里的。主对话里的、或者不知道的，是 null。 */
  readonly project: ActivityProject | null;
  /** `doing` 从什么时候开始。 */
  readonly since: number | null;
  /** 几条请示在等批。 */
  readonly pending: number;
  /** 同时在跑几件事。 */
  readonly running: number;
  /** 屏幕授权还有效：Pupu 能看这台电脑的屏幕、用鼠标键盘操作它。 */
  readonly screen: boolean;
};

/** `doing` 里命令只留开头。灵动岛上一行放不下多少字。 */
const DOING_CHARS = 60;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DOING_CHARS ? `${flat.slice(0, DOING_CHARS)}…` : flat;
}

/** 正在跑的动作说成一句话。屏幕操作的坐标对人没有用，只说动作。 */
export function describeDoing(action: Action): string {
  if (action.kind === "computer") {
    return action.op === "screenshot" ? "看屏幕" : describeAction(action).title;
  }
  const { title, detail } = describeAction(action);
  return detail ? `${title}：${oneLine(detail)}` : title;
}

/** 等批的那一步。标题是「在「电脑名」上跑命令」，电脑名这里不用重复。 */
export function describeWaiting(row: ApprovalRow): string {
  const title = row.title.replace(/^在「[^」]*」上/, "");
  return row.kind === "screen" ? title : `${title}：${oneLine(row.detail)}`;
}

export function computerActivity(input: {
  /** `bridge.list()` 的顺序：在线的在前。 */
  readonly computers: readonly ComputerView[];
  readonly running: readonly RunningCall[];
  /** 还在等、没过期的请示，先来的在前。 */
  readonly pending: readonly ApprovalRow[];
  readonly projectOf: (callId: string) => ActivityProject | null;
}): ComputerActivity[] {
  return input.computers.map((computer) => {
    const pending = input.pending.filter((row) => row.computerId === computer.id);
    const running = input.running
      .filter((call) => call.computerId === computer.id)
      .sort((a, b) => a.startedAt - b.startedAt);
    const base = {
      computerId: computer.id,
      computerName: computer.name,
      pending: pending.length,
      running: running.length,
      screen: computer.screen
    };
    const quiet = { doing: null, reason: null, project: null, since: null };
    if (!computer.online) return { ...base, ...quiet, state: "offline" };
    // 先说等批的：Pupu 停在那里，要人去处理。最早来的那条最该先批。
    const first = pending[0];
    if (first) {
      return {
        ...base,
        state: "waiting",
        doing: describeWaiting(first),
        reason: first.reason,
        project: input.projectOf(first.callId),
        since: first.createdAt
      };
    }
    // 同时跑着几件事时说最新的那件，它最像「现在在做的」。
    const latest = running.at(-1);
    if (latest) {
      return {
        ...base,
        state: "working",
        doing: describeDoing(latest.action),
        reason: null,
        project: input.projectOf(latest.callId),
        since: latest.startedAt
      };
    }
    return { ...base, ...quiet, state: "idle" };
  });
}

const BUSY_ORDER: readonly ActivityState[] = ["waiting", "working", "idle"];

/**
 * 「正在做」列哪些电脑：在做事的、停着等批的，还有闲着但屏幕控制没收回的。
 * 屏幕控制开着的排最前：「收回」是安全出口，只摊开一行时也要看得到。
 * 同级按 id 排：云端的 `computers` 按心跳排，每次心跳都可能换先后，只摊开的那一行不能跟着跳。
 */
export function busyComputers(activity: readonly ComputerActivity[]): ComputerActivity[] {
  return activity
    .filter((row) => row.state === "working" || row.state === "waiting" || (row.state === "idle" && row.screen))
    .sort(
      (a, b) =>
        Number(b.screen) - Number(a.screen) ||
        BUSY_ORDER.indexOf(a.state) - BUSY_ORDER.indexOf(b.state) ||
        a.computerId.localeCompare(b.computerId)
    );
}

/** 停在哪些项目里等你批。一台电脑只带得出最早那条请示的项目。 */
export function waitingProjects(activity: readonly ComputerActivity[]): ReadonlySet<string> {
  return new Set(activity.flatMap((row) => (row.state === "waiting" && row.project ? [row.project.id] : [])));
}

/**
 * 调用 id → 它在哪个 pi 会话里，用来找出是哪个项目、该给谁看。只在内存里记最近的这些：
 * DO 重启后，还在等批的调用 pi 会重跑一遍 beforeTool，又会记上；等批的调用审批行上也记着。
 */
export class CallSessions {
  readonly #limit: number;
  readonly #sessions = new Map<string, string>();

  constructor(limit = 256) {
    this.#limit = limit;
  }

  remember(callId: string, session: string): void {
    this.#sessions.delete(callId);
    this.#sessions.set(callId, session);
    if (this.#sessions.size > this.#limit) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest !== undefined) this.#sessions.delete(oldest);
    }
  }

  of(callId: string): string | null {
    return this.#sessions.get(callId) ?? null;
  }
}
