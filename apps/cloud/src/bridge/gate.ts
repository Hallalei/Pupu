import { describeWaiting } from "./activity.ts";
import { ABORTED, blockedText, EXPIRED } from "./blocked.ts";
import type { ApprovalDirectory, ApprovalRow, ApprovalView } from "./approvals.ts";
import {
  DEFAULT_POLICY,
  SCREEN_GRANT_IDLE_MS,
  describeAction,
  needFor,
  usesScreen,
  type ComputerPolicy
} from "./policy.ts";
import type { Action, ComputerView } from "./protocol.ts";
import { selectComputer } from "./status.ts";
import type { ComputerDirectory, ComputerRow } from "./store.ts";
import { actionForCall } from "./calls.ts";

/** 一条请示等这么久没人理，就当没批。 */
export const APPROVAL_TTL_MS = 10 * 60_000;

const SCREEN_DETAIL = "看这台电脑的屏幕，用鼠标和键盘操作它。批准后，15 分钟没有屏幕操作才会再问。";
const TAKEN_BACK = "用户在电脑上收回了屏幕控制";

/**
 * 一台电脑的屏幕授权。active 过了 until 就等于没有，到点由 `expireScreens` 改回 none 并广播。
 * revoked 记下收回的时间：收回之前批的那一步，不能再把授权续回来。
 */
export type ScreenGrant =
  | { readonly kind: "none" }
  | { readonly kind: "active"; readonly until: number }
  | { readonly kind: "revoked"; readonly at: number };

export type ScreenEvent =
  /** 批了屏幕请示，或者批了一步要用屏幕的操作。`decidedAt` 是批的时间。 */
  | { readonly type: "grant"; readonly decidedAt: number }
  /** 做了一次屏幕操作：授权还有效就往后顺延，没有效不续。 */
  | { readonly type: "use" }
  /** 用户在电脑上收回。 */
  | { readonly type: "takeback" }
  /** 到点了。 */
  | { readonly type: "expire" };

export const NO_SCREEN: ScreenGrant = { kind: "none" };

export function screenOn(grant: ScreenGrant, now: number): boolean {
  return grant.kind === "active" && grant.until > now;
}

/** 屏幕授权的所有变化。没变就原样返回同一个对象。 */
export function nextScreen(grant: ScreenGrant, event: ScreenEvent, now: number): ScreenGrant {
  switch (event.type) {
    case "grant":
      if (grant.kind === "revoked" && event.decidedAt <= grant.at) return grant;
      return { kind: "active", until: now + SCREEN_GRANT_IDLE_MS };
    case "use":
      return screenOn(grant, now) ? { kind: "active", until: now + SCREEN_GRANT_IDLE_MS } : grant;
    case "takeback":
      return { kind: "revoked", at: now };
    case "expire":
      return grant.kind === "active" && grant.until <= now ? NO_SCREEN : grant;
  }
}

/** 给本机桥的状态：菜单栏上显示。 */
export type BridgeStatus = {
  readonly pending: readonly string[];
  readonly screen: boolean;
};

export type GateOptions = {
  readonly computers: () => readonly ComputerView[];
  readonly directory: Pick<ComputerDirectory, "list" | "setPolicy" | "setScreen">;
  readonly approvals: ApprovalDirectory;
  readonly now: () => number;
  /** 这些电脑的审批或屏幕授权变了。 */
  readonly onChange: (computerIds: readonly string[]) => void;
  /**
   * 不在电脑上的调用（连接器）能不能做。要问就给出请示的内容，`subjectId` 记在审批表的
   * computer_id 一栏，和电脑的分开；不许做给 `block`；直接做返回 undefined。见 src/connectors/tools.ts。
   */
  readonly plan?: (call: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly session: string | null;
  }) => Promise<
    | { subjectId: string; title: string; detail: string; reason: string | null }
    | { block: string }
    | undefined
  >;
  /** 审批卡上「哪台电脑」那一栏，不是电脑的时候写什么。 */
  readonly subjectName?: (subjectId: string) => string | undefined;
};

