/**
 * 手机、浏览器和电脑 App 窗口的凭据，以及配对码。和电脑表一样放在 Pupu 这个 Durable Object 的 SQLite 里。
 *
 * 已经连上的设备要一个配对码，新设备拿它换自己的凭据。凭据和配对码都只存哈希；
 * 吊销后行还在，同一份凭据不能再用。原来的访问口令只在配对时认，当救急钥匙。
 *
 * 设备属于一个成员（见 members.ts）：用 Google 登录的是那个人的；配对码换的，跟着生成码的那台设备走；
 * 访问口令换的算创建者的。还没有创建者时配的先不属于谁，创建者第一次登录时归他。
 */

import type { ComputerPolicy } from "./bridge/policy.ts";
import type { Actor } from "./members.ts";

/** `desktop` 是电脑 App 的窗口，和那台电脑上的桥是两份凭据。 */
export type DeviceKind = "phone" | "browser" | "desktop";

/** 配对时没给名字用这个。浏览器的名字由服务端按 User-Agent 起。 */
export const DEFAULT_DEVICE_NAMES: Readonly<Record<DeviceKind, string>> = {
  phone: "手机",
  browser: "浏览器",
  desktop: "电脑 App"
};

export type DeviceRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: DeviceKind;
  /** 属于哪个成员，见 members.ts。 */
  readonly memberId: string | null;
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  readonly revokedAt: number | null;
};

/** 给网页和 App 看的，不带凭据哈希。 */
export type DeviceView = {
  readonly id: string;
  readonly name: string;
  readonly kind: DeviceKind;
  /** 是谁的：成员 id 和他的 Google 邮箱。不属于谁是 null。 */
  readonly memberId: string | null;
  readonly member: string | null;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  /** 发这次请求的就是它。 */
  readonly current: boolean;
};

/** 配对码 10 分钟内有效，用一次就作废。 */
export const PAIRING_TTL_MS = 10 * 60_000;
/**
 * 10 分钟里同一个来源配对失败这么多次，这个来源先停一会儿。只拦它自己，
 * 乱试的人锁不住别人。
 */
export const SOURCE_LIMIT = 10;
/** 访问口令只有一个，从哪儿来的失败都记在这一桶，免得换着地址一个个试。 */
export const TOKEN_BUCKET = "access-token";
export const TOKEN_LIMIT = 20;
export const FAILURE_WINDOW_MS = 10 * 60_000;
/** 最近一次使用的时间，隔这么久才写一次库。 */
const SEEN_INTERVAL_MS = 60_000;

/** Worker 认出是哪台设备后，用这个请求头告诉 Durable Object，给它的 WebSocket 打标签。 */
export const DEVICE_HEADER = "x-pupu-device";

const DEVICE_TAG_PREFIX = "pupu-device:";

export function deviceTag(id: string): string {
  return `${DEVICE_TAG_PREFIX}${id}`;
}

/** 连接的标签里记着的设备。本机开发没带凭据时没有。 */
export function deviceOfTags(tags: readonly string[]): string | null {
  return tags.find((tag) => tag.startsWith(DEVICE_TAG_PREFIX))?.slice(DEVICE_TAG_PREFIX.length) ?? null;
}

// Crockford base32：没有 I、L、O、U，念和输都不容易错。
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 8 位，写成 ABCD-EFGH。256 正好是 32 的倍数，取余不会偏向哪个字符。 */
export function newPairingCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** 用户输入的配对码：不分大小写，忽略空格和横线，O 当 0，I、L 当 1。格式不对返回 null。 */
export function normalizePairingCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (code.length !== 8 || [...code].some((char) => !ALPHABET.includes(char))) return null;
  return code;
}

/**
 * 限流按来源算：IPv4 一个地址一份，IPv6 一个 /56 一份。一户人家通常分到一整段 IPv6，
 * 换个地址不算换来源。按子网算失败次数的思路来自 Nextcloud 的 Throttler（自己写的，没搬代码）。
 */
export function sourceOf(ip: string | null): string {
  if (!ip) return "unknown";
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  const words = groups.slice(0, 4).map((group) => parseInt(group, 16) || 0);
  const fourth = (words[3] ?? 0) & 0xff00;
  return `${words.slice(0, 3).map((word) => word.toString(16)).join(":")}:${fourth.toString(16)}::/56`;
}

/** 设置里显示的浏览器名字，比如「Safari · Mac」。 */
export function browserName(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const browser = /Edg(e|iOS|A)?\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "浏览器";
  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return system ? `${browser} · ${system}` : browser;
}

