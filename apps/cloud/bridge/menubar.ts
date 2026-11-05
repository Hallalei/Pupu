import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ensureSwiftBinary } from "./swift.ts";

const SOURCE = fileURLToPath(new URL("./menubar.swift", import.meta.url));

/** 写给菜单栏程序的一行状态。字段和 menubar.swift 里的 MenubarState 一一对应。 */
export type MenubarState = {
  readonly status: "offline" | "idle" | "busy" | "screen" | "waiting";
  readonly title: string;
  readonly lines: readonly string[];
  readonly screenGrant: boolean;
  readonly jobs: number;
  readonly allowCommands: boolean;
  readonly allowScreen: boolean;
  readonly url: string;
  readonly name: string;
  /** 有手机正连着远程桌面。 */
  readonly remote?: boolean;
};

/** 没连上的原因：凭据被拒，或者这台电脑已经有别的桥连着。 */
export type MenubarProblem = "rejected" | "busy";

export type MenubarAction =
  | { readonly action: "takeback" }
  | { readonly action: "stopJobs" }
  | { readonly action: "stopRemote" }
  | { readonly action: "setAllowCommands"; readonly value: boolean }
  | { readonly action: "setAllowScreen"; readonly value: boolean };

export type Menubar = {
  update(state: MenubarState): void;
  stop(): void;
};

function parseAction(line: string): MenubarAction | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  switch (record.action) {
    case "takeback":
    case "stopJobs":
    case "stopRemote":
      return { action: record.action };
    case "setAllowCommands":
    case "setAllowScreen":
      return typeof record.value === "boolean" ? { action: record.action, value: record.value } : null;
    default:
      return null;
  }
}

/**
 * 把菜单栏图标作为子进程拉起来。它挂了就退避重启；桥退出时一起退出。
 * 不是 macOS，或者设了 PUPU_MENUBAR=0，就什么也不做。
 */
export function startMenubar(onAction: (action: MenubarAction) => void): Menubar {
  if (process.platform !== "darwin" || process.env.PUPU_MENUBAR === "0") {
    return { update() {}, stop() {} };
  }
  let child: ChildProcess | null = null;
  let last: MenubarState | null = null;
  let stopped = false;
  let failures = 0;
  let pending: NodeJS.Timeout | null = null;

  const write = () => {
    pending = null;
    if (!last || !child?.stdin || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(last)}\n`);
  };

  const launch = async () => {
    if (stopped) return;
    let bin: string;
    try {
      bin = await ensureSwiftBinary({ source: SOURCE, name: "pupu-menubar", flags: ["-O", "-parse-as-library"] });
    } catch (error) {
      console.error(`菜单栏图标编译失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (stopped) return;
    const startedAt = Date.now();
    const current = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
    child = current;
    current.stdin?.on("error", () => {
      // 程序退出时管道断了，下面的 exit 会处理重启。
    });
    createInterface({ input: current.stdout! }).on("line", (line) => {
      const action = parseAction(line);
      if (action) onAction(action);
    });
    current.once("error", (error) => {
      console.error(`菜单栏图标没能启动：${error.message}`);
    });
    current.once("exit", () => {
      if (child === current) child = null;
      if (stopped) return;
      // 跑了一阵才退出的，从头计退避。
      failures = Date.now() - startedAt > 60_000 ? 1 : failures + 1;
      const delay = Math.min(300_000, 1000 * 2 ** Math.min(failures, 8));
      setTimeout(() => void launch(), delay).unref();
    });
    write();
  };

  void launch();

  return {
    update(state) {
      last = state;
      // 一连串变化只写最后一次。
      if (!pending) pending = setTimeout(write, 150);
    },
    stop() {
      stopped = true;
      if (pending) clearTimeout(pending);
      child?.stdin?.end();
      child?.kill("SIGTERM");
      child = null;
    }
  };
}

/** 状态、标题和菜单里的几行，按优先级挑：没连上、等批准、操作屏幕、在跑命令、空闲。 */
export function menubarState(input: {
  readonly connected: boolean;
  readonly problem?: MenubarProblem | null;
  readonly pending: readonly string[];
  readonly screenGrant: boolean;
  readonly screenActive: boolean;
  readonly commands: readonly string[];
  readonly allowCommands: boolean;
  readonly allowScreen: boolean;
  readonly url: string;
  readonly name: string;
  readonly remote?: "viewing" | "controlling" | null;
}): MenubarState {
  const jobs = input.commands.length;
  let status: MenubarState["status"];
  let title: string;
  if (!input.connected) {
    status = "offline";
    title =
      input.problem === "rejected"
        ? "这台电脑的凭据被拒了，要重新配对"
        : input.problem === "busy"
          ? "这台电脑已经有别的桥连着"
          : jobs > 0
            ? `没连上 Pupu，还有 ${jobs} 条命令在跑`
            : "没连上 Pupu";
  } else if (input.remote) {
    status = "screen";
    title = input.remote === "controlling" ? "手机正在远程控制这台电脑" : "手机正在远程查看这台电脑";
  } else if (input.pending.length > 0) {
    status = "waiting";
    title = `等你在手机或网页上批准（${input.pending.length} 件）`;
  } else if (input.screenActive) {
    status = "screen";
    title = "Pupu 正在操作屏幕";
  } else if (jobs > 0) {
    status = "busy";
    title = `Pupu 正在跑 ${jobs} 条命令`;
  } else {
    status = "idle";
    title = input.screenGrant ? "已连上，屏幕已授权给 Pupu" : "已连上 Pupu";
  }
  const lines = [
    ...input.pending.map((item) => `等批准：${clip(item, 60)}`),
    ...input.commands.slice(0, 5).map((command) => `$ ${clip(command.replace(/\s+/g, " "), 60)}`)
  ];
  if (jobs > 5) lines.push(`还有 ${jobs - 5} 条`);
  return {
    status,
    title,
    lines,
    screenGrant: input.screenGrant,
    jobs,
    allowCommands: input.allowCommands,
    allowScreen: input.allowScreen,
    url: input.url,
    name: input.name,
    remote: Boolean(input.remote)
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
