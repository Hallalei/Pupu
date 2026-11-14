import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import { emailKey } from "./members.ts";

/**
 * 通行密钥：没有手机的人在网页上用指纹或系统密码亲手确认。
 *
 * 允许、放宽权限、邀请这几件事原来只认手机 App，因为网页和电脑 App 就开在 Pupu 能操作的电脑上，
 * 它能自己点（见 devices.ts 的 `mayDecide`）。通行密钥的验证由系统弹窗完成，要人按指纹或输系统密码，
 * Pupu 的屏幕操作碰不到这些窗口；签名里的 UV 位说明人确实验证过。所以「手机」和「通行密钥」都算「人亲手确认」。
 *
 * 每次确认先要一个挑战，挑战绑着成员、网站和这件事（`Purpose`），只能用一次，5 分钟过期。
 * 库用 SimpleWebAuthn（MIT），它支持 Workers；挑战一次一用、计数器回写参照了 nealfennimore/passkeys 的 Workers 实现。
 */

/** 网页这一头：rpID 是主机名，origin 是协议加主机。Worker 从请求地址算出来。 */
export type RelyingParty = { readonly id: string; readonly origin: string };

/** 这次确认是为了什么。挑战只对这一件事有效，拿批 A 的确认去批 B 不行。 */
export type Purpose =
  | { readonly kind: "register" }
  | { readonly kind: "add" }
  | { readonly kind: "approval"; readonly id: string }
  | { readonly kind: "policy"; readonly computerId: string; readonly policy: string }
  | { readonly kind: "invite"; readonly email: string }
  /** 在网页上打开这台电脑的远程桌面。 */
  | { readonly kind: "desktop"; readonly computerId: string };

export function purposeKey(purpose: Purpose): string {
  switch (purpose.kind) {
    case "register":
      return "register";
    case "add":
      return "add";
    case "approval":
      return `approval:${purpose.id}`;
    case "policy":
      return `policy:${purpose.computerId}:${purpose.policy}`;
    case "invite":
      return `invite:${emailKey(purpose.email)}`;
    case "desktop":
      return `desktop:${purpose.computerId}`;
  }
}

/** 网页上「通行密钥」那一节的一行。 */
export type PasskeyView = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
};

type PasskeyRow = PasskeyView & {
  readonly memberId: string;
  readonly rpId: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly transports: readonly string[];
};

const CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * 加通行密钥：
 * - 已经有过通行密钥：要用已有的那把先确认一次（`add`），免得拿到网页会话的人再塞一把自己的。
 * - 有过手机：在手机上批就行，网页上不让加。手机是更早定下的那条路，两条并存只会多一个缺口。
 * - 都没有：第一把哪儿都能加，和第一台手机哪儿生成的码都行一样（`mayPair`），不然没手机的人永远批不了。
 */
export type AddRule = "first" | "needs_proof" | "has_phone";

export function addRule(hadPasskey: boolean, hadPhone: boolean): AddRule {
  if (hadPasskey) return "needs_proof";
  if (hadPhone) return "has_phone";
  return "first";
}