type Row = Record<string, SqlStorageValue>;

function toRow(row: Row): DeviceRow {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind === "phone" || row.kind === "desktop" ? row.kind : "browser",
    memberId: row.member_id === null || row.member_id === undefined ? null : String(row.member_id),
    tokenHash: String(row.token_hash),
    createdAt: Number(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
  };
}

/** `members` 是成员 id → 邮箱。 */
export function deviceView(
  row: DeviceRow,
  current: string | null,
  members: ReadonlyMap<string, string> = new Map()
): DeviceView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    memberId: row.memberId,
    member: row.memberId === null ? null : (members.get(row.memberId) ?? null),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    current: row.id === current
  };
}

/**
 * 是不是电脑主人的手机。`owner` 是 null：还没主人的老电脑、新手机登录的等批，谁的手机都算。
 * 只认手机，是因为电脑 App 和浏览器的窗口就开在 Pupu 能操作的电脑上，它能自己点。
 */
function isOwnersPhone(actor: Actor | undefined, owner: string | null): boolean {
  return actor?.kind === "phone" && (owner === null || actor.memberId === owner);
}

/**
 * 审批的「允许」只认这台电脑主人的手机 App（需求说明 4.7）。拒绝哪儿都能点，挡住的只是 Pupu 自己的请求。
 * `actor` 是 null 说明请求没带设备凭据（本机开发没设访问口令），照常放行；
 * undefined 是带了凭据却查不到这台设备（刚被吊销），不放行。
 */
export function mayDecide(decision: "allow" | "deny", actor: Actor | null | undefined, owner: string | null): boolean {
  return decision === "deny" || actor === null || isOwnersPhone(actor, owner);
}

/**
 * 新手机只能用已有手机生成的配对码：电脑上浏览器和电脑 App 的凭据 Pupu 拿得到，
 * 不然它能自己生成个码、配成「手机」，再批准自己。
 * 从没配过手机时哪儿生成的码都行，不然第一台连不上；吊销过的也算配过，免得先吊销真手机再钻这个空子。
 * 手机全丢了用访问口令配，不走这里。
 */
export function mayPair(kind: DeviceKind | "computer", codeByPhone: boolean, hadPhone: boolean): boolean {
  return kind !== "phone" || codeByPhone || !hadPhone;
}

/** 越往后越严。 */
const STRICTNESS: Readonly<Record<ComputerPolicy, number>> = { trust: 0, ask_risky: 1, ask_all: 2 };

/**
 * 电脑的权限分级往宽里改只认这台电脑主人的手机 App，理由和 `mayDecide` 一样：改成 `trust` 就等于以后都不用批。
 * 往严里改、不变，哪儿都行。`actor` 的 null 和 undefined、`owner` 的 null 也和 `mayDecide` 一样。
 */
export function mayChangePolicy(
  from: ComputerPolicy,
  to: ComputerPolicy,
  actor: Actor | null | undefined,
  owner: string | null
): boolean {
  return STRICTNESS[to] >= STRICTNESS[from] || actor === null || isOwnersPhone(actor, owner);
}

