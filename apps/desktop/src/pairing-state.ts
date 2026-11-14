import type { Credential, Pairing } from "./credentials.ts";

/**
 * 这台电脑（桥）的授权，托盘、配对窗口和设置里「这台电脑」那一页都从这里分：
 * - `ok`：有凭据。只是窗口的凭据没了也算，桥照样在跑；
 * - `first`：窗口和这台电脑的凭据都没有，要从头配对；
 * - `unfinished`：窗口的凭据拿到了，这台电脑的还没拿到。配对半路出了错，再试一次就好；
 * - `revoked`：云端拒了这台电脑的凭据。只有这种是规范 ThisComputer 里的「授权被吊销」。
 */
export type ComputerAuth = "ok" | "first" | "unfinished" | "revoked";

export function computerAuth(pairing: Pairing): ComputerAuth {
  if (pairing.computer) return "ok";
  if (!pairing.desktop) return "first";
  return pairing.computerRevoked ? "revoked" : "unfinished";
}

/** 云端拒了这台电脑的凭据：丢掉它，记下是被吊销了。 */
export function rejectComputer(pairing: Pairing): Pairing {
  return { ...pairing, computer: null, computerRevoked: true };
}

/** 拿到了这台电脑的新凭据，被吊销的记号跟着旧的一起去掉。 */
export function withComputer(pairing: Pairing, computer: Credential): Pairing {
  const { computerRevoked: _revoked, ...rest } = pairing;
  return { ...rest, computer };
}

/**
 * 为什么要配对，跟着手上的凭据变：
 * - `first`：两份凭据都没有；
 * - `desktop`：窗口的凭据被吊销了，要一个新码；
 * - `computer`：窗口还能用，云端拒了这台电脑的凭据，点一下就重新配对，不用码；
 * - `unfinished`：窗口还能用，这台电脑的凭据上次没拿到，点一下再试，不用码。
 */
export type PairingReason = "first" | "desktop" | "computer" | "unfinished";

/** 正在做的那一次：用码配对，或者在浏览器里等 Google 登录。 */
export type PairingBusy = "code" | "google";

/** 配对窗口开着时跟着主进程变的部分。每次开始、做完一次配对，主进程都推一份新的给窗口。 */
export type PairingStatus = {
  readonly reason: PairingReason;
  readonly busy: PairingBusy | null;
};

export function reasonOf(pairing: Pairing): PairingReason {
  if (!pairing.desktop) return pairing.computer ? "desktop" : "first";
  return computerAuth(pairing) === "revoked" ? "computer" : "unfinished";
}

/**
 * 配对一次只做一件：用码配对和 Google 登录各会换出一台窗口设备，并行的话两台都记在云端，后写的覆盖先写的。
 * 正在做时再来一次，直接回绝，不排队：窗口这时已经把另一个按钮灰掉了，能走到这里的只有重复的点击。
 */
export class PairingRun {
  #current: { readonly kind: PairingBusy; readonly abort: AbortController } | null = null;
  readonly #onChange: () => void;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  get busy(): PairingBusy | null {
    return this.#current?.kind ?? null;
  }

  /** 成功返回 null，失败返回给人看的原因，和 `work` 一样。 */
  async run(kind: PairingBusy, work: (signal: AbortSignal) => Promise<string | null>): Promise<string | null> {
    if (this.#current) return "上一次配对还没做完。";
    const current = { kind, abort: new AbortController() };
    this.#current = current;
    this.#onChange();
    try {
      return await work(current.abort.signal);
    } finally {
      this.#current = null;
      this.#onChange();
    }
  }

  /** 不等了：在等浏览器的 Google 登录马上结束；用码配对的请求已经发出去，照样做完。 */
  cancel(): void {
    this.#current?.abort.abort();
  }
}
