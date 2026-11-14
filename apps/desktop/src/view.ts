import type { LocalSwitches } from "../../cloud/bridge/local.ts";
import type { MenubarState } from "../../cloud/bridge/menubar.ts";
import type { DesktopComputer } from "../../cloud/src/client/desktop.ts";
import type { Credential } from "./credentials.ts";

/**
 * 给窗口看的这台电脑的状态：桥报来的那份，加上配没配对、本机开关和系统授权。
 * 桥还没报（刚启动、没配对、正在重启）时，开关用本机文件里的。
 */
export function computerView(input: {
  readonly computer: Credential | null;
  readonly state: MenubarState | null;
  readonly switches: LocalSwitches;
  readonly fallbackName: string;
  readonly permissions: DesktopComputer["permissions"];
}): DesktopComputer {
  const { computer, state, switches } = input;
  const live = computer ? state : null;
  return {
    paired: computer !== null,
    computerId: computer?.id ?? null,
    name: computer?.name ?? input.fallbackName,
    status: live?.status ?? "offline",
    // 状态词照规范 ThisComputer。窗口在、这台电脑的凭据没了，就是被吊销了；桥还没报状态是刚启动或桥在重启。
    title: !computer ? "授权被吊销" : (live?.title ?? "没连上"),
    detail: !computer ? null : live ? live.detail : "正在连接…",
    lines: live?.lines ?? [],
    screenGrant: live?.screenGrant ?? false,
    jobs: live?.jobs ?? 0,
    allowCommands: live?.allowCommands ?? switches.allowCommands,
    allowScreen: live?.allowScreen ?? switches.allowScreen,
    permissions: input.permissions
  };
}