/**
 * 电脑上的动作先过这道门。按电脑的分级决定直接做、批屏幕授权，还是这一步单独问；
 * 要问的写进审批表，等用户在手机上点允许或拒绝。
 *
 * 等待挂在 pi 的 beforeTool 上：它在调用的 intent 之前，DO 被回收后 pi 重跑这次调用时
 * 会再进来，按调用 id 查到同一条审批，接着等。
 */
export class ComputerGate {
  readonly #options: GateOptions;
  readonly #listeners = new Map<string, Set<() => void>>();

  constructor(options: GateOptions) {
    this.#options = options;
  }

  async beforeTool(
    call: {
      readonly id: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      /** 这次调用在哪个 pi 会话里，记在审批行上。 */
      readonly session?: string;
    },
    signal?: AbortSignal
  ): Promise<{ block: string } | undefined> {
    const session = call.session ?? null;
    let row = this.#options.approvals.byCall(call.id);
    if (!row) {
      const planned = actionForCall(call.name, call.arguments);
      if (!planned) {
        const asked = await this.#options.plan?.({ ...call, session });
        if (!asked) return undefined;
        if ("block" in asked) return asked;
        // 等 plan 的时候 DO 可能已经把同一次调用登记过了。
        row = this.#options.approvals.byCall(call.id) ?? this.#askOther(call.id, session, asked);
        return this.#await(row, signal);
      }
      // 选不出电脑时让工具自己去说明，这里不拦。
      const selected = selectComputer(this.#options.computers(), planned.computerId);
      if (!selected.ok) return undefined;
      row = this.#ask(call.id, session, selected.computer, planned.action);
      if (!row) return undefined;
    }
    return this.#await(row, signal);
  }

  /**
   * 这个动作是不是已经批过：分级是都放行，或者这次调用批过。屏幕操作只看授权还在不在，
   * 这一步单独批过的，批的时候已经开了授权；之后在电脑上收回了就不算。
   */
  approved(input: { readonly requestId: string; readonly computerId: string; readonly action: Action }): boolean {
    const computer = this.#row(input.computerId);
    if (!computer) return false;
    if (computer.policy === "trust") return true;
    if (usesScreen(input.action)) return screenOn(this.#screen(computer, { type: "use" }), this.#options.now());
    return this.#options.approvals.byCall(input.requestId)?.status === "allowed";
  }

  decide(id: string, decision: "allow" | "deny"): "ok" | "missing" | "settled" {
    const row = this.#options.approvals.byId(id);
    if (!row) return "missing";
    if (row.status !== "pending") {
      // 已经处理过了。还有人在等的话叫醒它，让它读到结果。
      this.#wake(id);
      return "settled";
    }
    const now = this.#options.now();
    if (now >= row.expiresAt) {
      this.#options.approvals.settle(id, "expired", now);
      this.#wake(id);
      this.#options.onChange([row.computerId]);
      return "settled";
    }
    this.#options.approvals.settle(id, decision === "allow" ? "allowed" : "denied", now);
    // 先开屏幕授权，等着的那次调用回来之前，别的屏幕操作也不用再问。
    const computer = this.#row(row.computerId);
    if (decision === "allow" && row.screen && computer) this.#screen(computer, { type: "grant", decidedAt: now });
    this.#wake(id);
    this.#options.onChange([row.computerId]);
    return "ok";
  }

  /** 在电脑上收回屏幕控制：授权作废，这台电脑还在等的屏幕请示都拒掉。 */
  takeback(computerId: string): void {
    const computer = this.#row(computerId);
    if (computer) this.#screen(computer, { type: "takeback" });
    this.#denyPending(computerId, (row) => row.screen, TAKEN_BACK);
    this.#options.onChange([computerId]);
  }

  /** 电脑被吊销了：它还在等的请示都拒掉，不然手机上一直挂着，批了也没处做。 */
  forgetComputer(computerId: string): void {
    this.#denyPending(computerId, () => true, "这台电脑的授权已经吊销");
    this.#options.onChange([computerId]);
  }

  /** 到期的屏幕授权改回没有，告诉大家。由 DO 的定时任务在 `screenDue` 那一刻叫。 */
  expireScreens(): void {
    const lapsed: string[] = [];
    for (const computer of this.#options.directory.list()) {
      if (this.#screen(computer, { type: "expire" }) !== computer.screen) lapsed.push(computer.id);
    }
    if (lapsed.length > 0) this.#options.onChange(lapsed);
  }

  /** 最早一个屏幕授权到期的时间。屏幕操作会往后顺延，所以到点时还要再看一眼。 */
  screenDue(): number | null {
    const times = this.#options.directory
      .list()
      .flatMap((computer) => (computer.screen.kind === "active" ? [computer.screen.until] : []));
    return times.length > 0 ? Math.min(...times) : null;
  }

  setPolicy(computerId: string, policy: ComputerPolicy): boolean {
    if (!this.#options.directory.setPolicy(computerId, policy)) return false;
    this.#options.onChange([computerId]);
    return true;
  }

  screenActive(computerId: string): boolean {
    return screenOn(this.#row(computerId)?.screen ?? NO_SCREEN, this.#options.now());
  }

  /** `visible` 决定这一条给不给这个人看。 */
  pending(visible: (row: ApprovalRow) => boolean = () => true): ApprovalView[] {
    const now = this.#options.now();
    if (this.#options.approvals.sweep(now) > 0) {
      // 过期的那几条可能还有人在等，叫醒它们去收尾。
      for (const id of this.#listeners.keys()) this.#wake(id);
    }
    const names = new Map(this.#options.computers().map((computer) => [computer.id, computer.name]));
    return this.#options.approvals.pending(now).filter(visible).map((row) => ({
      id: row.id,
      callId: row.callId,
      computerId: row.computerId,
      computerName: names.get(row.computerId) ?? this.#options.subjectName?.(row.computerId) ?? "电脑",
      kind: row.kind,
      title: row.title,
      detail: row.detail,
      reason: row.reason,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt
    }));
  }

  statusFor(computerId: string): BridgeStatus {
    const now = this.#options.now();
    const pending = this.#options.approvals
      .pending(now)
      .filter((row) => row.computerId === computerId)
      // 菜单栏就在那台电脑上，不用再说是哪台。
      .map(describeWaiting);
    return { pending, screen: this.screenActive(computerId) };
  }

  #ask(callId: string, session: string | null, computer: ComputerView, action: Action): ApprovalRow | undefined {
    const row = this.#row(computer.id);
    const { need, risk } = needFor(row?.policy ?? DEFAULT_POLICY, action, {
      ...(row?.localRoot ? { home: row.localRoot } : {}),
      screenGranted: this.screenActive(computer.id)
    });
    if (need === "none") return undefined;
    const now = this.#options.now();
    const described =
      need === "screen" ? { title: "操作屏幕", detail: SCREEN_DETAIL } : describeAction(action);
    const created = this.#options.approvals.insert({
      callId,
      session,
      computerId: computer.id,
      kind: need,
      screen: usesScreen(action),
      title: `在「${computer.name}」上${described.title}`,
      detail: described.detail,
      reason: risk.level === "high" ? risk.reason : null,
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS
    });
    this.#options.onChange([computer.id]);
    return created;
  }

  #askOther(
    callId: string,
    session: string | null,
    asked: { subjectId: string; title: string; detail: string; reason: string | null }
  ): ApprovalRow {
    const now = this.#options.now();
    const created = this.#options.approvals.insert({
      callId,
      session,
      computerId: asked.subjectId,
      kind: "step",
      screen: false,
      title: asked.title,
      detail: asked.detail,
      reason: asked.reason,
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS
    });
    this.#options.onChange([asked.subjectId]);
    return created;
  }

  async #await(first: ApprovalRow, signal: AbortSignal | undefined): Promise<{ block: string } | undefined> {
    let row: ApprovalRow | undefined = first;
    while (true) {
      row = this.#options.approvals.byId(row.id);
      if (!row) return { block: "这次请示找不到了，这一步没有做。" };
      if (row.status === "allowed") {
        if (!row.screen) return undefined;
        // DO 重启后重跑的调用也走这里：授权过期了就按这次批准再开；批了之后在电脑上收回了，就不做。
        const computer = this.#row(row.computerId);
        if (!computer) return undefined;
        const now = this.#options.now();
        const grant = this.#screen(computer, { type: "grant", decidedAt: row.decidedAt ?? row.createdAt });
        if (!screenOn(grant, now)) return { block: blockedText(TAKEN_BACK, row.title, "不要重试，告诉用户这一步没做。") };
        if (!screenOn(computer.screen, now)) this.#options.onChange([computer.id]);
        return undefined;
      }
      if (row.status === "denied") {
        const why = row.note ?? "用户在手机上拒绝了这一步";
        return {
          block: blockedText(why, row.title, "不要重试，也不要换个写法再做；告诉用户这一步没做，问他想怎么办。")
        };
      }
      if (row.status === "expired") {
        return {
          block: blockedText(
            `这条请示 ${APPROVAL_TTL_MS / 60_000} 分钟没人处理，${EXPIRED}`,
            row.title,
            "告诉用户这一步没做，等他有空再说。"
          )
        };
      }
      if (row.status === "aborted") {
        return { block: blockedText(`等批准的时候${ABORTED}`, row.title, "要做的话重新来。") };
      }
      const now = this.#options.now();
      if (signal?.aborted) {
        this.#options.approvals.settle(row.id, "aborted", now);
        this.#options.onChange([row.computerId]);
        throw signal.reason ?? new Error("aborted");
      }
      if (now >= row.expiresAt) {
        this.#options.approvals.settle(row.id, "expired", now);
        this.#options.onChange([row.computerId]);
        continue;
      }
      await this.#wait(row.id, row.expiresAt - now, signal);
    }
  }

  #wait(id: string, ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      let set = this.#listeners.get(id);
      if (!set) {
        set = new Set();
        this.#listeners.set(id, set);
      }
      const listeners = set;
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        listeners.delete(done);
        if (listeners.size === 0) this.#listeners.delete(id);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      listeners.add(done);
    });
  }

  #wake(id: string): void {
    for (const listener of [...(this.#listeners.get(id) ?? [])]) listener();
  }

  /**
   * 屏幕授权的每一次变化都从这里写进去，广播由调用的地方做。
   * 授权刚开的时候，这台电脑别的屏幕请示一起放行：它们问的就是这一件事。
   */
  #screen(computer: ComputerRow, event: ScreenEvent): ScreenGrant {
    const now = this.#options.now();
    const after = nextScreen(computer.screen, event, now);
    if (after === computer.screen) return after;
    this.#options.directory.setScreen(computer.id, after);
    if (screenOn(after, now) && !screenOn(computer.screen, now)) {
      for (const row of this.#options.approvals.pending(now)) {
        if (row.computerId !== computer.id || row.kind !== "screen") continue;
        if (this.#options.approvals.settle(row.id, "allowed", now)) this.#wake(row.id);
      }
    }
    return after;
  }

  #denyPending(computerId: string, matches: (row: ApprovalRow) => boolean, note: string): void {
    const now = this.#options.now();
    for (const row of this.#options.approvals.pending(now)) {
      if (row.computerId !== computerId || !matches(row)) continue;
      if (this.#options.approvals.settle(row.id, "denied", now, note)) this.#wake(row.id);
    }
  }

  #row(computerId: string): ComputerRow | undefined {
    return this.#options.directory.list().find((row) => row.id === computerId);
  }
}