export class DeviceStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_pairing_codes (
        code_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        by_phone INTEGER NOT NULL DEFAULT 0
      )`);
      // 早先建的表没有后加的这几列，补上。
      this.#addColumn("pupu_pairing_codes", "by_phone", "INTEGER NOT NULL DEFAULT 0");
      this.#addColumn("pupu_pairing_codes", "member_id", "TEXT");
      this.#addColumn("pupu_devices", "member_id", "TEXT");
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_pairing_attempts (
        id INTEGER PRIMARY KEY,
        bucket TEXT NOT NULL,
        at INTEGER NOT NULL
      )`);
      this.#ready = true;
    }
    return this.#sql;
  }

  #addColumn(table: string, column: string, type: string): void {
    const columns = this.#sql.exec(`PRAGMA table_info(${table})`).toArray();
    if (!columns.some((row) => row.name === column)) {
      this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  byTokenHash(hash: string): DeviceRow | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_devices WHERE token_hash = ?", hash).toArray();
    return row ? toRow(row) : undefined;
  }

  /** 没吊销的，新连上的在前。 */
  list(): DeviceRow[] {
    return this.#db()
      .exec("SELECT * FROM pupu_devices WHERE revoked_at IS NULL ORDER BY created_at DESC")
      .toArray()
      .map(toRow);
  }

  /** 这个成员名下没吊销的设备。 */
  ofMember(memberId: string): DeviceRow[] {
    return this.list().filter((row) => row.memberId === memberId);
  }

  /** 还没有主人的设备都归这个成员。创建者第一次登录时用。 */
  claimUnowned(memberId: string): void {
    this.#db().exec("UPDATE pupu_devices SET member_id = ? WHERE member_id IS NULL", memberId);
  }

  /** 配过手机没有，吊销了的也算。 */
  hadPhone(): boolean {
    return this.#db().exec("SELECT 1 FROM pupu_devices WHERE kind = 'phone' LIMIT 1").toArray().length > 0;
  }

  insert(input: { name: string; kind: DeviceKind; tokenHash: string; memberId: string | null }): DeviceRow {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.#db().exec(
      `INSERT INTO pupu_devices (id, name, kind, member_id, token_hash, created_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.name,
      input.kind,
      input.memberId,
      input.tokenHash,
      now,
      now
    );
    const created = this.byTokenHash(input.tokenHash);
    if (!created) throw new Error("设备没有写进去");
    return created;
  }

  revoke(id: string): DeviceRow | undefined {
    this.#db().exec(
      "UPDATE pupu_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      Date.now(),
      id
    );
    const [row] = this.#db().exec("SELECT * FROM pupu_devices WHERE id = ?", id).toArray();
    return row ? toRow(row) : undefined;
  }

  /** 记下最近一次使用。每个请求都会来，所以隔一会儿才真写。 */
  touch(row: DeviceRow, now: number): void {
    if (row.lastSeenAt !== null && now - row.lastSeenAt < SEEN_INTERVAL_MS) return;
    this.#db().exec("UPDATE pupu_devices SET last_seen_at = ? WHERE id = ?", now, row.id);
  }

  /**
   * 撞上一个还没过期的同样的码就不写，返回 false，换一个再来。
   * `byPhone` 记下是不是手机生成的，见 `mayPair`；`memberId` 是生成码的那台设备属于谁，换出来的设备也归他。
   */
  addCode(hash: string, expiresAt: number, now: number, from: { byPhone: boolean; memberId: string | null }): boolean {
    this.#db().exec("DELETE FROM pupu_pairing_codes WHERE expires_at <= ?", now);
    const inserted = this.#db()
      .exec(
        `INSERT OR IGNORE INTO pupu_pairing_codes (code_hash, expires_at, by_phone, member_id)
         VALUES (?, ?, ?, ?) RETURNING code_hash`,
        hash,
        expiresAt,
        from.byPhone ? 1 : 0,
        from.memberId
      )
      .toArray();
    return inserted.length > 0;
  }

  /** 码对、没过期就删掉它，返回它是谁生成的：一个码只能换一次凭据。不对返回 undefined。 */
  takeCode(hash: string, now: number): { byPhone: boolean; memberId: string | null } | undefined {
    const [row] = this.#db()
      .exec("SELECT by_phone, member_id FROM pupu_pairing_codes WHERE code_hash = ? AND expires_at > ?", hash, now)
      .toArray();
    if (!row) return undefined;
    this.#db().exec("DELETE FROM pupu_pairing_codes WHERE code_hash = ?", hash);
    return { byPhone: Number(row.by_phone) === 1, memberId: row.member_id === null ? null : String(row.member_id) };
  }

  /** 这一桶最近失败了几次。顺手清掉窗口外的。 */
  failures(bucket: string, now: number): number {
    this.#db().exec("DELETE FROM pupu_pairing_attempts WHERE at <= ?", now - FAILURE_WINDOW_MS);
    const [row] = this.#db()
      .exec("SELECT COUNT(*) AS count FROM pupu_pairing_attempts WHERE bucket = ?", bucket)
      .toArray();
    return Number(row?.count ?? 0);
  }

  /**
   * 先当失败记下，再去比对：同时打进来的一批请求，在比对之前就都算进了次数。
   * 比对成功再用 `forgive` 撤掉。
   */
  addAttempt(buckets: readonly string[], now: number): number[] {
    return buckets.map((bucket) =>
      Number(
        this.#db()
          .exec("INSERT INTO pupu_pairing_attempts (bucket, at) VALUES (?, ?) RETURNING id", bucket, now)
          .one().id
      )
    );
  }

  forgive(ids: readonly number[]): void {
    for (const id of ids) this.#db().exec("DELETE FROM pupu_pairing_attempts WHERE id = ?", id);
  }
}
