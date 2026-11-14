/**
 * 界面上对空间的改动：拉人、移人、改密级、切模式、换颜色和图标。只做判断，不碰数据库，规则见 docs/协作方案.md 第 5、9 节。
 *
 * - 看不到这个空间的人，得到的和空间不存在一样（不泄露它在不在）。
 * - 只有主人能改。早先的项目没有主人，谁都改不了，保持全组织可见。
 * - 只能拉组织里现有的成员；主人移不出去；L1 第一版不做。
 */

import { mayManageSpace, mayRead, maySeeSpace, type AccessThread, SPACE_LEVELS, type Level, type SpaceAccess } from "./access.ts";
import type { SpaceMode } from "./projects.ts";
import { isSpaceColor, isSpaceIcon, type SpaceColor, type SpaceIcon } from "./space-look.ts";

export type SpaceChange =
  | { readonly kind: "add"; readonly memberId: string }
  | { readonly kind: "remove"; readonly memberId: string }
  | { readonly kind: "level"; readonly level: Level }
  | { readonly kind: "mode"; readonly mode: SpaceMode }
  | { readonly kind: "color"; readonly color: SpaceColor }
  | { readonly kind: "icon"; readonly icon: SpaceIcon };

export type SpaceVerdict = "ok" | "missing" | "forbidden" | "invalid";

type Space = SpaceAccess & { readonly ownerId: string | null };

export function checkSpaceChange(
  space: Space | undefined,
  actor: string | null,
  change: SpaceChange,
  isOrgMember: (memberId: string) => boolean
): SpaceVerdict {
  if (!space || !maySeeSpace(space, actor)) return "missing";
  if (!mayManageSpace(space, actor)) return "forbidden";
  switch (change.kind) {
    case "add":
      return isOrgMember(change.memberId) ? "ok" : "invalid";
    case "remove":
      return change.memberId === space.ownerId ? "invalid" : "ok";
    case "level":
      return SPACE_LEVELS.includes(change.level) ? "ok" : "invalid";
    case "mode":
      return change.mode === "direct" || change.mode === "coordinator" ? "ok" : "invalid";
    case "color":
      return isSpaceColor(change.color) ? "ok" : "invalid";
    case "icon":
      return isSpaceIcon(change.icon) ? "ok" : "invalid";
  }
}

/** 请求体变成改动。认不出来是 null。 */
export function parseSpaceChange(body: unknown): SpaceChange | null {
  if (typeof body !== "object" || body === null) return null;
  const input = body as Record<string, unknown>;
  if ((input.kind === "add" || input.kind === "remove") && typeof input.memberId === "string" && input.memberId) {
    return { kind: input.kind, memberId: input.memberId };
  }
  if (input.kind === "level" && (input.level === "L1" || input.level === "L2" || input.level === "L3" || input.level === "L4")) {
    return { kind: "level", level: input.level };
  }
  if (input.kind === "mode" && (input.mode === "direct" || input.mode === "coordinator")) {
    return { kind: "mode", mode: input.mode };
  }
  if (input.kind === "color" && isSpaceColor(input.color)) return { kind: "color", color: input.color };
  if (input.kind === "icon" && isSpaceIcon(input.icon)) return { kind: "icon", icon: input.icon };
  return null;
}

/** 改动的结果对应的 HTTP 状态和提示。 */
export const SPACE_ERRORS: Record<Exclude<SpaceVerdict, "ok">, { status: 400 | 403 | 404; error: string }> = {
  missing: { status: 404, error: "没有这个空间" },
  forbidden: { status: 403, error: "只有建这个空间的人能改" },
  invalid: { status: 400, error: "改不了：只能拉组织里的人，建的人移不出去，密级只有 L2 到 L4，颜色和图标只能从给的里挑" }
};

/**
 * 报到聊天里的卡，只留这条聊天的全部受众现在还看得到那个空间的。空间后来收窄了，以前的卡就不再给。
 */
export function readableReports<R extends { readonly projectId: string; readonly origin: string }>(
  rows: readonly R[],
  projects: ReadonlyMap<string, SpaceAccess & { readonly id: string }>,
  threadOf: (session: string) => AccessThread | undefined
): R[] {
  return rows.filter((row) => {
    const project = projects.get(row.projectId);
    const from = threadOf(row.origin);
    return project !== undefined && from !== undefined && mayRead(from, project);
  });
}
