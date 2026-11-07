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
  OUTPUT_TAIL_CHARS,
  safeRequestId,
  type Action,
  type UpFrame
} from "../src/bridge/protocol.ts";

type DedupeRecord = {
  status: "running" | "done";
  kind: string;
  commandId?: string;
  outputPath?: string;
  output?: string;
  exitCode?: number | null;
  error?: string;
  path?: string;
};

type RunningCommand = {
  readonly child: ChildProcess;
  readonly outputPath: string;
  file: FileHandle | null;
};

type Job = {
  streaming: boolean;
  readonly child?: ChildProcess;
  readonly command?: string;
  readonly startedAt: number;
};

const running = new Map<string, RunningCommand>();
const jobs = new Map<string, Job>();

// ---- 给菜单栏看的：在跑的命令、是不是在操作屏幕 ----

const listeners = new Set<() => void>();
let screenOps = 0;
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
  return [...jobs.entries()]
    .filter(([, job]) => job.command !== undefined)
    .map(([requestId, job]) => ({ requestId, command: job.command!, startedAt: job.startedAt }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** 正在做屏幕操作，或者刚做完不久。 */
export function screenActivity(now = Date.now()): { active: boolean; lastAt: number } {
  return { active: screenOps > 0 || now - lastScreenAt < SCREEN_RECENT_MS, lastAt: lastScreenAt };
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

/** 云端取消，或者只要桥别再把输出往连接上送。进程是否留下由 mode 决定。 */
export function controlJob(requestId: string, mode: "kill" | "detach"): void {
  const job = jobs.get(requestId);
  if (!job) return;
  job.streaming = false;
  if (mode === "kill" && job.child) killChild(job.child);
}

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
  const refusal = localRefusal(action, approved, await readLocal(), host.root);
  if (refusal) {
    host.send({ type: "error", requestId, message: refusal });
    return;
  }
  if (usesScreen(action)) {
    screenOps += 1;
    changed();
    try {
      await performAction(requestId, action, host);
    } finally {
      screenOps -= 1;
      lastScreenAt = Date.now();
      changed();
      // 「刚做完」那段时间过了，再通知一次，让菜单栏换回来。
      setTimeout(changed, SCREEN_RECENT_MS + 100).unref();
    }
    return;
  }
  await performAction(requestId, action, host);
}

async function performAction(requestId: string, action: Action, host: ActionHost): Promise<void> {
  if (action.kind === "read") {
    await read(requestId, action.path, action.maxBytes, host);
    return;
  }
  if (action.kind === "list") {
    await list(requestId, action.path, host);
    return;
  }
  if (action.kind === "computer" && !isScreenInput(action)) {
    try {
      await performComputer(requestId, action, host);
    } catch (error) {
      host.send({
        type: "error",
        requestId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }
  const claim = await claimRequest(host.requests, requestId, action.kind);
  if (claim.state === "done") {
    replay(requestId, claim.record, host);
    return;
  }
  if (claim.state === "running") {
    const where = claim.record.outputPath ? `输出文件：${claim.record.outputPath}` : "";
    host.send({
      type: "error",
      requestId,
      message: `这个请求已经在这台电脑上执行，没有重复跑。${where}`.trim()
    });
    return;
  }
  try {
    if (action.kind === "run") await run(requestId, action, host, claim.file);
    else if (action.kind === "write") await write(requestId, action, host, claim.file);
    else if (action.kind === "stdin") await writeStdin(requestId, action, host, claim.file);
    else await performComputer(requestId, action, host);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeRecord(claim.file, { status: "done", kind: action.kind, error: message });
    host.send({ type: "error", requestId, message });
  }
}

async function run(
  requestId: string,
  action: Extract<Action, { kind: "run" }>,
  host: ActionHost,
  recordFile: string
): Promise<void> {
  const command = action.command.trim();
  if (!command) throw new Error("命令不能是空的。");
  await mkdir(host.terminals, { recursive: true, mode: 0o700 });
  const commandId = safeRequestId(requestId);
  const outputPath = path.join(host.terminals, `${commandId}.log`);
  const file = await open(outputPath, "a", 0o600);
  const log = createLogWriter(file);
  await log.write(`$ ${command}\ncwd: ${host.root}\nstarted: ${new Date().toISOString()}\n\n`);
  await writeRecord(recordFile, { status: "running", kind: "run", commandId, outputPath });
  const child = spawn(loginShell(), ["-lc", command], {
    cwd: host.root,
    detached: true,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const job: Job = { streaming: !action.background, child, command, startedAt: Date.now() };
  jobs.set(requestId, job);
  running.set(commandId, { child, outputPath, file });
  changed();
  // 监听要在任何 await 之前挂上，不然很短的命令会在监听前就退出，输出丢了。
  let tail = "";
  const push = createPusher(() => job.streaming, (text) => {
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
    void finish(requestId, commandId, recordFile, log, code, error, host, job, () => tail);
  };
  child.once("error", (error) => {
    ended(null, error instanceof Error ? error.message : String(error));
  });
  child.once("exit", (code) => {
    ended(code);
  });
  host.send({ type: "started", requestId, commandId, outputPath });
}

/** 进程退出时收尾。桥自己要停时，把还在跑的命令停掉。 */
export function stopAllJobs(): void {
  for (const job of jobs.values()) {
    job.streaming = false;
    if (job.child) killChild(job.child);
  }
}

async function finish(
  requestId: string,
  commandId: string,
  recordFile: string,
  log: LogWriter,
  code: number | null,
  error: string | undefined,
  host: ActionHost,
  job: Job,
  tailOf: () => string
): Promise<void> {
  // 退出和启动失败都会进来。只收尾一次，避免把同一段结果送两遍。
  if (jobs.get(requestId) !== job) return;
  const streaming = job.streaming;
  job.streaming = false;
  jobs.delete(requestId);
  running.delete(commandId);
  changed();
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
    outputPath: path.join(host.terminals, `${commandId}.log`),
    output: tailOf(),
    ...(error ? { error } : { exitCode: code })
  });
  if (!streaming) return;
  if (error) host.send({ type: "error", requestId, message: error });
  else host.send({ type: "exit", requestId, code });
}

async function write(
  requestId: string,
  action: Extract<Action, { kind: "write" }>,
  host: ActionHost,
  recordFile: string
): Promise<void> {
  const bytes = Buffer.byteLength(action.content);
  if (bytes > MAX_TRANSFER_BYTES) throw new Error("文件超过 100 MiB，没有写。");
  const target = await containPath(host.root, action.path, host.blocked);
  if (!target) throw new Error("路径超出这台电脑的主目录。");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, action.content, "utf8");
  await writeRecord(recordFile, { status: "done", kind: "write", path: target });
  host.send({ type: "done", requestId, path: target });
}

async function writeStdin(
  requestId: string,
  action: Extract<Action, { kind: "stdin" }>,
  host: ActionHost,
  recordFile: string
): Promise<void> {
  const command = running.get(action.commandId);
  if (!command || command.child.exitCode !== null || command.child.stdin === null) {
    throw new Error("找不到这个正在跑的命令，可能已经结束，或者桥重启过。输出还在终端文件里。");
  }
  await new Promise<void>((resolve, reject) => {
    const stdin = command.child.stdin;
    if (!stdin) {
      reject(new Error("这个命令没有标准输入。"));
      return;
    }
    stdin.write(action.data, "utf8", (error) => {
      if (error) reject(new Error("没能写进标准输入。"));
      else resolve();
    });
  });
  if (action.eof) command.child.stdin.end();
  await writeRecord(recordFile, { status: "done", kind: "stdin", commandId: action.commandId });
  host.send({ type: "done", requestId });
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
  return { state: record.status === "done" ? "done" : "running", record, file };
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
