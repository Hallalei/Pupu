import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyAction, usesScreen } from "../src/bridge/policy.ts";
import type { Action } from "../src/bridge/protocol.ts";
import { pupuDir } from "./config.ts";

/**
 * 这台电脑自己的开关，在菜单栏上改。关掉的，云端批准了也不做。
 * 放在 ~/.pupu/local.json，文件工具碰不到它。
 */
export type LocalSwitches = {
  readonly allowCommands: boolean;
  readonly allowScreen: boolean;
};

const DEFAULTS: LocalSwitches = { allowCommands: true, allowScreen: true };

export function localPath(): string {
  return path.join(pupuDir(), "local.json");
}

export async function readLocal(): Promise<LocalSwitches> {
  let value: Partial<LocalSwitches>;
  try {
    value = JSON.parse(await readFile(localPath(), "utf8")) as Partial<LocalSwitches>;
  } catch {
    return DEFAULTS;
  }
  return {
    allowCommands: value.allowCommands !== false,
    allowScreen: value.allowScreen !== false
  };
}

export async function writeLocal(next: LocalSwitches): Promise<void> {
  await mkdir(pupuDir(), { recursive: true, mode: 0o700 });
  const target = localPath();
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

/**
 * 桥上的二次判断：本机开关关了就拒；高风险动作和屏幕操作，云端没说批过也拒。
 * 返回拒绝的原因，放行返回 null。
 */
export function localRefusal(
  action: Action,
  approved: boolean,
  switches: LocalSwitches,
  home: string
): string | null {
  const changes = action.kind === "run" || action.kind === "stdin" || action.kind === "write";
  if (changes && !switches.allowCommands) {
    return "这台电脑上关掉了「允许跑命令和写文件」，没有做。要用的话，在这台电脑菜单栏的 Pupu 图标里打开。";
  }
  if (usesScreen(action)) {
    if (!switches.allowScreen) {
      return "这台电脑上关掉了「允许操作屏幕」，没有做。要用的话，在这台电脑菜单栏的 Pupu 图标里打开。";
    }
    if (!approved) return "操作屏幕要先在手机或网页上批准，这台电脑没收到批准，没有做。";
  }
  const risk = classifyAction(action, home);
  if (risk.level === "high" && !approved) {
    return `这一步风险高（${risk.reason}），要先在手机或网页上批准。这台电脑没收到批准，没有做。`;
  }
  return null;
}
