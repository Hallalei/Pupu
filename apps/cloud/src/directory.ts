/**
 * 目录：哪个 Google 账号住在哪个 Pupu。默认一人一个，被邀请才进别人的。
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

export type Assignment = "ok" | "taken" | "full";

/** 这次登录填错几次就作废，要重新走 Google。 */
export const INVITE_ATTEMPTS = 5;

export type Invite = {
  readonly code: string;
  readonly createdAt: number;
  readonly usedBy: string | null;
  readonly usedAt: number | null;
};

/** `left` 是还能生成几个：总名额减去已开的和没用掉的码。 */
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
    sql.exec(`CREATE TABLE IF NOT EXISTS directory_accounts (
      email TEXT PRIMARY KEY,
      pupu TEXT NOT NULL,
      founder INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
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
  }

  home(email: string): Home | null {
    const [row] = this.#sql.exec("SELECT pupu, founder FROM directory_accounts WHERE email = ?", emailKey(email)).toArray();
    return row ? { pupu: String(row.pupu), founder: Number(row.founder) === 1 } : null;
  }

  /** 给一个新账号开 Pupu。名额满了是 null。 */
  claim(email: string, seats: number, now: number): Home | null {
    const known = this.home(email);
    if (known) return known;
    if (this.seatsTaken() >= seats) return null;
    const pupu = crypto.randomUUID().replaceAll("-", "");
    this.#add(email, pupu, true, now);
    return { pupu, founder: true };
  }

  /** 邀请：一个账号只住一个 Pupu，已经有自己的就不搬。 */
  assign(email: string, pupu: string, seats: number, now: number): Assignment {
    const known = this.home(email);
    if (known) return known.pupu === pupu ? "ok" : "taken";
    if (pupu !== ROOT_PUPU && this.seatsTaken() >= seats) return "full";
    this.#add(email, pupu, false, now);
    return "ok";
  }

  /** 成员被移除：名额空出来，下次登录按新人算。 */
  release(email: string, pupu: string): void {
    this.#sql.exec("DELETE FROM directory_accounts WHERE email = ? AND pupu = ? AND founder = 0", emailKey(email), pupu);
  }

  knows(pupu: string): boolean {
    return this.#sql.exec("SELECT 1 FROM directory_accounts WHERE pupu = ? LIMIT 1", pupu).toArray().length > 0;
  }

  seatsTaken(): number {
    const [row] = this.#sql.exec("SELECT COUNT(*) AS taken FROM directory_accounts WHERE pupu != ?", ROOT_PUPU).toArray();
    return Number(row?.taken ?? 0);
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

  /** 没用掉的码也算名额，免得发出去的码到时候开不了。名额发完了是 null。 */
  createInvite(seats: number, now: number): string | null {
    if (this.#invitesLeft(seats) === 0) return null;
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
      left: this.#invitesLeft(seats)
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

    const home = this.claim(signIn.email, seats, now);
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

  #invitesLeft(seats: number): number {
    const [row] = this.#sql.exec("SELECT COUNT(*) AS unused FROM directory_invites WHERE used_by IS NULL").toArray();
    return Math.max(0, seats - this.seatsTaken() - Number(row?.unused ?? 0));
  }

  #add(email: string, pupu: string, founder: boolean, now: number): void {
    this.#sql.exec(
      "INSERT INTO directory_accounts (email, pupu, founder, created_at) VALUES (?, ?, ?, ?)",
      emailKey(email),
      pupu,
      founder ? 1 : 0,
      now
    );
  }
}
