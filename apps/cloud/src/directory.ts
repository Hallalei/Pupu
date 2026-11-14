/**
 * 目录：哪个 Google 账号在哪些 Pupu 里。一个账号可以有自己开的一个，再被邀请进别人的（docs/协作方案.md 第 1、9 节）。
 * 被邀请的新账号没有自己的，只进邀请他的那个，想要自己的再用邀请码开。被移出一个只断那一条。
 *
 * 每个 Pupu 是一个 Durable Object，数据互不相通。设备凭据和登录码带着 Pupu 的 id 当前缀，
 * Worker 看前缀就知道去哪，平时的请求不用查这里。配对码只有 8 位放不下前缀，单独记一张表。
 * 第一个 Pupu 叫 `ROOT_PUPU`：它的凭据没有前缀，成员也不占名额。
 *
 * 开新 Pupu 要邀请码。Google 认过身份还没有 Pupu 的登录先存在这里，填对码才继续。
 */
import type { SignInFlow } from "./auth/sign-ins.ts";
import { newPairingCode, normalizePairingCode } from "./devices.ts";
import { emailKey } from "./members.ts";

export const ROOT_PUPU = "me";

const SEPARATOR = ".";

export function scopedCredential(pupu: string, credential: string): string {
  return pupu === ROOT_PUPU ? credential : `${pupu}${SEPARATOR}${credential}`;
}

export function pupuOfCredential(credential: string): string {
  const at = credential.indexOf(SEPARATOR);
  return at > 0 ? credential.slice(0, at) : ROOT_PUPU;
}

/** `founder` 是这个人开的 Pupu，第一次登录时成为创建者。 */
export type Home = { readonly pupu: string; readonly founder: boolean };

export type Assignment = "ok" | "full";

/** 已经登录的人开自己的 Pupu 时，填错的次数按这么长算一轮。 */
const CODE_TRY_WINDOW_MS = 60 * 60 * 1000;

/** 这次登录填错几次就作废，要重新走 Google。 */
export const INVITE_ATTEMPTS = 5;

export type Invite = {
  readonly code: string;
  readonly createdAt: number;
  readonly usedBy: string | null;
  readonly usedAt: number | null;
};

/** `left` 是还能生成几个，见 `#freeSeats`。 */
export type InviteList = { readonly invites: readonly Invite[]; readonly left: number };

/** Google 认过了、停在邀请码这一步的登录。 */
export type HeldSignIn = {
  readonly flow: SignInFlow;
  readonly email: string;
  readonly name: string;
  readonly displayName: string | null;
};

export type Activation =
  | { readonly status: "ok"; readonly home: Home; readonly signIn: HeldSignIn }
  | { readonly status: "wrong" | "full" | "gone" };

