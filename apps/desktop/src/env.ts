/**
 * 桥的环境变量。它跑的命令会原样继承，所以去掉 Electron 和 Node 的调试开关，
 * 免得命令里的 node 被带偏，或者有人借这些变量让 Pupu 的进程跑别的代码。
 */
export function bridgeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key.startsWith("ELECTRON_") || key === "NODE_OPTIONS" || key === "NODE_DEBUG") continue;
    env[key] = value;
  }
  // 托盘就是菜单栏图标，桥别再拉起 Swift 的那个。
  env.PUPU_MENUBAR = "0";
  return env;
}

/**
 * 正式包不认的启动参数。Fuses 关掉了 Node 的 --inspect，Chromium 的远程调试关不掉：
 * 带着 --remote-debugging-port 启动，别的程序就能借窗口里的凭据操作网页（技术方案 5.5）。
 */
const DEBUG_SWITCHES = new Set([
  "remote-debugging-port",
  "remote-debugging-pipe",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "js-flags"
]);

/** argv 里的调试开关。Chromium 认 `--x` 也认 `-x`，带不带 `=值` 都算。 */
export function debugSwitches(argv: readonly string[]): string[] {
  return argv.filter((arg) => {
    const match = /^--?([a-z-]+)(=|$)/.exec(arg);
    return match !== null && DEBUG_SWITCHES.has(match[1]!);
  });
}

/** 开发用的环境变量（PUPU_URL、PUPU_DIR……）。正式包启动时全部删掉，桥也就跟着不认。 */
export function devVariables(source: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(source).filter((key) => key.startsWith("PUPU_"));
}
