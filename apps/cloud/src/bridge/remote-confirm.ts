import type { Actor } from "../members.ts";

/**
 * 远程控制前要不要先确认，每台电脑一档，设置里和「Pupu 用它之前问我」排在一起（2026-11-14 定：前期审批不要多，默认不用确认）。
 * - none：主人登录着的端直接打开。
 * - device：每台设备第一次打开前确认一次（网页按通行密钥，手机按面容），之后这台设备直接开。
 * - always：每次打开都确认。
 * 手机的确认在 App 里（面容 ID），云端只认是主人的手机；网页和电脑 App 的确认是通行密钥换的票，见 desktop.ts 的 `mayViewDesktop`。
 */
export type RemoteConfirm = "none" | "device" | "always";

export const REMOTE_CONFIRMS: readonly (readonly [RemoteConfirm, string])[] = [
  ["none", "不用确认"],
  ["device", "每台设备确认一次"],
  ["always", "每次都确认"]
];

export const DEFAULT_REMOTE_CONFIRM: RemoteConfirm = "none";

export function isRemoteConfirm(value: unknown): value is RemoteConfirm {
  return value === "none" || value === "device" || value === "always";
}

/** 越往后越严。 */
const STRICTNESS: Readonly<Record<RemoteConfirm, number>> = { none: 0, device: 1, always: 2 };

/**
 * 改这一档和改电脑分级一个规矩（devices.ts 的 `mayChangePolicy`）：往严里改、不变，谁都行；
 * 放宽只有主人自己，在哪个登录着的端都行。`actor` 是 null 是本机开发没带凭据。
 */
export function mayChangeRemoteConfirm(
  from: RemoteConfirm,
  to: RemoteConfirm,
  actor: Pick<Actor, "memberId"> | null | undefined,
  owner: string | null
): boolean {
  if (STRICTNESS[to] >= STRICTNESS[from] || actor === null) return true;
  return actor !== undefined && (owner === null || actor.memberId === owner);
}
