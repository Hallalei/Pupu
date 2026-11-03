import { describeWaiting } from "./activity.ts";
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

/** 给本机桥的状态：菜单栏上显示。 */
export type BridgeStatus = {
  readonly pending: readonly string[];
  readonly screen: boolean;
};

export type GateOptions = {
  readonly computers: () => readonly ComputerView[];
  readonly directory: Pick<ComputerDirectory, "list" | "setPolicy" | "setScreenUntil">;
  readonly approvals: ApprovalDirectory;
  readonly now: () => number;
  /** 这些电脑的审批或屏幕授权变了。 */
  readonly onChange: (computerIds: readonly string[]) => void;
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
    call: { readonly id: string; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
    signal?: AbortSignal
  ): Promise<{ block: string } | undefined> {
    let row = this.#options.approvals.byCall(call.id);
    if (!row) {
      const planned = actionForCall(call.name, call.arguments);
      if (!planned) return undefined;
      // 选不出电脑时让工具自己去说明，这里不拦。
      const selected = selectComputer(this.#options.computers(), planned.computerId);
      if (!selected.ok) return undefined;
      row = this.#ask(call.id, selected.computer, planned.action);
      if (!row) return undefined;
    }
    return this.#await(row, signal);
  }

  /** 这个动作是不是已经批过：分级是都放行、这次调用批过，或者屏幕授权还有效。 */
  approved(input: { readonly requestId: string; readonly computerId: string; readonly action: Action }): boolean {
    const computer = this.#row(input.computerId);
    if (!computer) return false;
    if (computer.policy === "trust") return true;
    const screen = usesScreen(input.action);
    if (this.#options.approvals.byCall(input.requestId)?.status === "allowed") {
      if (screen) this.#touchScreen(input.computerId);
      return true;
    }
    if (screen && this.screenActive(input.computerId)) {
      this.#touchScreen(input.computerId);
      return true;
    }
    return false;
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
    if (decision === "allow" && row.screen) this.#grantScreen(row.computerId);
    this.#wake(id);
    this.#options.onChange([row.computerId]);
    return "ok";
  }

  /** 在电脑上收回屏幕控制：授权作废，这台电脑还在等的屏幕请示都拒掉。 */
  takeback(computerId: string): void {
    const now = this.#options.now();
    this.#options.directory.setScreenUntil(computerId, null);
    for (const row of this.#options.approvals.pending(now)) {
      if (row.computerId !== computerId || !row.screen) continue;
      if (this.#options.approvals.settle(row.id, "denied", now, "用户在电脑上收回了屏幕控制")) this.#wake(row.id);
    }
    this.#options.onChange([computerId]);
  }

  setPolicy(computerId: string, policy: ComputerPolicy): boolean {
    if (!this.#options.directory.setPolicy(computerId, policy)) return false;
    this.#options.onChange([computerId]);
    return true;
  }

  screenActive(computerId: string): boolean {
    const until = this.#row(computerId)?.screenUntil ?? null;
    return until !== null && until > this.#options.now();
  }

  pending(): ApprovalView[] {
    const now = this.#options.now();
    if (this.#options.approvals.sweep(now) > 0) {
      // 过期的那几条可能还有人在等，叫醒它们去收尾。
      for (const id of this.#listeners.keys()) this.#wake(id);
    }
    const names = new Map(this.#options.computers().map((computer) => [computer.id, computer.name]));
    return this.#options.approvals.pending(now).map((row) => ({
      id: row.id,
      computerId: row.computerId,
      computerName: names.get(row.computerId) ?? "电脑",
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

  #ask(callId: string, computer: ComputerView, action: Action): ApprovalRow | undefined {
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

  async #await(first: ApprovalRow, signal: AbortSignal | undefined): Promise<{ block: string } | undefined> {
    let row: ApprovalRow | undefined = first;
    while (true) {
      row = this.#options.approvals.byId(row.id);
      if (!row) return { block: "这次请示找不到了，这一步没有做。" };
      if (row.status === "allowed") {
        if (row.screen && !this.screenActive(row.computerId)) this.#grantScreen(row.computerId);
        return undefined;
      }
      if (row.status === "denied") {
        const why = row.note ?? "用户在手机上拒绝了这一步";
        return {
          block: `${why}，没有执行：${row.title}。不要重试，也不要换个写法再做；告诉用户这一步没做，问他想怎么办。`
        };
      }
      if (row.status === "expired") {
        return {
          block: `这条请示 ${APPROVAL_TTL_MS / 60_000} 分钟没人处理，已经作废，没有执行：${row.title}。告诉用户这一步没做，等他有空再说。`
        };
      }
      const now = this.#options.now();
      if (now >= row.expiresAt || signal?.aborted) {
        this.#options.approvals.settle(row.id, "expired", now);
        this.#options.onChange([row.computerId]);
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
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

  #grantScreen(computerId: string): void {
    this.#options.directory.setScreenUntil(computerId, this.#options.now() + SCREEN_GRANT_IDLE_MS);
    this.#options.onChange([computerId]);
  }

  /** 每次屏幕操作把授权往后顺延，不广播。 */
  #touchScreen(computerId: string): void {
    this.#options.directory.setScreenUntil(computerId, this.#options.now() + SCREEN_GRANT_IDLE_MS);
  }

  #row(computerId: string): ComputerRow | undefined {
    return this.#options.directory.list().find((row) => row.id === computerId);
  }
}
