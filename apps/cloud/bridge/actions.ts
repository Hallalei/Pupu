import { spawn, type ChildProcess } from "node:child_process";
import { open, mkdir, readdir, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isScreenInput, usesScreen } from "../src/bridge/policy.ts";
import { performComputer } from "./computer.ts";
import { containPath } from "./contain.ts";
import { localRefusal, readLocal } from "./local.ts";
import {
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  MAX_TRANSFER_BYTES,
  FINISHED_TAIL_CHARS,
  OUTPUT_TAIL_CHARS,
  safeRequestId,
  type Action,
  type UpFrame
} from "../src/bridge/protocol.ts";

/**
 * 去重记录：会改电脑的动作按请求 id 落一个文件，同一次调用再送来，照记录回，不做第二遍。
 * running 是做到一半；桥启动时还停在 running 的，是上次做到一半桥退出了，改成 interrupted。
 */
type DedupeRecord = {
  status: "running" | "done" | "cancelled" | "interrupted";
  kind: string;
  commandId?: string;
  outputPath?: string;
  output?: string;
  exitCode?: number | null;
  error?: string;
  path?: string;
};

/**
 * 一次调用在桥上走到哪了。收到 exec 当下就登记，云端的取消什么时候到都找得到它。
 * 云端那边同一次调用怎么结束的，见 src/bridge/hub.ts 的 `CallEnd`。
 */
type Phase =
  /** 收下了，还没动手：查开关、去重、等远程桌面的人停手。这时取消，就不做了。 */
  | { readonly name: "waiting" }
  /** 取消在动手之前到了，已经回过 cancelled。走到动手那一步看到它就收手。 */
  | { readonly name: "cancelled" }
  /** 在做。结果、命令的输出和退出都往云端送。 */
  | { readonly name: "running" }
  /** 命令在停，退出那一帧说是谁停的。 */
  | { readonly name: "stopping"; readonly by: "user" | "cloud" }
  /**
   * 这次调用交出去了：后台命令、前台到时间转后台，或者桥要退出。进程留着，这次调用不再回帧；
   * 命令退出时另发一帧 finished（见 `reportFinished`），`stopped` 是谁停的。
   */
  | { readonly name: "detached"; readonly stopped?: "user" | "cloud" };

type Call = {
  readonly requestId: string;
  readonly action: Action;
  /** 这次调用来的那条连接。 */
  readonly send: (frame: UpFrame) => void;
  phase: Phase;
  /** 命令的进程。别的动作没有。 */
  process: {
    readonly child: ChildProcess;
    readonly commandId: string;
    readonly outputPath: string;
    readonly command: string;
    readonly startedAt: number;
  } | null;
};

const WAITING: Phase = { name: "waiting" };
const RUNNING: Phase = { name: "running" };
const DETACHED: Phase = { name: "detached" };

/** 桥上的调用，从收到 exec 到最后一帧发出去；命令的话到进程退出。 */
const calls = new Map<string, Call>();

/** 动手前最后一刻问一句：没被取消就开始做。 */
function begin(call: Call): boolean {
  if (call.phase.name !== "waiting") return false;
  call.phase = RUNNING;
  return true;
}

/** 云端取消。没动手的不做了，回一帧 cancelled；命令在跑就停掉，退出时回 exit。 */
export function cancelCall(requestId: string): void {
  const call = calls.get(requestId);
  if (!call) return;
  switch (call.phase.name) {
    case "waiting":
      call.phase = { name: "cancelled" };
      call.send({ type: "cancelled", requestId });
      return;
    case "running":
    case "detached":
      // 不是命令的（屏幕操作、读写文件）已经在做，停不下来；做完照常回结果，云端就知道它做了。
      stop(call, "cloud");
      return;
    default:
      return;
  }
}

/** 云端说前台等到时间了：进程继续跑，输出不再往连接上送。 */
export function detachCall(requestId: string): void {
  const call = calls.get(requestId);
  if (call?.phase.name === "running") call.phase = DETACHED;
}

/** 菜单栏上的「停止正在跑的命令」。云端还在等的那条，退出时告诉它是用户停的。 */
export function stopCommands(): void {
  for (const call of calls.values()) stop(call, "user");
}

/** 桥自己要退出：所有命令都停，还没动手的不做了。连接马上就关，不再回帧。 */
export function stopAllJobs(): void {
  quitting = true;
  for (const call of calls.values()) {
    call.phase = DETACHED;
    if (call.process) killChild(call.process.child);
  }
}