export class PasskeyStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_passkeys (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        rp_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      )`);
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_passkey_challenges (
        challenge TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        rp_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`);
      this.#ready = true;
    }
    return this.#sql;
  }

  /** 这个成员在这个网站上能用的，新加的在前。 */
  active(memberId: string, rpId: string): PasskeyRow[] {
    return this.#db()
      .exec(
        "SELECT * FROM pupu_passkeys WHERE member_id = ? AND rp_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
        memberId,
        rpId
      )
      .toArray()
      .map(toRow);
  }

  /** 列给本人看的，不分网站。 */
  views(memberId: string): PasskeyView[] {
    return this.#db()
      .exec("SELECT * FROM pupu_passkeys WHERE member_id = ? AND revoked_at IS NULL ORDER BY created_at DESC", memberId)
      .toArray()
      .map(toRow)
      .map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt }));
  }

  /** 吊销过的也算有过：先吊销再当「第一把」加，钻不了这个空子。 */
  everHad(memberId: string): boolean {
    return this.#db().exec("SELECT 1 FROM pupu_passkeys WHERE member_id = ? LIMIT 1", memberId).toArray().length > 0;
  }

  insert(row: Omit<PasskeyRow, "lastUsedAt">): boolean {
    const written = this.#db().exec(
      `INSERT INTO pupu_passkeys (id, member_id, rp_id, public_key, counter, transports, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      row.id,
      row.memberId,
      row.rpId,
      row.publicKey,
      row.counter,
      JSON.stringify(row.transports),
      row.name,
      row.createdAt
    ).rowsWritten;
    return written > 0;
  }

  used(id: string, counter: number, at: number): void {
    this.#db().exec("UPDATE pupu_passkeys SET counter = ?, last_used_at = ? WHERE id = ?", counter, at, id);
  }

  /** 成员被移除时一起作废。 */
  revokeMember(memberId: string, at: number): void {
    this.#db().exec("UPDATE pupu_passkeys SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL", at, memberId);
  }

  addChallenge(challenge: string, memberId: string, purpose: string, rpId: string, now: number): void {
    const db = this.#db();
    db.exec("DELETE FROM pupu_passkey_challenges WHERE expires_at <= ?", now);
    db.exec(
      "INSERT INTO pupu_passkey_challenges (challenge, member_id, purpose, rp_id, expires_at) VALUES (?, ?, ?, ?, ?)",
      challenge,
      memberId,
      purpose,
      rpId,
      now + CHALLENGE_TTL_MS
    );
  }

  /** 用掉一个挑战：对得上成员、事由、网站而且没过期才算。不管对不对都删掉，一个挑战只给一次机会。 */
  takeChallenge(challenge: string, memberId: string, purpose: string, rpId: string, now: number): boolean {
    const [row] = this.#db()
      .exec("DELETE FROM pupu_passkey_challenges WHERE challenge = ? RETURNING *", challenge)
      .toArray();
    return (
      row !== undefined &&
      row.member_id === memberId &&
      row.purpose === purpose &&
      row.rp_id === rpId &&
      Number(row.expires_at) > now
    );
  }
}

function toRow(row: Record<string, SqlStorageValue>): PasskeyRow {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    rpId: String(row.rp_id),
    publicKey: String(row.public_key),
    counter: Number(row.counter),
    transports: JSON.parse(String(row.transports)) as string[],
    name: String(row.name),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at)
  };
}

/** 加一把的选项。已有的不让重复加；一定要本人验证（UV）。 */
export async function registrationOptions(
  store: PasskeyStore,
  rp: RelyingParty,
  member: { readonly id: string; readonly email: string; readonly name: string | null },
  now: number
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await generateRegistrationOptions({
    rpName: "Pupu",
    rpID: rp.id,
    userName: member.email,
    userDisplayName: member.name ?? member.email,
    userID: new TextEncoder().encode(member.id),
    attestationType: "none",
    excludeCredentials: store.active(member.id, rp.id).map(({ id, transports }) => ({ id, transports: [...transports] })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" }
  });
  store.addChallenge(options.challenge, member.id, purposeKey({ kind: "register" }), rp.id, now);
  return options;
}

export async function register(
  store: PasskeyStore,
  rp: RelyingParty,
  memberId: string,
  response: RegistrationResponseJSON,
  name: string,
  now: number
): Promise<boolean> {
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: (challenge) => store.takeChallenge(challenge, memberId, purposeKey({ kind: "register" }), rp.id, now),
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true
    });
  } catch {
    return false;
  }
  if (!verified.verified) return false;
  const { credential } = verified.registrationInfo;
  return store.insert({
    id: credential.id,
    memberId,
    rpId: rp.id,
    publicKey: toBase64url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
    name,
    createdAt: now
  });
}

/** 确认一件事的选项。这个成员在这个网站上没有通行密钥是 null。 */
export async function proofOptions(
  store: PasskeyStore,
  rp: RelyingParty,
  memberId: string,
  purpose: Purpose,
  now: number
): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
  const keys = store.active(memberId, rp.id);
  if (keys.length === 0) return null;
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: keys.map(({ id, transports }) => ({ id, transports: [...transports] })),
    userVerification: "required"
  });
  store.addChallenge(options.challenge, memberId, purposeKey(purpose), rp.id, now);
  return options;
}

/** 这个成员刚为这件事亲手确认过。签名、UV、挑战、网站有一样不对都是 false。 */
export async function verifyProof(
  store: PasskeyStore,
  rp: RelyingParty,
  memberId: string,
  purpose: Purpose,
  response: AuthenticationResponseJSON,
  now: number
): Promise<boolean> {
  const key = store.active(memberId, rp.id).find((row) => row.id === response.id);
  if (!key) return false;
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (challenge) => store.takeChallenge(challenge, memberId, purposeKey(purpose), rp.id, now),
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: { id: key.id, publicKey: fromBase64url(key.publicKey), counter: key.counter, transports: [...key.transports] },
      requireUserVerification: true
    });
  } catch {
    return false;
  }
  if (!verified.verified) return false;
  store.used(key.id, verified.authenticationInfo.newCounter, now);
  return true;
}

/** 网页说要确认什么。形状不对是 null。`register` 不让网页直接要，它跟着加通行密钥的流程走。 */
export function asPurpose(value: unknown): Purpose | null {
  if (!isRecord(value)) return null;
  const text = (key: string) => (typeof value[key] === "string" && value[key] !== "" ? (value[key] as string) : null);
  switch (value.kind) {
    case "add":
      return { kind: "add" };
    case "approval": {
      const id = text("id");
      return id ? { kind: "approval", id } : null;
    }
    case "policy": {
      const computerId = text("computerId");
      const policy = text("policy");
      return computerId && policy ? { kind: "policy", computerId, policy } : null;
    }
    case "invite": {
      const email = text("email");
      return email ? { kind: "invite", email } : null;
    }
    case "desktop": {
      const computerId = text("computerId");
      return computerId ? { kind: "desktop", computerId } : null;
    }
    default:
      return null;
  }
}

/** 浏览器发来的东西先看形状对不对，不对就当没带。 */
export function asAuthentication(value: unknown): AuthenticationResponseJSON | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.type !== "public-key" || !isRecord(value.response)) return null;
  return value as unknown as AuthenticationResponseJSON;
}

export function asRegistration(value: unknown): RegistrationResponseJSON | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.type !== "public-key" || !isRecord(value.response)) return null;
  return value as unknown as RegistrationResponseJSON;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toBase64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
