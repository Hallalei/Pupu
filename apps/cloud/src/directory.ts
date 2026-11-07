/**
 * 目录：哪个 Google 账号住在哪个 Pupu。默认一人一个，被邀请才进别人的。
 *
 * 每个 Pupu 是一个 Durable Object，数据互不相通。设备凭据和登录码带着 Pupu 的 id 当前缀，
 * Worker 看前缀就知道去哪，平时的请求不用查这里。配对码只有 8 位放不下前缀，单独记一张表。
 * 第一个 Pupu 叫 `ROOT_PUPU`：它的凭据没有前缀，成员也不占名额。
 */
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
