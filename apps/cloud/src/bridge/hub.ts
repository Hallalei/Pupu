import type { RunningCall } from "./activity.ts";
import {
  ALREADY_CONNECTED_CODE,
  BRIDGE_PING,
  BRIDGE_PONG,
  FIRST_BYTE_MS,
  FOREGROUND_DEFAULT_MS,
  REJECT_CODE,
  parseUpFrame,
  tokenFromRequest,
  tokenHash,
  type Action,
  type ComputerView,
  type DownFrame,
  type UpFrame
} from "./protocol.ts";
import type { DesktopDown, DesktopUp } from "./desktop.ts";
import {
  appendTail,
  disconnectedComputer,
  formatRun,
  fresh,
  selectComputer,
  unavailableComputer,
  type ComputerCandidate
} from "./status.ts";
import type { ComputerDirectory, ComputerRow } from "./store.ts";

const OPEN = 1;

/**
 * 一条桥连接上、能在休眠之后还读回来的状态。
 * 放在 Agents SDK 连接附件的 `__user` 里。
 */
export type BridgeLink = {
  readonly role: "bridge";
  readonly computerId: string;
  readonly name: string;
  readonly connectedAt: number;
  readonly ready: boolean;
  readonly seenPingAt?: number;
  readonly localRoot: string;
  readonly terminalsFolder: string;
};

/** 测试和 Durable Object 的 WebSocket 都能当这个用。 */
export interface BridgeSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  deserializeAttachment(): unknown;
  setState?(state: unknown): unknown;
}

export type ExecOutcome = {
  readonly ok: boolean;
  readonly text: string;
  readonly computerId?: string;
  readonly computerName?: string;
  readonly commandId?: string;
  readonly outputPath?: string;
  readonly image?: { readonly data: string; readonly mimeType: string };
};

type Waiter = {
  readonly socket: BridgeSocket;
  readonly frames: UpFrame[];
  failed: string | null;
  notify: (() => void) | null;
};

export type ComputerBridgeOptions = {
  readonly directory: ComputerDirectory;
  readonly sockets: () => readonly BridgeSocket[];
  readonly now: () => number;
  /** 自动心跳的时间。自动回复不叫醒 DO，所以在线与否靠它，而不是靠收到 ping。 */
  readonly heartbeatAt: (socket: BridgeSocket) => number | null;
};

/**
 * PupuDO 里的电脑桥接。一台电脑一条连接，请求按 requestId 流式回来。
 * 跑命令、写文件的去重在桥那边做：这类工具不能标成可重放，断线后续不上同一次调用。
 */
export class ComputerBridge {
  readonly #directory: ComputerDirectory;
  readonly #sockets: () => readonly BridgeSocket[];
  readonly #now: () => number;
  readonly #heartbeatAt: (socket: BridgeSocket) => number | null;
  readonly #waiters = new Map<string, Waiter>();
  /** 已经发给电脑、还没回完的调用。只在内存里：DO 重启后这些调用也作废了。 */
  readonly #running = new Map<string, RunningCall>();
  onChange: () => void = () => {};
  /** 有调用开始或者结束了。 */
  onActivity: () => void = () => {};
  /** 桥 hello 完、可以收活了。 */
  onReady: (computerId: string) => void = () => {};
  /** 用户在电脑的菜单栏上收回了屏幕控制。 */
  onTakeback: (computerId: string) => void = () => {};
  /** 桥发来的远程桌面消息。 */
  onDesktop: (computerId: string, session: string, message: DesktopUp) => void = () => {};
  /** 这台电脑的桥断了。 */
  onGone: (computerId: string) => void = () => {};
  /** 这个动作批过没有。批过的在 exec 帧里带上 approved，桥上的二次判断认它。 */
  approvedFor: (input: { requestId: string; computerId: string; action: Action }) => boolean = () => false;

  constructor(options: ComputerBridgeOptions) {
    this.#directory = options.directory;
    this.#sockets = options.sockets;
    this.#now = options.now;
    this.#heartbeatAt = options.heartbeatAt;
  }

