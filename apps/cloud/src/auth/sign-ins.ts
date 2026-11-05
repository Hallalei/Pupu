import type { ApprovalRow, ApprovalStatus, ApprovalView } from "../bridge/approvals.ts";

/**
 * 用 Google 登录连上新设备。和设备表一样放在 Pupu 这个 Durable Object 的 SQLite 里。
 *
 * 一次登录分两段：
 * 1. 流程（flow）：从点「用 Google 登录」到 Google 回调。记着 state、nonce 和给 Google 的 PKCE verifier。
 * 2. 登录结果（sign-in）：Google 认过了，手机和电脑 App 拿一次性的码，加上自己留着的 verifier，来换凭据。
 *    浏览器不走这一段，回调时直接种 cookie。
 *
 * 新手机如果以前配过手机，登录结果要等已有手机点允许（见 `redeemStep`）：电脑上的浏览器多半登着
 * 这个 Gmail，Pupu 能操作电脑，自己就能走完 Google 登录。等批的时候它就是一条「等你批准」，
 * 和电脑上的审批一起推到手机、挂在顶栏下面。
 */

/** `browser` 是网页，`phone` 是手机 App，`desktop` 是电脑 App（窗口和桥一起）。 */
export type SignInClient = "browser" | "phone" | "desktop";

export function isSignInClient(value: unknown): value is SignInClient {
  return value === "browser" || value === "phone" || value === "desktop";
}

/** 从点登录到 Google 回调最多这么久。 */
export const FLOW_TTL_MS = 10 * 60_000;
/** Google 回调以后，App 要在这么久里拿码来换。 */
export const GRANT_TTL_MS = 5 * 60_000;
/** 新手机等已有手机点允许，最多这么久。和电脑上的审批一样。 */
export const CONFIRM_TTL_MS = 10 * 60_000;
/** 点了允许以后，新手机还有这么久来取凭据。 */
export const PICKUP_MS = 2 * 60_000;
/** 用过、过期的登录记录留一天。 */
const KEEP_MS = 24 * 60 * 60_000;

/** 手机 App 的回调。ASWebAuthenticationSession 只拦这个 scheme，别的 App 拿不到。 */
export const PHONE_REDIRECT = "pupu://auth";
/** 电脑 App 在本机 127.0.0.1 上临时开一个端口接回调（RFC 8252 的 loopback 写法）。 */
export const DESKTOP_PATH = "/pupu-auth";

/**
 * 登录完了把码送到哪。浏览器是 null（回调时直接种 cookie）；电脑 App 只能是本机回环地址。
 * 参数不对返回 undefined。地址不由客户端随便填，免得有人让 Google 登录完把码送到别处。
 */
export function redirectFor(client: SignInClient, port?: unknown): string | null | undefined {
  if (client === "browser") return null;
  if (client === "phone") return PHONE_REDIRECT;
  const value = typeof port === "string" && /^\d{1,5}$/.test(port) ? Number(port) : NaN;
  if (!(value >= 1024 && value <= 65535)) return undefined;
  return `http://127.0.0.1:${value}${DESKTOP_PATH}`;
}

export type SignInFlow = {
  readonly state: string;
  /** 给 Google 的 PKCE verifier。 */
  readonly verifier: string;
  readonly nonce: string;
  readonly client: SignInClient;
  /** App 自己那份 verifier 的 S256。浏览器是 null。 */
  readonly challenge: string | null;
  readonly redirect: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
};

/**
 * - ready：Google 认过了，等 App 来换；
 * - waiting：新手机在等已有手机点允许；
 * - allowed：允许了，等新手机来取；
 * - denied：拒绝了；
 * - used：已经换成凭据，或者 verifier 对不上作废了。
 */
export type SignInStatus = "ready" | "waiting" | "allowed" | "denied" | "used";

export type SignInRow = {
  readonly id: string;
  readonly codeHash: string;
  readonly client: Exclude<SignInClient, "browser">;
  readonly email: string;
  readonly challenge: string;
  /** 新设备的名字。来换凭据时才知道。 */
  readonly name: string | null;
  /** 从哪儿登录的，比如「Shanghai, CN · 203.0.113.5」。来换凭据时才知道。 */
  readonly place: string | null;
  readonly status: SignInStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** 已有手机点允许或拒绝的时间。没点过是 null。 */
  readonly decidedAt: number | null;
};

/** 拿码来换凭据时，这一步怎么办。 */
export type RedeemStep =
  | { readonly action: "issue" }
  /** 要已有手机点允许：改成 waiting，推通知。 */
  | { readonly action: "confirm" }
  | { readonly action: "waiting" }
  | { readonly action: "refuse"; readonly status: 400 | 403 | 410; readonly error: string; readonly burn?: boolean };