/** 不分大小写，O 当 0，I、L 当 1，和配对码一样。存的是 ABCD-EFGH。 */
function inviteCode(input: string): string | null {
  const code = normalizePairingCode(input);
  return code && `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function seatsFrom(env: { readonly PUPU_SEATS?: string }): number {
  const seats = Number(env.PUPU_SEATS ?? 0);
  return Number.isInteger(seats) && seats > 0 ? seats : 0;
}

export class DirectoryStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    // 老表一个邮箱一行，只记第一个家。留着不删：回滚到老版本还认得每个人的第一个家，新加的关系老版本看不到。
    sql.exec(`CREATE TABLE IF NOT EXISTS directory_accounts (
      email TEXT PRIMARY KEY,
      pupu TEXT NOT NULL,
      founder INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS directory_memberships (
      email TEXT NOT NULL,
      pupu TEXT NOT NULL,
      founder INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (email, pupu)
    )`);
    // 幂等：每次启动都抄一遍，抄过的跳过。
    sql.exec(`INSERT OR IGNORE INTO directory_memberships (email, pupu, founder, created_at)
      SELECT email, pupu, founder, created_at FROM directory_accounts`);
    sql.exec(`CREATE TABLE IF NOT EXISTS directory_codes (
      code_hash TEXT PRIMARY KEY,
      pupu TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS directory_invites (
      code TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      used_by TEXT,
      used_at INTEGER
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS directory_activations (
      token_hash TEXT PRIMARY KEY,
      sign_in TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS directory_code_tries (
      email TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      since INTEGER NOT NULL
    )`);
  }

  /** 这个账号在的所有组织：自己开的在前，其余按加入的先后。第一个 Pupu 的老成员不在这里，见 server.ts 的 `orgsOf`。 */
  memberships(email: string): Home[] {
    return this.#sql
      .exec(
        "SELECT pupu, founder FROM directory_memberships WHERE email = ? ORDER BY founder DESC, created_at, pupu",
        emailKey(email)
      )
      .toArray()
      .map((row) => ({ pupu: String(row.pupu), founder: Number(row.founder) === 1 }));
  }

  /** 登录时默认进哪个：自己开的，没有就是最早加入的。 */
  home(email: string): Home | null {
    return this.memberships(email)[0] ?? null;
  }

  membership(email: string, pupu: string): Home | null {
    return this.memberships(email).find((each) => each.pupu === pupu) ?? null;
  }

  /**
   * 给一个账号开他自己的 Pupu。`code` 是他填的邀请码，码一直替他占着一个名额。已经开过就回到那个。
   * 名额满了是 null。已经在别的 Pupu 里占着名额的人，开自己的不再多占。
   */
  claim(email: string, seats: number, now: number, code?: string): Home | null {
    const own = this.memberships(email).find((each) => each.founder);
    if (own) return own;
    if (!this.#seated(email) && this.#freeSeats(seats, code) <= 0) return null;
    const pupu = crypto.randomUUID().replaceAll("-", "");
    this.#add(email, pupu, true, now);
    return { pupu, founder: true };
  }

  /** 邀请进一个 Pupu。一个账号能在好几个 Pupu 里，名额按人算，已经占着的不再多占。第一个 Pupu 不占名额。 */
  assign(email: string, pupu: string, seats: number, now: number): Assignment {
    if (this.membership(email, pupu)) return "ok";
    if (pupu !== ROOT_PUPU && !this.#seated(email) && this.#freeSeats(seats) <= 0) return "full";
    this.#add(email, pupu, false, now);
    return "ok";
  }

  /** 从一个 Pupu 移除：只断这一条，别的 Pupu 里照旧。没有别的 Pupu 了，名额空出来。 */
  release(email: string, pupu: string): void {
    this.#sql.exec(
      "DELETE FROM directory_memberships WHERE email = ? AND pupu = ? AND founder = 0",
      emailKey(email),
      pupu
    );
    this.#sql.exec("DELETE FROM directory_accounts WHERE email = ? AND pupu = ? AND founder = 0", emailKey(email), pupu);
  }

  knows(pupu: string): boolean {
    return this.#sql.exec("SELECT 1 FROM directory_memberships WHERE pupu = ? LIMIT 1", pupu).toArray().length > 0;
  }

  /**
   * 已经登录的人用邀请码开自己的 Pupu。码不对按账号记次数，一小时 INVITE_ATTEMPTS 次。
   * 查码、开、记下用掉中间没有 await。
   */
  openOwn(email: string, input: string, seats: number, now: number): Home | "exists" | "wrong" | "full" | "limited" {
    if (this.memberships(email).some((each) => each.founder)) return "exists";
    const key = emailKey(email);
    const [tries] = this.#sql.exec("SELECT attempts, since FROM directory_code_tries WHERE email = ?", key).toArray();
    const fresh = !tries || now - Number(tries.since) > CODE_TRY_WINDOW_MS;
    const attempts = fresh ? 0 : Number(tries.attempts);
    if (attempts >= INVITE_ATTEMPTS) return "limited";
    const code = inviteCode(input);
    if (!code || !this.#unusedInvite(code)) {
      this.#sql.exec(
        "INSERT OR REPLACE INTO directory_code_tries (email, attempts, since) VALUES (?, ?, ?)",
        key,
        attempts + 1,
        fresh ? now : Number(tries?.since ?? now)
      );
      return "wrong";
    }
    const home = this.claim(email, seats, now, code);
    if (!home) return "full";
    this.#sql.exec("UPDATE directory_invites SET used_by = ?, used_at = ? WHERE code = ?", key, now, code);
    this.#sql.exec("DELETE FROM directory_code_tries WHERE email = ?", key);
    return home;
  }

  rememberCode(codeHash: string, pupu: string, expiresAt: number, now: number): void {
    this.#sql.exec("DELETE FROM directory_codes WHERE expires_at <= ?", now);
    this.#sql.exec(
      "INSERT OR REPLACE INTO directory_codes (code_hash, pupu, expires_at) VALUES (?, ?, ?)",
      codeHash,
      pupu,
      expiresAt
    );
  }

  pupuOfCode(codeHash: string, now: number): string | null {
    const [row] = this.#sql
      .exec("SELECT pupu FROM directory_codes WHERE code_hash = ? AND expires_at > ?", codeHash, now)
      .toArray();
    return row ? String(row.pupu) : null;
  }

  /** 名额发完了是 null。 */
  createInvite(seats: number, now: number): string | null {
    if (this.#freeSeats(seats) <= 0) return null;
    const code = newPairingCode();
    this.#sql.exec("INSERT INTO directory_invites (code, created_at) VALUES (?, ?)", code, now);
    return code;
  }

  invites(seats: number): InviteList {
    const rows = this.#sql
      .exec("SELECT code, created_at, used_by, used_at FROM directory_invites ORDER BY used_at IS NOT NULL, created_at DESC")
      .toArray();
    return {
      invites: rows.map((row) => ({
        code: String(row.code),
        createdAt: Number(row.created_at),
        usedBy: row.used_by === null ? null : String(row.used_by),
        usedAt: row.used_at === null ? null : Number(row.used_at)
      })),
      left: Math.max(0, this.#freeSeats(seats))
    };
  }

  /** 只能作废没用过的码。 */
  revokeInvite(input: string): boolean {
    const code = inviteCode(input);
    if (!code || !this.#unusedInvite(code)) return false;
    this.#sql.exec("DELETE FROM directory_invites WHERE code = ?", code);
    return true;
  }

  holdSignIn(tokenHash: string, signIn: HeldSignIn, expiresAt: number, now: number): void {
    this.#sql.exec("DELETE FROM directory_activations WHERE expires_at <= ?", now);
    this.#sql.exec(
      "INSERT INTO directory_activations (token_hash, sign_in, attempts, expires_at) VALUES (?, ?, 0, ?)",
      tokenHash,
      JSON.stringify(signIn),
      expiresAt
    );
  }

  /** 查码、开 Pupu、记下用掉，中间没有 await，同一个码开不出两个 Pupu。 */
  activate(tokenHash: string, input: string, seats: number, now: number): Activation {
    const [held] = this.#sql
      .exec("SELECT sign_in, attempts FROM directory_activations WHERE token_hash = ? AND expires_at > ?", tokenHash, now)
      .toArray();
    if (!held) return { status: "gone" };
    const signIn = JSON.parse(String(held.sign_in)) as HeldSignIn;

    const known = this.home(signIn.email);
    if (known) {
      this.#dropSignIn(tokenHash);
      return { status: "ok", home: known, signIn };
    }

    const code = inviteCode(input);
    if (!code || !this.#unusedInvite(code)) {
      const attempts = Number(held.attempts) + 1;
      if (attempts >= INVITE_ATTEMPTS) {
        this.#dropSignIn(tokenHash);
        return { status: "gone" };
      }
      this.#sql.exec("UPDATE directory_activations SET attempts = ? WHERE token_hash = ?", attempts, tokenHash);
      return { status: "wrong" };
    }

    const home = this.claim(signIn.email, seats, now, code);
    if (!home) return { status: "full" };
    this.#sql.exec("UPDATE directory_invites SET used_by = ?, used_at = ? WHERE code = ?", emailKey(signIn.email), now, code);
    this.#dropSignIn(tokenHash);
    return { status: "ok", home, signIn };
  }

  #dropSignIn(tokenHash: string): void {
    this.#sql.exec("DELETE FROM directory_activations WHERE token_hash = ?", tokenHash);
  }

  #unusedInvite(code: string): boolean {
    return this.#sql.exec("SELECT 1 FROM directory_invites WHERE code = ? AND used_by IS NULL", code).toArray().length > 0;
  }

  /** 这个人已经占着一个名额：在第一个 Pupu 以外的哪个 Pupu 里。 */
  #seated(email: string): boolean {
    return (
      this.#sql
        .exec("SELECT 1 FROM directory_memberships WHERE email = ? AND pupu != ? LIMIT 1", emailKey(email), ROOT_PUPU)
        .toArray().length > 0
    );
  }

  /**
   * 空着的名额：总数减去占着的人（在第一个 Pupu 以外的 Pupu 里的人，在几个都只算一个）和没用掉的邀请码。
   * 码一发出去就替拿码的人占着，免得到时候开不了。`using` 是正要用掉的那个码，它占的那一个让给用它的人。
   */
  #freeSeats(seats: number, using?: string): number {
    const [row] = this.#sql
      .exec(
        `SELECT (SELECT COUNT(DISTINCT email) FROM directory_memberships WHERE pupu != ?)
              + (SELECT COUNT(*) FROM directory_invites WHERE used_by IS NULL AND code != ?) AS held`,
        ROOT_PUPU,
        using ?? ""
      )
      .toArray();
    return seats - Number(row?.held ?? 0);
  }

  #add(email: string, pupu: string, founder: boolean, now: number): void {
    this.#sql.exec(
      "INSERT INTO directory_memberships (email, pupu, founder, created_at) VALUES (?, ?, ?, ?)",
      emailKey(email),
      pupu,
      founder ? 1 : 0,
      now
    );
    // 老表只记第一个家，给回滚用。
    this.#sql.exec(
      "INSERT OR IGNORE INTO directory_accounts (email, pupu, founder, created_at) VALUES (?, ?, ?, ?)",
      emailKey(email),
      pupu,
      founder ? 1 : 0,
      now
    );
  }
}