  list(): ComputerView[] {
    const now = this.#now();
    const views = this.#directory.list().map((row) => this.#view(row, now));
    return views.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
    });
  }

  running(): RunningCall[] {
    return [...this.#running.values()];
  }

  async onConnect(socket: BridgeSocket, request: Request): Promise<void> {
    const token = tokenFromRequest(request);
    const row = token ? this.#directory.byTokenHash(await tokenHash(token)) : undefined;
    if (!row || row.revokedAt !== null) {
      this.#close(socket, REJECT_CODE, row ? "凭据已吊销" : "凭据无效");
      return;
    }
    this.#writeLink(socket, {
      role: "bridge",
      computerId: row.id,
      name: row.name,
      connectedAt: this.#now(),
      ready: false,
      localRoot: row.localRoot,
      terminalsFolder: row.terminalsFolder
    });
    this.#send(socket, { type: "welcome" });
  }

  async onMessage(socket: BridgeSocket, raw: string): Promise<void> {
    if (raw === BRIDGE_PING) {
      const link = readLink(socket);
      if (!link) return;
      this.#writeLink(socket, { ...link, seenPingAt: this.#now() });
      this.#send(socket, BRIDGE_PONG);
      return;
    }
    const frame = parseUpFrame(raw);
    if (!frame) return;
    if (frame.type === "hello") {
      await this.#hello(socket, frame);
      return;
    }
    if (frame.type === "takeback") {
      const link = readLink(socket);
      if (link?.ready) this.onTakeback(link.computerId);
      return;
    }
    if (frame.type === "desktop") {
      const link = readLink(socket);
      if (link?.ready) this.onDesktop(link.computerId, frame.session, frame.message);
      return;
    }
    const waiter = this.#waiters.get(frame.requestId);
    if (!waiter || waiter.socket !== socket) return;
    waiter.frames.push(frame);
    waiter.notify?.();
  }

  onClose(socket: BridgeSocket): void {
    let changed = false;
    for (const waiter of this.#waiters.values()) {
      if (waiter.socket !== socket || waiter.failed) continue;
      waiter.failed = "disconnected";
      waiter.notify?.();
      changed = true;
    }
    const link = readLink(socket);
    if (link?.ready) {
      changed = true;
      this.onGone(link.computerId);
    }
    if (changed) this.onChange();
  }

  disconnect(computerId: string, code: number, reason: string): void {
    for (const socket of this.#open()) {
      const link = readLink(socket);
      if (link?.computerId === computerId) this.#close(socket, code, reason);
    }
  }

  async exec(input: {
    requestId: string;
    computerId?: string;
    action: Action;
    /** 前台命令最多等这么久，到点就改到后台，不杀进程。 */
    timeoutMs?: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
  }): Promise<ExecOutcome> {
    const selected = selectComputer(this.list(), input.computerId);
    if (!selected.ok) return { ok: false, text: selected.text };
    const computer = selected.computer;
    const socket = this.#socketFor(computer.id);
    if (!socket) {
      return {
        ok: false,
        text: computer.stale ? staleText(computer) : offlineText(computer),
        computerId: computer.id,
        computerName: computer.name
      };
    }

    const waiter: Waiter = { socket, frames: [], failed: null, notify: null };
    this.#waiters.set(input.requestId, waiter);
    const approved = this.approvedFor({
      requestId: input.requestId,
      computerId: computer.id,
      action: input.action
    });
    const frame = {
      type: "exec",
      requestId: input.requestId,
      action: input.action,
      ...(approved ? { approved: true } : {})
    } satisfies DownFrame;
    if (!this.#send(socket, frame)) {
      this.#waiters.delete(input.requestId);
      return {
        ok: false,
        text: disconnectedComputer(computer.name),
        computerId: computer.id,
        computerName: computer.name
      };
    }

    this.#running.set(input.requestId, {
      callId: input.requestId,
      computerId: computer.id,
      action: input.action,
      startedAt: this.#now()
    });
    this.onActivity();
    try {
      return await this.#collect(input, computer, waiter);
    } finally {
      this.#waiters.delete(input.requestId);
      this.#running.delete(input.requestId);
      this.onActivity();
    }
  }

  async #hello(
    socket: BridgeSocket,
    frame: Extract<UpFrame, { type: "hello" }>
  ): Promise<void> {
    const link = readLink(socket);
    if (!link || frame.computerId !== link.computerId) {
      this.#close(socket, REJECT_CODE, "电脑和凭据对不上");
      return;
    }
    if (!isAbsolutePath(frame.localRoot) || !isAbsolutePath(frame.terminalsFolder)) {
      this.#close(socket, REJECT_CODE, "路径不是绝对路径");
      return;
    }
    const others = this.#open().filter((other) => {
      if (other === socket) return false;
      return readLink(other)?.computerId === link.computerId;
    });
    const healthy = others.find((other) => {
      const otherLink = readLink(other);
      return otherLink?.ready && fresh(this.#lastBeat(other, otherLink), this.#now());
    });
    if (healthy) {
      this.#close(socket, ALREADY_CONNECTED_CODE, "这台电脑已经连着");
      return;
    }
    for (const other of others) this.#close(other, 1000, "replaced");

    const name = frame.name.trim().slice(0, 80) || link.name;
    const next: BridgeLink = {
      ...link,
      name,
      ready: true,
      localRoot: frame.localRoot,
      terminalsFolder: frame.terminalsFolder
    };
    this.#writeLink(socket, next);
    this.#directory.markSeen(link.computerId, {
      name,
      localRoot: frame.localRoot,
      terminalsFolder: frame.terminalsFolder,
      seenAt: this.#now()
    });
    this.onChange();
    this.onReady(link.computerId);
  }

  /** 把菜单栏要显示的状态推给这台电脑。没连着就算了，连上时会再推。 */
  sendStatus(computerId: string, status: { pending: readonly string[]; screen: boolean }): void {
    const socket = this.#socketFor(computerId);
    if (!socket) return;
    this.#send(socket, { type: "status", pending: status.pending, screen: status.screen } satisfies DownFrame);
  }

  /** 把远程桌面的消息发给这台电脑的桥。没连着返回 false。 */
  sendDesktop(computerId: string, session: string, message: DesktopDown): boolean {
    const socket = this.#socketFor(computerId);
    return socket ? this.#send(socket, { type: "desktop", session, message } satisfies DownFrame) : false;
  }

  async #collect(
    input: {
      requestId: string;
      action: Action;
      timeoutMs?: number;
      signal?: AbortSignal;
      onOutput?: (chunk: string) => void;
    },
    computer: ComputerCandidate,
    waiter: Waiter
  ): Promise<ExecOutcome> {
    const first = await this.#next(waiter, input.signal, FIRST_BYTE_MS);
    if (first === "timeout") {
      this.#send(waiter.socket, { type: "cancel", requestId: input.requestId });
      return fail(computer, unavailableComputer(computer.name));
    }
    if (first === "abort") {
      this.#send(waiter.socket, { type: "cancel", requestId: input.requestId });
      return fail(computer, "这台电脑上的命令已经取消。");
    }
    if (first === "dead") return fail(computer, disconnectedComputer(computer.name));
    if (first.type === "error") return fail(computer, `在「${computer.name}」上没做成：${first.message}`);

    if (input.action.kind === "run") {
      return this.#collectRun(
        { ...input, action: input.action, timeoutMs: input.timeoutMs ?? FOREGROUND_DEFAULT_MS },
        computer,
        waiter,
        first
      );
    }
    return this.#collectSimple(input.requestId, computer, waiter, first, input.signal);
  }

  async #collectRun(
    input: {
      requestId: string;
      action: Extract<Action, { kind: "run" }>;
      timeoutMs: number;
      signal?: AbortSignal;
      onOutput?: (chunk: string) => void;
    },
    computer: ComputerCandidate,
    waiter: Waiter,
    first: UpFrame
  ): Promise<ExecOutcome> {
    let started = first.type === "started" ? first : null;
    let output = "";
    let truncated = false;
    const takeOutput = (text: string) => {
      const next = appendTail(output, text);
      output = next.text;
      truncated = truncated || next.truncated;
      input.onOutput?.(text);
    };
    if (first.type === "output") takeOutput(first.text);
    if (!started) {
      const frame = await this.#until(
        waiter,
        input.signal,
        FIRST_BYTE_MS,
        (item) => item.type === "started" || item.type === "error" || item.type === "exit",
        (item) => {
          if (item.type === "output") takeOutput(item.text);
        }
      );
      if (frame === "timeout") {
        this.#send(waiter.socket, { type: "cancel", requestId: input.requestId });
        return fail(computer, unavailableComputer(computer.name));
      }
      if (frame === "abort") {
        this.#send(waiter.socket, { type: "cancel", requestId: input.requestId });
        return fail(computer, "这台电脑上的命令已经取消。");
      }
      if (frame === "dead") return fail(computer, disconnectedComputer(computer.name));
      if (frame.type === "error") return fail(computer, `在「${computer.name}」上没做成：${frame.message}`);
      if (frame.type === "started") started = frame;
      if (frame.type === "exit" && started) {
        return doneRun(computer, started, output, truncated, frame.code, false);
      }
    }
    if (!started) return fail(computer, unavailableComputer(computer.name));
    if (input.action.background) {
      return {
        ok: true,
        computerId: computer.id,
        computerName: computer.name,
        commandId: started.commandId,
        outputPath: started.outputPath,
        text: `已经在「${computer.name}」上开始跑，命令还在继续。用 read_file 看输出，用 write_stdin 往里写输入。\n命令 id：${started.commandId}\n输出文件：${started.outputPath}`
      };
    }

    const deadline = this.#now() + input.timeoutMs;
    while (true) {
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        this.#send(waiter.socket, { type: "detach", requestId: input.requestId });
        return doneRun(computer, started, output, truncated, undefined, true);
      }
      const frame = await this.#next(waiter, input.signal, remaining);
      if (frame === "timeout") {
        this.#send(waiter.socket, { type: "detach", requestId: input.requestId });
        return doneRun(computer, started, output, truncated, undefined, true);
      }
      if (frame === "abort") {
        this.#send(waiter.socket, { type: "cancel", requestId: input.requestId });
        return fail(computer, "这台电脑上的命令已经取消。", started);
      }
      if (frame === "dead") return fail(computer, disconnectedComputer(computer.name, started.outputPath), started);
      if (frame.type === "output") takeOutput(frame.text);
      else if (frame.type === "error") return fail(computer, `在「${computer.name}」上没做成：${frame.message}`, started);
      else if (frame.type === "exit") return doneRun(computer, started, output, truncated, frame.code, false);
    }
  }

  async #collectSimple(
    requestId: string,
    computer: ComputerCandidate,
    waiter: Waiter,
    first: UpFrame,
    signal: AbortSignal | undefined
  ): Promise<ExecOutcome> {
    let frame = first;
    const pieces: string[] = [];
    for (let hop = 0; hop < 8; hop += 1) {
      if (frame.type === "error") return fail(computer, `在「${computer.name}」上没做成：${frame.message}`);
      if (frame.type === "done") {
        return {
          ok: true,
          computerId: computer.id,
          computerName: computer.name,
          text: frame.path
            ? `在「${computer.name}」上写好了：${frame.path}`
            : `在「${computer.name}」上做完了。`
        };
      }
      if (frame.type === "data") return this.#fileText(computer, frame);
      if (frame.type === "listed") return this.#listText(computer, frame);
      if (frame.type === "picture") return this.#picture(computer, frame);
      if (frame.type === "output") pieces.push(frame.text);
      const next = await this.#next(waiter, signal, FIRST_BYTE_MS);
      if (typeof next === "string") {
        if (next === "abort") this.#send(waiter.socket, { type: "cancel", requestId });
        return fail(
          computer,
          next === "dead" ? disconnectedComputer(computer.name) : unavailableComputer(computer.name)
        );
      }
      frame = next;
    }
    return fail(computer, unavailableComputer(computer.name));
  }

  #picture(
    computer: ComputerCandidate,
    frame: Extract<UpFrame, { type: "picture" }>
  ): ExecOutcome {
    return {
      ok: true,
      computerId: computer.id,
      computerName: computer.name,
      image: { data: frame.data, mimeType: frame.mime },
      text: `在「${computer.name}」上看了窗口，截图 ${frame.width}×${frame.height} 像素，原点在窗口左上角。${
        frame.summary ? `\n${frame.summary}` : ""
      }`
    };
  }

  #fileText(
    computer: ComputerCandidate,
    frame: Extract<UpFrame, { type: "data" }>
  ): ExecOutcome {
    if (frame.binary) {
      return {
        ok: false,
        computerId: computer.id,
        computerName: computer.name,
        text: `在「${computer.name}」上，这个文件看起来是二进制的（${frame.bytes} 字节），没有当作文本读。`
      };
    }
    const note = frame.truncated ? `文件有 ${frame.bytes} 字节，这里是开头一部分。\n` : "";
    return {
      ok: true,
      computerId: computer.id,
      computerName: computer.name,
      text: `${note}${frame.text ?? ""}`
    };
  }

  #listText(
    computer: ComputerCandidate,
    frame: Extract<UpFrame, { type: "listed" }>
  ): ExecOutcome {
    const lines = frame.entries.map((entry) => {
      const mark = entry.kind === "dir" ? "/" : "";
      return `${entry.name}${mark}`;
    });
    const tail = frame.truncated ? "\n（还有更多，没有列完）" : "";
    return {
      ok: true,
      computerId: computer.id,
      computerName: computer.name,
      text: lines.length ? `${lines.join("\n")}${tail}` : `（空目录）${tail}`
    };
  }

  #view(row: ComputerRow, now: number): ComputerView {
    const socket = this.#socketFor(row.id);
    const link = socket ? readLink(socket) : null;
    const lastBeat = socket && link ? this.#lastBeat(socket, link) : null;
    const alive = Boolean(socket && link?.ready && lastBeat !== null && fresh(lastBeat, now));
    const stale = Boolean(socket && link?.ready && !alive);
    if (alive && lastBeat !== null && (row.lastSeenAt === null || lastBeat - row.lastSeenAt > 5_000)) {
      this.#directory.markSeen(row.id, { seenAt: lastBeat });
    }
    return {
      id: row.id,
      name: link?.ready ? link.name : row.name,
      ownerId: row.ownerId,
      online: alive,
      stale,
      lastSeenAt: lastBeat ?? row.lastSeenAt,
      policy: row.policy,
      screen: row.screenUntil !== null && row.screenUntil > now
    };
  }

  #socketFor(computerId: string): BridgeSocket | null {
    let found: BridgeSocket | null = null;
    let best = -1;
    for (const socket of this.#open()) {
      const link = readLink(socket);
      if (!link?.ready || link.computerId !== computerId) continue;
      const beat = this.#lastBeat(socket, link);
      if (beat >= best) {
        best = beat;
        found = socket;
      }
    }
    return found;
  }

  #lastBeat(socket: BridgeSocket, link: BridgeLink): number {
    return Math.max(link.connectedAt, link.seenPingAt ?? 0, this.#heartbeatAt(socket) ?? 0);
  }

  #open(): BridgeSocket[] {
    return this.#sockets().filter((socket) => socket.readyState === OPEN);
  }

  #writeLink(socket: BridgeSocket, link: BridgeLink): void {
    if (socket.setState) {
      socket.setState(link);
      return;
    }
    const current = socket.deserializeAttachment();
    const base = current && typeof current === "object" ? { ...(current as object) } : {};
    const withAttachment = socket as BridgeSocket & { serializeAttachment?(value: unknown): void };
    withAttachment.serializeAttachment?.({ ...base, __user: link });
  }

  #send(socket: BridgeSocket, frame: object | string): boolean {
    if (socket.readyState !== OPEN) return false;
    try {
      socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  #close(socket: BridgeSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // 已经关了。
    }
  }

  async #until(
    waiter: Waiter,
    signal: AbortSignal | undefined,
    ms: number,
    done: (frame: UpFrame) => boolean,
    ignore: (frame: UpFrame) => void
  ): Promise<UpFrame | "timeout" | "abort" | "dead"> {
    const deadline = this.#now() + ms;
    while (true) {
      const remaining = deadline - this.#now();
      if (remaining <= 0) return "timeout";
      const frame = await this.#next(waiter, signal, remaining);
      if (typeof frame === "string") return frame;
      if (done(frame)) return frame;
      ignore(frame);
    }
  }

  #next(
    waiter: Waiter,
    signal: AbortSignal | undefined,
    ms: number
  ): Promise<UpFrame | "timeout" | "abort" | "dead"> {
    if (waiter.failed) return Promise.resolve("dead");
    const buffered = waiter.frames.shift();
    if (buffered) return Promise.resolve(buffered);
    if (signal?.aborted) return Promise.resolve("abort");
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: UpFrame | "timeout" | "abort" | "dead") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiter.notify = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish("timeout"), ms);
      const onAbort = () => finish("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
      waiter.notify = () => {
        if (waiter.failed) finish("dead");
        else if (waiter.frames.length > 0) finish(waiter.frames.shift()!);
      };
    });
  }
}