/**
 * 换凭据这一步的规则，纯函数。`verifierMatches` 是 App 带来的 verifier 和登录开始时的 challenge 对不对得上；
 * 对不上说明码被别人截了，这次登录作废（`burn`）。
 * `hadPhone` 和 `mayPair` 一样：配过手机（吊销了也算）以后，新手机要已有手机点允许。
 * 按整个 Pupu 算，不按成员算：不然一个还没有手机的成员，他电脑上的浏览器 Pupu 拿得到，
 * 能替他配一台「手机」再批准自己。所以新成员的第一台手机，也要随便哪台已有的手机点允许。
 */
export function redeemStep(
  row: SignInRow | undefined,
  input: { readonly now: number; readonly verifierMatches: boolean; readonly hadPhone: boolean }
): RedeemStep {
  if (!row || row.status === "used") {
    return { action: "refuse", status: 400, error: "这次登录已经用过，或者不存在。重新登录一次。" };
  }
  if (!input.verifierMatches) {
    return { action: "refuse", status: 400, error: "这次登录对不上，已经作废了。重新登录一次。", burn: true };
  }
  if (row.status === "denied") return { action: "refuse", status: 403, error: "已经连上的手机拒绝了这次登录。" };
  if (input.now >= row.expiresAt) {
    return {
      action: "refuse",
      status: 410,
      error:
        row.status === "waiting"
          ? "已经连上的手机没在 10 分钟内点允许。重新登录一次。"
          : "登录过期了，重新登录一次。"
    };
  }
  if (row.status === "allowed") return { action: "issue" };
  if (row.status === "waiting") return { action: "waiting" };
  return row.client === "phone" && input.hadPhone ? { action: "confirm" } : { action: "issue" };
}

/** 等批的登录，在审批里的样子。id 就是登录的 id。 */
export const SIGN_IN_TITLE = "新手机想连上 Pupu";
export const SIGN_IN_REASON = "认不出这次登录就点拒绝";

function signInDetail(row: SignInRow): string {
  return [`Google 账号：${row.email}`, row.place ? `登录地点：${row.place}` : null].filter(Boolean).join("\n");
}

function approvalStatus(row: SignInRow): ApprovalStatus {
  if (row.status === "waiting") return "pending";
  if (row.status === "denied") return "denied";
  if (row.status === "allowed" || (row.status === "used" && row.decidedAt !== null)) return "allowed";
  return "expired";
}

/** 推送对账用（`ApprovalPusher`）。 */
export function signInApprovalRow(row: SignInRow): ApprovalRow {
  return {
    id: row.id,
    callId: `sign-in:${row.id}`,
    session: null,
    computerId: "",
    kind: "sign_in",
    screen: false,
    title: SIGN_IN_TITLE,
    detail: signInDetail(row),
    reason: SIGN_IN_REASON,
    status: approvalStatus(row),
    note: null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt
  };
}

/** 网页和手机上的审批卡片。`computerName` 那一栏放新设备的名字。 */
export function signInApprovalView(row: SignInRow): ApprovalView {
  return {
    id: row.id,
    computerId: "",
    computerName: row.name ?? "新手机",
    kind: "sign_in",
    title: SIGN_IN_TITLE,
    detail: signInDetail(row),
    reason: SIGN_IN_REASON,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt
  };
}

type Row = Record<string, SqlStorageValue>;

function text(value: SqlStorageValue): string | null {
  return value === null ? null : String(value);
}

function toFlow(row: Row): SignInFlow {
  const client = String(row.client);
  return {
    state: String(row.state),
    verifier: String(row.verifier),
    nonce: String(row.nonce),
    client: isSignInClient(client) ? client : "browser",
    challenge: text(row.challenge),
    redirect: text(row.redirect),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at)
  };
}

const STATUSES: readonly SignInStatus[] = ["ready", "waiting", "allowed", "denied", "used"];

function toRow(row: Row): SignInRow {
  const status = STATUSES.find((value) => value === row.status) ?? "used";
  return {
    id: String(row.id),
    codeHash: String(row.code_hash),
    client: row.client === "phone" ? "phone" : "desktop",
    email: String(row.email),
    challenge: String(row.challenge),
    name: text(row.name),
    place: text(row.place),
    status,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    decidedAt: row.decided_at === null ? null : Number(row.decided_at)
  };
}

