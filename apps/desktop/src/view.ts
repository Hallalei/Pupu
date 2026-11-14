import type { LocalSwitches } from "../../cloud/bridge/local.ts";
import type { MenubarState } from "../../cloud/bridge/menubar.ts";
import type { DesktopComputer } from "../../cloud/src/client/desktop.ts";
import type { Pairing } from "./credentials.ts";
import { computerAuth } from "./pairing-state.ts";

/**
 * 给窗口看的这台电脑的状态：桥报来的那份，加上配没配对、本机开关和系统授权。凭据本身不给。
 * 桥还没报（刚启动、没配对、正在重启）时，开关用本机文件里的。
 */
export function computerView(input: {
  readonly pairing: Pairing;
  readonly state: MenubarState | null;
  readonly switches: LocalSwitches;
  readonly fallbackName: string;
  readonly permissions: DesktopComputer["permissions"];
}): DesktopComputer {
  const { state, switches } = input;
  const computer = input.pairing.computer;
  const revoked = computerAuth(input.pairing) === "revoked";
  const live = computer ? state : null;
  // 状态词照规范 ThisComputer。这台电脑的凭据没了：云端拒了是「授权被吊销」，配对半路没做完是「没连上 · 配对没做完」。
  // 桥还没报状态是刚启动或桥在重启。
  const [title, detail]: readonly [string, string | null] = computer
    ? [live?.title ?? "没连上", live ? live.detail : "正在连接…"]
    : revoked
      ? ["授权被吊销", null]
      : ["没连上", "配对没做完"];
  return {
    paired: computer !== null,
    unfinished: computer === null && !revoked,
    computerId: computer?.id ?? null,
    name: computer?.name ?? input.fallbackName,
    status: live?.status ?? "offline",
    title,
    detail,
    lines: live?.lines ?? [],
    screenGrant: live?.screenGrant ?? false,
    jobs: live?.jobs ?? 0,
    allowCommands: live?.allowCommands ?? switches.allowCommands,
    allowScreen: live?.allowScreen ?? switches.allowScreen,
    permissions: input.permissions
  };
}
