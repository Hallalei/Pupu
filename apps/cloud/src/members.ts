/**
 * Pupu 的成员（需求说明 4.7）。一个团体（一家人、一个组织）共用一个 Pupu，每人用自己的 Google 账号登录。
 * 角色只有两种：创建者和成员。手机、浏览器、电脑 App 和电脑都挂在一个人名下。
 *
 * - 创建者：secret `CREATOR_EMAIL` 里的那个人，第一次登录时建行。还没有创建者时连上的设备和电脑都算他的。
 *   之后这个 secret 不再起作用，改了也不会换创建者。
 * - 成员：创建者在手机 App 里邀请的人，用那个邮箱登录才放行。被移除时他的设备和电脑一起吊销。
 *
 * 以后每人各自的聊天、个人记忆、「替谁做」都挂在成员 id 上，这里先只有名单。
 */

import type { DeviceKind } from "./devices.ts";

export type MemberRole = "creator" | "member";

export type MemberRow = {
  readonly id: string;
  /** Google 账号的邮箱，按 `emailKey` 存。 */
  readonly email: string;
  readonly role: MemberRole;
  /** 谁邀请的。创建者是 null。 */
  readonly invitedBy: string | null;
  /** 邀请（创建者是第一次登录）的时间。 */
  readonly createdAt: number;
  /** 第一次登录的时间。邀请了还没登录过是 null。 */
  readonly joinedAt: number | null;
};

/** 给网页和 App 看的成员。 */
export type MemberView = {
  readonly id: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly joinedAt: number | null;
  /** 发这次请求的设备是他的。 */
  readonly current: boolean;
};

/**
 * 发请求的是谁：哪种设备、属于哪个成员、是不是创建者。
 * 还没有创建者时（没开 Google 登录，或者开了还没人登过），不属于谁的设备都按创建者算，和以前一个人用的时候一样。
 */
export type Actor = {
  readonly kind: DeviceKind;
  readonly memberId: string | null;
  readonly role: MemberRole | null;
};

/**
 * 由发请求的设备和成员名单算出 `Actor`。`device` 是 null（没带凭据）、undefined（查不到）原样返回。
 * 服务端和网页用同一个算法，网页上按钮该不该灰才和接口对得上。
 */
export function actorOf(
  device: { readonly kind: DeviceKind; readonly memberId: string | null } | null | undefined,
  members: readonly { readonly id: string; readonly role: MemberRole }[]
): Actor | null | undefined {
  if (!device) return device;
  const member = device.memberId === null ? undefined : members.find((each) => each.id === device.memberId);
  const unowned = device.memberId === null && !members.some((each) => each.role === "creator");
  return { kind: device.kind, memberId: member?.id ?? null, role: member?.role ?? (unowned ? "creator" : null) };
}

/** Gmail 的地址不分大小写，点也不算数，googlemail.com 和 gmail.com 是同一个。 */
export function emailKey(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at < 0) return lower;
  const domain = lower.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return lower;
  return `${lower.slice(0, at).split("+")[0]?.replace(/\./g, "")}@gmail.com`;
}

export function isEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()) && value.trim().length <= 254;
}

/**
 * 邀请成员只有创建者能做，而且要在手机 App 上：加一个人等于放宽权限，电脑上的浏览器和电脑 App
 * Pupu 自己点得到，理由和 `mayChangePolicy` 一样。`actor` 是 null 是本机开发没带凭据。
 */
export function mayInvite(actor: Actor | null | undefined): boolean {
  if (actor === null) return true;
  return actor?.kind === "phone" && actor.role === "creator" && actor.memberId !== null;
}

/** 移除成员只有创建者能做，哪个设备上都行（是收紧）。创建者自己移除不了。 */
export function mayRemoveMember(actor: Actor | null | undefined, target: { readonly role: MemberRole }): boolean {
  if (target.role === "creator") return false;
  return actor === null || actor?.role === "creator";
}

/** 吊销设备或电脑：自己名下的自己能吊销，创建者能吊销所有人的。`owner` 是它属于的成员。 */
export function mayRevoke(actor: Actor | null | undefined, owner: string | null): boolean {
  if (actor === null || actor?.role === "creator") return true;
  return actor !== undefined && owner !== null && actor.memberId === owner;
}

export function memberView(row: MemberRow, current: string | null): MemberView {
  return { id: row.id, email: row.email, role: row.role, joinedAt: row.joinedAt, current: row.id === current };
}

type Row = Record<string, SqlStorageValue>;

function toRow(row: Row): MemberRow {
  return {
    id: String(row.id),
    email: String(row.email),
    role: row.role === "creator" ? "creator" : "member",
    invitedBy: row.invited_by === null ? null : String(row.invited_by),
    createdAt: Number(row.created_at),
    joinedAt: row.joined_at === null ? null : Number(row.joined_at)
  };
}

export class MemberStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_members (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        invited_by TEXT,
        created_at INTEGER NOT NULL,
        joined_at INTEGER
      )`);
      this.#ready = true;
    }
    return this.#sql;
  }

  #one(query: string, ...bindings: SqlStorageValue[]): MemberRow | undefined {
    const [row] = this.#db().exec(query, ...bindings).toArray();
    return row ? toRow(row) : undefined;
  }

  byId(id: string): MemberRow | undefined {
    return this.#one("SELECT * FROM pupu_members WHERE id = ?", id);
  }

  byEmail(email: string): MemberRow | undefined {
    return this.#one("SELECT * FROM pupu_members WHERE email = ?", emailKey(email));
  }

  creator(): MemberRow | undefined {
    return this.#one("SELECT * FROM pupu_members WHERE role = 'creator' LIMIT 1");
  }

  /** 创建者在前，其余按邀请的先后。 */
  list(): MemberRow[] {
    return this.#db()
      .exec("SELECT * FROM pupu_members ORDER BY role = 'creator' DESC, created_at")
      .toArray()
      .map(toRow);
  }

  /** 创建者第一次登录。已经有创建者了返回 undefined。 */
  addCreator(email: string, now: number): MemberRow | undefined {
    if (this.creator()) return undefined;
    const id = crypto.randomUUID();
    this.#db().exec(
      `INSERT OR IGNORE INTO pupu_members (id, email, role, invited_by, created_at, joined_at)
       VALUES (?, ?, 'creator', NULL, ?, ?)`,
      id,
      emailKey(email),
      now,
      now
    );
    return this.byId(id);
  }

  /** 邀请一个人。这个邮箱已经在名单里了返回 undefined。 */
  invite(email: string, invitedBy: string | null, now: number): MemberRow | undefined {
    const id = crypto.randomUUID();
    const inserted = this.#db()
      .exec(
        `INSERT OR IGNORE INTO pupu_members (id, email, role, invited_by, created_at, joined_at)
         VALUES (?, ?, 'member', ?, ?, NULL) RETURNING id`,
        id,
        emailKey(email),
        invitedBy,
        now
      )
      .toArray();
    return inserted.length > 0 ? this.byId(id) : undefined;
  }

  /** 记下第一次登录。 */
  markJoined(id: string, now: number): void {
    this.#db().exec("UPDATE pupu_members SET joined_at = ? WHERE id = ? AND joined_at IS NULL", now, id);
  }

  /** 移除一个成员。创建者删不掉。 */
  remove(id: string): boolean {
    const removed = this.#db()
      .exec("DELETE FROM pupu_members WHERE id = ? AND role <> 'creator' RETURNING id", id)
      .toArray();
    return removed.length > 0;
  }
}