export class SignInStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_sign_in_flows (
        state TEXT PRIMARY KEY,
        verifier TEXT NOT NULL,
        nonce TEXT NOT NULL,
        client TEXT NOT NULL,
        challenge TEXT,
        redirect TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_sign_ins (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        client TEXT NOT NULL,
        email TEXT NOT NULL,
        challenge TEXT NOT NULL,
        name TEXT,
        place TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER
      )`);
      this.#ready = true;
    }
    return this.#sql;
  }

  addFlow(flow: SignInFlow): void {
    this.#db().exec("DELETE FROM pupu_sign_in_flows WHERE expires_at <= ?", flow.createdAt);
    this.#db().exec(
      `INSERT INTO pupu_sign_in_flows
        (state, verifier, nonce, client, challenge, redirect, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      flow.state,
      flow.verifier,
      flow.nonce,
      flow.client,
      flow.challenge,
      flow.redirect,
      flow.createdAt,
      flow.expiresAt
    );
  }

  /** 一个 state 只能回调一次：查到就删掉。过期了也删，返回 undefined。 */
  takeFlow(state: string, now: number): SignInFlow | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_sign_in_flows WHERE state = ?", state).toArray();
    if (!row) return undefined;
    this.#db().exec("DELETE FROM pupu_sign_in_flows WHERE state = ?", state);
    const flow = toFlow(row);
    return flow.expiresAt > now ? flow : undefined;
  }

  add(input: {
    codeHash: string;
    client: Exclude<SignInClient, "browser">;
    email: string;
    challenge: string;
    now: number;
  }): SignInRow {
    this.#db().exec("DELETE FROM pupu_sign_ins WHERE created_at < ?", input.now - KEEP_MS);
    const id = crypto.randomUUID();
    this.#db().exec(
      `INSERT INTO pupu_sign_ins
        (id, code_hash, client, email, challenge, name, place, status, created_at, expires_at, decided_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ready', ?, ?, NULL)`,
      id,
      input.codeHash,
      input.client,
      input.email,
      input.challenge,
      input.now,
      input.now + GRANT_TTL_MS
    );
    const created = this.byId(id);
    if (!created) throw new Error("登录记录没有写进去");
    return created;
  }

  byId(id: string): SignInRow | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_sign_ins WHERE id = ?", id).toArray();
    return row ? toRow(row) : undefined;
  }

  byCode(codeHash: string): SignInRow | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_sign_ins WHERE code_hash = ?", codeHash).toArray();
    return row ? toRow(row) : undefined;
  }

  /** 开始等已有手机点允许。只改还没开始等的，改成了返回 true。 */
  confirm(id: string, input: { name: string; place: string; now: number }): boolean {
    return this.#write(
      "UPDATE pupu_sign_ins SET status = 'waiting', name = ?, place = ?, expires_at = ? WHERE id = ? AND status = 'ready'",
      input.name,
      input.place,
      input.now + CONFIRM_TTL_MS,
      id
    );
  }

  /** 已有手机点了允许或拒绝。 */
  decide(id: string, decision: "allow" | "deny", now: number): "ok" | "missing" | "settled" {
    const row = this.byId(id);
    if (!row) return "missing";
    if (row.status !== "waiting" || now >= row.expiresAt) return "settled";
    const changed = this.#write(
      "UPDATE pupu_sign_ins SET status = ?, decided_at = ?, expires_at = ? WHERE id = ? AND status = 'waiting'",
      decision === "allow" ? "allowed" : "denied",
      now,
      decision === "allow" ? now + PICKUP_MS : row.expiresAt,
      id
    );
    return changed ? "ok" : "settled";
  }

  /** 换成凭据了。同一条只能换一次：改成了返回 true，同时来的另一次请求会拿到 false。 */
  use(id: string): boolean {
    return this.#write(
      "UPDATE pupu_sign_ins SET status = 'used' WHERE id = ? AND status IN ('ready', 'allowed')",
      id
    );
  }

  /** verifier 对不上，这条作废。 */
  burn(id: string): void {
    this.#write("UPDATE pupu_sign_ins SET status = 'used' WHERE id = ?", id);
  }

  /** 在等已有手机点允许、还没过期的，先来的在前。 */
  pending(now: number): SignInRow[] {
    return this.#db()
      .exec("SELECT * FROM pupu_sign_ins WHERE status = 'waiting' AND expires_at > ? ORDER BY created_at", now)
      .toArray()
      .map(toRow);
  }

  #write(query: string, ...bindings: SqlStorageValue[]): boolean {
    const cursor = this.#db().exec(query, ...bindings);
    // 读完游标，语句才算跑完，rowsWritten 才准。
    cursor.toArray();
    return cursor.rowsWritten > 0;
  }
}
