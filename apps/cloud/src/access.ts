/**
 * 谁能看什么。只做判断，不碰数据库，规则见 docs/协作方案.md 第 8、9 节。
 *
 * 密级参照飞书 L1–L4：
 * - L4 机密：只有空间成员，组织大脑不用，别的会话读不到。
 * - L3 秘密：只有空间成员，新空间的默认。成员在自己的会话里能读到。
 * - L2 内部：全组织。早先的项目都是 L2。
 * - L1 外部可见：对外只读。第一版不做，按 L2 处理组织内部。
 *
 * 不变量：一条会话里只出现它的全部受众都有权看的东西。受众按会话算，不按当前说话的人算。
 */

export type Level = "L1" | "L2" | "L3" | "L4";

/** 判断用到的空间字段。`Project` 满足它。 */
export type SpaceAccess = { readonly level: Level; readonly members: readonly string[] };

/** 判断用到的会话字段。`Thread` 满足它。 */
export type AccessThread =
  | { readonly kind: "main" }
  | { readonly kind: "private"; readonly memberId: string }
  | { readonly kind: "project" | "child"; readonly project: SpaceAccess & { readonly id: string } };

/** 会话的受众：`everyone` 是全组织，否则是一张名单。 */
export type Audience = { readonly everyone: true } | { readonly everyone: false; readonly members: readonly string[] };

const EVERYONE: Audience = { everyone: true };

export function isOpen(level: Level): boolean {
  return level === "L1" || level === "L2";
}

export function audienceOf(thread: AccessThread): Audience {
  switch (thread.kind) {
    case "main":
      return EVERYONE;
    case "private":
      return { everyone: false, members: [thread.memberId] };
    case "project":
    case "child":
      return isOpen(thread.project.level) ? EVERYONE : { everyone: false, members: thread.project.members };
  }
}

function inAudience(audience: Audience, viewer: string | null): boolean {
  if (audience.everyone) return true;
  return viewer !== null && audience.members.includes(viewer);
}

/** 打开这条会话。没有成员身份的（`viewer` 是 null）只进得了全组织可见的。查不到的会话不让开。 */
export function mayOpen(thread: AccessThread | undefined, viewer: string | null): boolean {
  return thread !== undefined && inAudience(audienceOf(thread), viewer);
}

/**
 * 这个会话里发起的动作（审批卡、「正在做」）给不给 `viewer` 看：受众都看得到，批准这一步的人也看得到。
 * 说不准是哪个会话的（`thread` 是 undefined）只给批准的人。
 */
export function seesWork(thread: AccessThread | undefined, viewer: string | null, approver: string | null): boolean {
  if (thread && inAudience(audienceOf(thread), viewer)) return true;
  return viewer !== null && viewer === approver;
}

/** 这个空间给不给 `viewer` 看：列表、状态、汇报都按这个筛。 */
export function maySeeSpace(space: SpaceAccess, viewer: string | null): boolean {
  return isOpen(space.level) || (viewer !== null && space.members.includes(viewer));
}

/**
 * 在会话 `from` 里能不能读到空间 `space` 的东西（列表、进展、交接过去）。
 * 读到的东西会留在 `from` 里，所以 `from` 的全部受众都得能看 `space`。L4 只有它自己的会话能读。
 */
export function mayRead(from: AccessThread, space: SpaceAccess & { readonly id: string }): boolean {
  if ((from.kind === "project" || from.kind === "child") && from.project.id === space.id) return true;
  if (space.level === "L4") return false;
  if (isOpen(space.level)) return true;
  const audience = audienceOf(from);
  // 一个成员都没有的空间（最后一个人也被移出了）不算全部受众都看得到。
  return !audience.everyone && audience.members.length > 0 && audience.members.every((member) => space.members.includes(member));
}
