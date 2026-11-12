import { utilityProcess, type UtilityProcess } from "electron";
import type { BrowserReply, BrowserRequest } from "../../cloud/bridge/browser.ts";
import type { BrowserFrame } from "../../cloud/src/bridge/protocol.ts";
import type { BridgeConfig } from "../../cloud/bridge/config.ts";
import type { MenubarAction, MenubarState } from "../../cloud/bridge/menubar.ts";
import { bridgeEnv } from "./env.ts";
import type { CaptureCommand, CaptureEvent } from "../../cloud/bridge/remote.ts";
import type { FromBridge, ToBridge } from "./messages.ts";

/** 跑了这么久才退出的，退避从头算。 */
const HEALTHY_MS = 60_000;
const MAX_DELAY_MS = 60_000;

export type SupervisorHooks = {
  onState(state: MenubarState): void;
  onRejected(): void;
  /** 桥让推流窗口做事。 */
  onCapture(command: CaptureCommand): void;
  /** 桥让 Pupu 浏览器做一步，做完用 `browserReply` 回。 */
  onBrowser(request: BrowserRequest): void;
  /** 桥意外退出，`delay` 毫秒后重启。 */
  onCrash(code: number, delay: number): void;
  log(line: string): void;
};

/**
 * 用 utilityProcess 托管桥：挂了就退避重启，重启后把凭据再发一遍。
 * 做法参考 deepchat 的 schedulerProcessManager（Apache-2.0，自己写的，没搬代码）。
 */
export class BridgeSupervisor {
  readonly #entry: string;
  readonly #hooks: SupervisorHooks;
  #child: UtilityProcess | null = null;
  #config: Extract<ToBridge, { type: "config" }> | null = null;
  #stopping = false;
  #failures = 0;
  #startedAt = 0;
  #timer: NodeJS.Timeout | null = null;

  constructor(entry: string, hooks: SupervisorHooks) {
    this.#entry = entry;
    this.#hooks = hooks;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** 给桥一份凭据。还没起就拉起来，已经在跑就换上新的。 */
  start(config: BridgeConfig, blocked: readonly string[], helpers: string | null): void {
    this.#stopping = false;
    this.#config = { type: "config", config, blocked, helpers };
    if (this.#child) this.#send(this.#config);
    else if (!this.#timer) this.#spawn();
  }

  action(action: MenubarAction): void {
    this.#send({ type: "action", action });
  }

  capture(event: CaptureEvent): void {
    this.#send({ type: "capture", event });
  }

  browserReply(reply: BrowserReply): void {
    this.#send(reply);
  }

  browserFrame(frame: Omit<BrowserFrame, "type">): void {
    this.#send({ type: "browser-frame", frame });
  }

  /** 让桥停掉命令、断开连接再退出；等不到就直接杀。 */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const child = this.#child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 4000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.#send({ type: "stop" });
    });
  }

  #send(message: ToBridge): void {
    this.#child?.postMessage(message);
  }

  #spawn(): void {
    this.#timer = null;
    this.#startedAt = Date.now();
    const child = utilityProcess.fork(this.#entry, [], {
      serviceName: "Pupu Bridge",
      stdio: "pipe",
      env: bridgeEnv()
    });
    this.#child = child;
    const pipe = (stream: NodeJS.ReadableStream | null) => {
      let rest = "";
      stream?.on("data", (chunk: Buffer) => {
        const lines = (rest + chunk.toString("utf8")).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) if (line) this.#hooks.log(line);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("spawn", () => {
      this.#hooks.log(`桥已启动，pid ${child.pid}`);
      if (this.#config) child.postMessage(this.#config);
    });
    child.on("message", (message: FromBridge) => {
      if (message.type === "state") this.#hooks.onState(message.state);
      else if (message.type === "rejected") this.#hooks.onRejected();
      else if (message.type === "capture") this.#hooks.onCapture(message.command);
      else if (message.type === "browser") this.#hooks.onBrowser(message);
    });
    child.on("exit", (code) => {
      if (this.#child === child) this.#child = null;
      if (this.#stopping) return;
      this.#failures = Date.now() - this.#startedAt > HEALTHY_MS ? 1 : this.#failures + 1;
      const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** Math.min(this.#failures - 1, 6));
      this.#hooks.onCrash(code, delay);
      this.#timer = setTimeout(() => this.#spawn(), delay);
    });
  }
}