function fail(
  computer: ComputerCandidate,
  text: string,
  started?: { commandId: string; outputPath: string }
): ExecOutcome {
  return {
    ok: false,
    text,
    computerId: computer.id,
    computerName: computer.name,
    ...(started ? { commandId: started.commandId, outputPath: started.outputPath } : {})
  };
}

function doneRun(
  computer: ComputerCandidate,
  started: { commandId: string; outputPath: string },
  output: string,
  truncated: boolean,
  exitCode: number | null | undefined,
  timedOut: boolean
): ExecOutcome {
  const formatted = formatRun({
    name: computer.name,
    commandId: started.commandId,
    outputPath: started.outputPath,
    output,
    truncated,
    exitCode,
    timedOut
  });
  return {
    ok: formatted.ok,
    text: formatted.text,
    computerId: computer.id,
    computerName: computer.name,
    commandId: started.commandId,
    outputPath: started.outputPath
  };
}

function staleText(computer: ComputerCandidate): string {
  return `「${computer.name}」心跳停了，先当成用不了。等它回来再做。`;
}

function offlineText(computer: ComputerCandidate): string {
  return `「${computer.name}」现在没连上。桥要在这台电脑上开着，才能在上面跑命令。等它回来再做。`;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

export function readLink(socket: { deserializeAttachment(): unknown }): BridgeLink | null {
  let attachment: unknown;
  try {
    attachment = socket.deserializeAttachment();
  } catch {
    return null;
  }
  if (!attachment || typeof attachment !== "object") return null;
  const user = "__user" in attachment ? (attachment as { __user?: unknown }).__user : null;
  if (!user || typeof user !== "object") return null;
  const link = user as Partial<BridgeLink>;
  if (link.role !== "bridge" || typeof link.computerId !== "string") return null;
  if (typeof link.connectedAt !== "number" || typeof link.name !== "string") return null;
  return {
    role: "bridge",
    computerId: link.computerId,
    name: link.name,
    connectedAt: link.connectedAt,
    ready: link.ready === true,
    ...(typeof link.seenPingAt === "number" ? { seenPingAt: link.seenPingAt } : {}),
    localRoot: typeof link.localRoot === "string" ? link.localRoot : "",
    terminalsFolder: typeof link.terminalsFolder === "string" ? link.terminalsFolder : ""
  };
}