function stop(call: Call, by: "user" | "cloud"): void {
  if (!call.process) return;
  if (call.phase.name === "running") call.phase = { name: "stopping", by };
  else if (call.phase.name === "detached") call.phase = { name: "detached", stopped: by };
  killChild(call.process.child);
}

type Finished = Extract<UpFrame, { type: "finished" }>;

/** 交出去的命令退出了、还没送到云端的。桥没连着时先攒着，最多留这么多条。 */
const FINISHED_QUEUE = 20;
const finishedQueue: Finished[] = [];
let finishedSink: ((frame: UpFrame) => boolean) | null = null;
/** 桥在退出：命令是它停的，不用报。 */
let quitting = false;

/** 云端收下 hello 后接上当前连接，连接断了传 null。接上时把攒着的送出去。 */
export function reportFinishedTo(send: ((frame: UpFrame) => boolean) | null): void {
  finishedSink = send;
  while (finishedSink && finishedQueue.length > 0) {
    if (!finishedSink(finishedQueue[0]!)) return;
    finishedQueue.shift();
  }
}

function reportFinished(frame: Finished): void {
  if (quitting) return;
  finishedQueue.push(frame);
  if (finishedQueue.length > FINISHED_QUEUE) finishedQueue.shift();
  reportFinishedTo(finishedSink);
}

/** 这次调用的帧还送不送：取消过、交出去了的就不送了。 */
function reporting(call: Call): boolean {
  return call.phase.name !== "cancelled" && call.phase.name !== "detached";
}

/** 调用结束，从表里拿掉。屏幕操作记下时间，菜单栏「刚做完」靠它。 */
function forget(call: Call): void {
  if (calls.get(call.requestId) !== call) return;
  calls.delete(call.requestId);
  if (usesScreen(call.action)) {
    lastScreenAt = Date.now();
    // 「刚做完」那段时间过了，再通知一次，让菜单栏换回来。
    setTimeout(changed, SCREEN_RECENT_MS + 100).unref();
  }
  changed();
}

// ---- 给菜单栏看的：在跑的命令、是不是在操作屏幕 ----

const listeners = new Set<() => void>();
let lastScreenAt = 0;

/** 在跑的命令或屏幕操作变了就通知。返回取消订阅。 */
export function onActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  for (const listener of listeners) listener();
}

