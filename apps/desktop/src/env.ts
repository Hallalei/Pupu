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
