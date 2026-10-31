/**
 * 手机和浏览器的凭据，以及配对码。和电脑表一样放在 Pupu 这个 Durable Object 的 SQLite 里。
 *
 * 已经连上的设备要一个配对码，新设备拿它换自己的凭据。凭据和配对码都只存哈希；
 * 吊销后行还在，同一份凭据不能再用。原来的访问口令只在配对时认，当救急钥匙。
 */

export type DeviceKind = "phone" | "browser";

export type DeviceRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: DeviceKind;
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

export function deviceTag(id: string): string {
  return `pupu-device:${id}`;
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
    kind: row.kind === "phone" ? "phone" : "browser",
    tokenHash: String(row.token_hash),
    createdAt: Number(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
  };
}

export function deviceView(row: DeviceRow, current: string | null): DeviceView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    current: row.id === current
  };
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
        expires_at INTEGER NOT NULL
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_pairing_attempts (
        id INTEGER PRIMARY KEY,
        bucket TEXT NOT NULL,
        at INTEGER NOT NULL
      )`);
      this.#ready = true;
    }
    return this.#sql;
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

  insert(input: { name: string; kind: DeviceKind; tokenHash: string }): DeviceRow {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.#db().exec(
      `INSERT INTO pupu_devices (id, name, kind, token_hash, created_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.name,
      input.kind,
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

  /** 撞上一个还没过期的同样的码就不写，返回 false，换一个再来。 */
  addCode(hash: string, expiresAt: number, now: number): boolean {
    this.#db().exec("DELETE FROM pupu_pairing_codes WHERE expires_at <= ?", now);
    const inserted = this.#db()
      .exec(
        "INSERT OR IGNORE INTO pupu_pairing_codes (code_hash, expires_at) VALUES (?, ?) RETURNING code_hash",
        hash,
        expiresAt
      )
      .toArray();
    return inserted.length > 0;
  }

  /** 码对、没过期就删掉它并返回 true：一个码只能换一次凭据。 */
  takeCode(hash: string, now: number): boolean {
    const [row] = this.#db()
      .exec("SELECT code_hash FROM pupu_pairing_codes WHERE code_hash = ? AND expires_at > ?", hash, now)
      .toArray();
    if (!row) return false;
    this.#db().exec("DELETE FROM pupu_pairing_codes WHERE code_hash = ?", hash);
    return true;
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