/** 还在跑的命令，先开始的在前。 */
export function runningCommands(): { requestId: string; command: string; startedAt: number }[] {
  return [...calls.values()]
    .flatMap((call) => (call.process ? [{ requestId: call.requestId, command: call.process.command, startedAt: call.process.startedAt }] : []))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** 正在做屏幕操作，或者刚做完不久。 */
export function screenActivity(now = Date.now()): { active: boolean; lastAt: number } {
  const busy = [...calls.values()].some((call) => usesScreen(call.action));
  return { active: busy || now - lastScreenAt < SCREEN_RECENT_MS, lastAt: lastScreenAt };
}

/** 屏幕操作之后这么久，菜单栏还显示「正在操作屏幕」。 */
export const SCREEN_RECENT_MS = 8_000;

export type ActionHost = {
  readonly root: string;
  readonly terminals: string;
  readonly requests: string;
  /** 这些绝对路径不让文件工具碰，比如桥的凭据。 */
  readonly blocked: readonly string[];
  send(frame: UpFrame): void;
};

/**
 * 执行云端发来的一个动作。会改电脑的命令和写文件按 requestId 去重，
 * 同一次调用再送来，不跑第二遍。
 */
export async function perform(
  requestId: string,
  action: Action,
  host: ActionHost,
  approved = false
): Promise<void> {
  const existing = calls.get(requestId);
  if (existing) {
    host.send({ type: "error", requestId, message: alreadyRunning(existing.process?.outputPath) });
    return;
  }
  const call: Call = { requestId, action, send: host.send, phase: WAITING, process: null };
  calls.set(requestId, call);
  changed();
  // 往下的帧都过这一道：取消过、交出去了的这次调用不再回话。
  const reply: ActionHost = {
    ...host,
    send(frame) {
      if (reporting(call)) host.send(frame);
    }
  };
  try {
    const refusal = localRefusal(action, approved, await readLocal(), host.root);
    if (refusal) reply.send({ type: "error", requestId, message: refusal });
    else await performAction(call, reply);
  } finally {
    if (!call.process) forget(call);
  }
}

function alreadyRunning(outputPath: string | undefined): string {
  return `这个请求已经在这台电脑上执行，没有重复跑。${outputPath ? `输出文件：${outputPath}` : ""}`.trim();
}

async function performAction(call: Call, host: ActionHost): Promise<void> {
  const { requestId, action } = call;
  if (action.kind === "read" || action.kind === "list" || (action.kind === "computer" && !isScreenInput(action))) {
    // 只是看，没有要等的副作用；取消了也不碍事，回的帧会被挡掉。
    if (!begin(call)) return;
    try {
      if (action.kind === "read") await read(requestId, action.path, action.maxBytes, host);
      else if (action.kind === "list") await list(requestId, action.path, host);
      else await performComputer(requestId, action, host);
    } catch (error) {
      host.send({ type: "error", requestId, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const claim = await claimRequest(host.requests, requestId, action.kind);
  if (claim.state === "done") {
    replay(requestId, claim.record, host);
    return;
  }
  if (claim.state === "running") {
    host.send({ type: "error", requestId, message: alreadyRunning(claim.record.outputPath) });
    return;
  }
  try {
    const ran =
      action.kind === "run"
        ? await run(call, action, host, claim.file)
        : action.kind === "write"
          ? await write(call, action, host, claim.file)
          : action.kind === "stdin"
            ? await writeStdin(call, action, host, claim.file)
            : await performComputer(requestId, action, host, () => begin(call));
    if (!ran) await writeRecord(claim.file, { status: "cancelled", kind: action.kind });
    else if (action.kind === "computer") await writeRecord(claim.file, { status: "done", kind: action.kind });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeRecord(claim.file, { status: "done", kind: action.kind, error: message });
    host.send({ type: "error", requestId, message });
  }
}

async function run(
  call: Call,
  action: Extract<Action, { kind: "run" }>,
  host: ActionHost,
  recordFile: string
): Promise<boolean> {
  const { requestId } = call;
  const command = action.command.trim();
  if (!command) throw new Error("命令不能是空的。");
  await mkdir(host.terminals, { recursive: true, mode: 0o700 });
  const commandId = safeRequestId(requestId);
  const outputPath = path.join(host.terminals, `${commandId}.log`);
  const file = await open(outputPath, "a", 0o600);
  const log = createLogWriter(file);
  await log.write(`$ ${command}\ncwd: ${host.root}\nstarted: ${new Date().toISOString()}\n\n`);
  await writeRecord(recordFile, { status: "running", kind: "run", commandId, outputPath });
  // 从这里到 spawn 不能有 await，不然取消会从缝里漏过去。
  if (!begin(call)) {
    await log.write("--- 取消了，没有跑 ---\n");
    await log.close();
    return false;
  }
  const child = spawn(loginShell(), ["-lc", command], {
    cwd: host.root,
    detached: true,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  call.process = { child, commandId, outputPath, command, startedAt: Date.now() };
  changed();
  // 监听要在任何 await 之前挂上，不然很短的命令会在监听前就退出，输出丢了。
  let tail = "";
  const push = createPusher(() => reporting(call), (text) => {
    host.send({ type: "output", requestId, text });
  });
  const onChunk = (chunk: Buffer) => {
    void log.write(chunk);
    const text = chunk.toString("utf8");
    tail = `${tail}${text}`.slice(-OUTPUT_TAIL_CHARS);
    push.add(text);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  const ended = (code: number | null, error?: string) => {
    push.flush();
    void finish(call, recordFile, log, code, error, host, tail);
  };
  child.once("error", (error) => {
    ended(null, error instanceof Error ? error.message : String(error));
  });
  child.once("exit", (code) => {
    ended(code);
  });
  host.send({ type: "started", requestId, commandId, outputPath });
  if (action.background) call.phase = DETACHED;
  return true;
}

/** 命令退出了：记下结果。云端还在等的话回 exit，被停掉的说是谁停的。 */
async function finish(
  call: Call,
  recordFile: string,
  log: LogWriter,
  code: number | null,
  error: string | undefined,
  host: ActionHost,
  tail: string
): Promise<void> {
  // 退出和启动失败都会进来。只收尾一次，避免把同一段结果送两遍。
  if (calls.get(call.requestId) !== call || !call.process) return;
  const { requestId, phase } = call;
  const { commandId, outputPath, command } = call.process;
  forget(call);
  try {
    await log.write(`\n--- exit ${error ? "error" : String(code)} ---\n`);
  } catch {
    // 文件已经关上了。
  }
  await log.close().catch(() => {});
  await writeRecord(recordFile, {
    status: "done",
    kind: "run",
    commandId,
    outputPath,
    output: tail,
    ...(error ? { error } : { exitCode: code })
  });
  if (error) host.send({ type: "error", requestId, message: error });
  else host.send({ type: "exit", requestId, code, ...(phase.name === "stopping" ? { stopped: phase.by } : {}) });
  if (phase.name === "detached") {
    reportFinished({
      type: "finished",
      requestId,
      commandId,
      command,
      code: error ? null : code,
      outputPath,
      tail: (error ? `${tail}\n${error}` : tail).slice(-FINISHED_TAIL_CHARS),
      ...(phase.stopped ? { stopped: phase.stopped } : {})
    });
  }
}

async function write(
  call: Call,
  action: Extract<Action, { kind: "write" }>,
  host: ActionHost,
  recordFile: string
): Promise<boolean> {
  const bytes = Buffer.byteLength(action.content);
  if (bytes > MAX_TRANSFER_BYTES) throw new Error("文件超过 100 MiB，没有写。");
  const target = await containPath(host.root, action.path, host.blocked);
  if (!target) throw new Error("路径超出这台电脑的主目录。");
  await mkdir(path.dirname(target), { recursive: true });
  if (!begin(call)) return false;
  await writeFile(target, action.content, "utf8");
  await writeRecord(recordFile, { status: "done", kind: "write", path: target });
  host.send({ type: "done", requestId: call.requestId, path: target });
  return true;
}

async function writeStdin(
  call: Call,
  action: Extract<Action, { kind: "stdin" }>,
  host: ActionHost,
  recordFile: string
): Promise<boolean> {
  const child = [...calls.values()].find((other) => other.process?.commandId === action.commandId)?.process?.child;
  if (!child || child.exitCode !== null || child.stdin === null) {
    throw new Error("找不到这个正在跑的命令，可能已经结束，或者桥重启过。输出还在终端文件里。");
  }
  const stdin = child.stdin;
  if (!begin(call)) return false;
  await new Promise<void>((resolve, reject) => {
    stdin.write(action.data, "utf8", (error) => {
      if (error) reject(new Error("没能写进标准输入。"));
      else resolve();
    });
  });
  if (action.eof) stdin.end();
  await writeRecord(recordFile, { status: "done", kind: "stdin", commandId: action.commandId });
  host.send({ type: "done", requestId: call.requestId });
  return true;
}

async function read(
  requestId: string,
  requested: string,
  maxBytes: number,
  host: ActionHost
): Promise<void> {
  const target = await containPath(host.root, requested, host.blocked);
  if (!target) {
    host.send({ type: "error", requestId, message: "路径超出这台电脑的主目录。" });
    return;
  }
  let file: FileHandle;
  try {
    file = await open(target, "r");
  } catch (error) {
    host.send({ type: "error", requestId, message: fileError(error) });
    return;
  }
  try {
    const info = await file.stat();
    if (info.isDirectory()) {
      host.send({ type: "error", requestId, message: "这是一个目录，用列目录看。" });
      return;
    }
    const limit = Math.min(Math.max(1, maxBytes), MAX_READ_BYTES, MAX_TRANSFER_BYTES);
    const bytes = Math.min(info.size, limit);
    const buffer = Buffer.alloc(bytes);
    await file.read(buffer, 0, bytes, 0);
    if (buffer.includes(0)) {
      host.send({ type: "data", requestId, bytes: info.size, binary: true });
      return;
    }
    host.send({
      type: "data",
      requestId,
      bytes: info.size,
      text: buffer.toString("utf8"),
      ...(info.size > bytes ? { truncated: true } : {})
    });
  } finally {
    await file.close();
  }
}

async function list(requestId: string, requested: string, host: ActionHost): Promise<void> {
  const target = await containPath(host.root, requested, host.blocked);
  if (!target) {
    host.send({ type: "error", requestId, message: "路径超出这台电脑的主目录。" });
    return;
  }
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (error) {
    host.send({ type: "error", requestId, message: fileError(error) });
    return;
  }
  const sorted = entries
    .map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? ("dir" as const) : entry.isFile() ? ("file" as const) : ("other" as const)
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  host.send({
    type: "listed",
    requestId,
    entries: sorted.slice(0, MAX_LIST_ENTRIES),
    truncated: sorted.length > MAX_LIST_ENTRIES
  });
}

function replay(requestId: string, record: DedupeRecord, host: ActionHost): void {
  if (record.status === "cancelled") {
    host.send({ type: "cancelled", requestId });
    return;
  }
  if (record.status === "interrupted") {
    const where = record.outputPath ? `输出文件：${record.outputPath}` : "";
    host.send({
      type: "error",
      requestId,
      message: `上次开始做这一步时桥退出了（崩溃或者更新），不知道做完没有，没有再做一遍。${where}`
    });
    return;
  }
  if (record.error) {
    host.send({ type: "error", requestId, message: record.error });
    return;
  }
  if (record.kind === "run" && record.commandId && record.outputPath) {
    host.send({
      type: "started",
      requestId,
      commandId: record.commandId,
      outputPath: record.outputPath
    });
    if (record.output) host.send({ type: "output", requestId, text: record.output });
    host.send({ type: "exit", requestId, code: record.exitCode ?? null });
    return;
  }
  host.send({ type: "done", requestId, ...(record.path ? { path: record.path } : {}) });
}

async function claimRequest(
  directory: string,
  requestId: string,
  kind: string
): Promise<{ state: "fresh"; file: string } | { state: "running" | "done"; record: DedupeRecord; file: string }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await pruneRequests(directory);
  const file = path.join(directory, `${safeRequestId(requestId)}.json`);
  const fresh: DedupeRecord = { status: "running", kind };
  try {
    await writeFile(file, JSON.stringify(fresh), { flag: "wx", mode: 0o600 });
    return { state: "fresh", file };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") throw error;
  }
  const record = await readRecord(file);
  if (!record) return { state: "fresh", file };
  return { state: record.status === "running" ? "running" : "done", record, file };
}

/** 桥启动时对账：还停在「在做」的记录，是上次做到一半桥退出了，改成中断，重放时照实说。 */
export async function reconcileRequests(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      const file = path.join(directory, name);
      const record = await readRecord(file);
      if (record?.status === "running") await writeRecord(file, { ...record, status: "interrupted" });
    })
  );
}

async function readRecord(file: string): Promise<DedupeRecord | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as DedupeRecord;
  } catch {
    return null;
  }
}

async function writeRecord(file: string, record: DedupeRecord): Promise<void> {
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
}

async function pruneRequests(directory: string): Promise<void> {
  const names = await readdir(directory);
  if (names.length <= 200) return;
  const files = await Promise.all(
    names.map(async (name) => {
      const full = path.join(directory, name);
      const info = await stat(full);
      return { full, mtime: info.mtimeMs };
    })
  );
  files.sort((a, b) => a.mtime - b.mtime);
  await Promise.all(files.slice(0, files.length - 150).map((file) => rm(file.full, { force: true })));
}

function fileError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "没有这个文件。";
  if (code === "EISDIR") return "这是一个目录。";
  if (code === "EACCES" || code === "EPERM") return "没有权限碰这个路径。";
  return "没能读这个路径。";
}

function loginShell(): string {
  const shell = process.env.SHELL;
  if (shell && shell.startsWith("/")) return shell;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function killChild(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 已经退出了。
    }
  }
}

type LogWriter = {
  write(chunk: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
};

/** 同一条日志上的写入排成队，避免输出块和结尾行交错。 */
function createLogWriter(file: FileHandle): LogWriter {
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<unknown>): Promise<void> => {
    const run = chain.then(work).then(() => undefined);
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    write(chunk) {
      if (typeof chunk === "string") return enqueue(() => file.write(chunk));
      return enqueue(() => file.write(chunk));
    },
    close() {
      return enqueue(() => file.close());
    }
  };
}

function createPusher(
  enabled: () => boolean,
  send: (text: string) => void
): { add(text: string): void; flush(): void } {
  let buffer = "";
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!buffer || !enabled()) {
      buffer = "";
      return;
    }
    const text = buffer;
    buffer = "";
    send(text);
  };
  return {
    add(text: string) {
      buffer += text;
      if (!enabled()) return;
      if (buffer.length >= 16_000) flush();
      else if (!timer) timer = setTimeout(flush, 40);
    },
    flush
  };
}
