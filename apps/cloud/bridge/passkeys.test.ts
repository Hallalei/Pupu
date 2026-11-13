import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { encodeCBOR } from "@levischuck/tiny-cbor";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { mayChangePolicy, mayDecide } from "../src/devices.ts";
import { mayInvite, type Actor } from "../src/members.ts";
import {
  addRule,
  asPurpose,
  PasskeyStore,
  proofOptions,
  register,
  registrationOptions,
  verifyProof,
  type Purpose,
  type RelyingParty
} from "../src/passkeys.ts";
import { sqlStorage } from "./sql-memory.ts";

const RP: RelyingParty = { id: "app.example.com", origin: "https://app.example.com" };
const ME = { id: "m1", email: "lin@example.com", name: "林夏" };
const NOW = 1_000_000;

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const utf8 = (text: string) => new TextEncoder().encode(text);

/** WebCrypto 给的是 r||s，WebAuthn 要 DER。 */
function der(raw: Uint8Array): Uint8Array {
  const part = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = bytes.slice(start);
    return (trimmed[0] ?? 0) & 0x80 ? Uint8Array.from([0, ...trimmed]) : trimmed;
  };
  const r = part(raw.slice(0, 32));
  const s = part(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s]);
}

/** 软件模拟的一把通行密钥：P-256，验证过本人就带 UV。 */
async function authenticator(rp = RP) {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const id = crypto.getRandomValues(new Uint8Array(16));
  let counter = 0;
  const rpIdHash = await sha256(utf8(rp.id));

  async function create(challenge: string, options: { uv?: boolean; origin?: string } = {}): Promise<RegistrationResponseJSON> {
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x ?? "", "base64url")],
      [-3, Buffer.from(jwk.y ?? "", "base64url")]
    ]);
    const flags = 0x01 | (options.uv === false ? 0 : 0x04) | 0x40;
    const authData = Uint8Array.from([
      ...rpIdHash,
      flags,
      0, 0, 0, 0,
      ...new Uint8Array(16),
      0, id.length,
      ...id,
      ...encodeCBOR(cose)
    ]);
    const attestation = encodeCBOR(
      new Map<string, string | Map<string, never> | Uint8Array>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData]
      ])
    );
    const clientData = utf8(JSON.stringify({ type: "webauthn.create", challenge, origin: options.origin ?? rp.origin }));
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: "public-key",
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestation), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform"
    };
  }

  async function get(challenge: string, options: { uv?: boolean; origin?: string } = {}): Promise<AuthenticationResponseJSON> {
    counter += 1;
    const authData = Uint8Array.from([
      ...rpIdHash,
      0x01 | (options.uv === false ? 0 : 0x04),
      (counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff
    ]);
    const clientData = utf8(JSON.stringify({ type: "webauthn.get", challenge, origin: options.origin ?? rp.origin }));
    const signed = Uint8Array.from([...authData, ...(await sha256(clientData))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed));
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: "public-key",
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(der(raw)) },
      clientExtensionResults: {}
    };
  }

  return { create, get };
}

async function enrolled() {
  const store = new PasskeyStore(sqlStorage());
  const key = await authenticator();
  const options = await registrationOptions(store, RP, ME, NOW);
  assert.equal(await register(store, RP, ME.id, await key.create(options.challenge), "Chrome · Mac", NOW), true);
  return { store, key };
}

async function prove(store: PasskeyStore, key: Awaited<ReturnType<typeof authenticator>>, purpose: Purpose) {
  const options = await proofOptions(store, RP, ME.id, purpose, NOW);
  assert.ok(options);
  return key.get(options.challenge);
}

const APPROVAL: Purpose = { kind: "approval", id: "a1" };

describe("加通行密钥", () => {
  test("没有过通行密钥也没连过手机：第一把哪儿都能加", () => {
    assert.equal(addRule(false, false), "first");
  });

  test("有过手机：在手机上批，不在网页上加", () => {
    assert.equal(addRule(false, true), "has_phone");
  });

  test("有过通行密钥（吊销的也算）：先用已有的确认", () => {
    assert.equal(addRule(true, false), "needs_proof");
    assert.equal(addRule(true, true), "needs_proof");
  });

  test("加好之后列给本人看，算有过", async () => {
    const { store } = await enrolled();
    assert.deepEqual(
      store.views(ME.id).map(({ name }) => name),
      ["Chrome · Mac"]
    );
    assert.equal(store.everHad(ME.id), true);
  });

  test("没验证本人（没有 UV）的不收", async () => {
    const store = new PasskeyStore(sqlStorage());
    const key = await authenticator();
    const options = await registrationOptions(store, RP, ME, NOW);
    assert.equal(await register(store, RP, ME.id, await key.create(options.challenge, { uv: false }), "x", NOW), false);
  });

  test("别的网站发起的不收", async () => {
    const store = new PasskeyStore(sqlStorage());
    const key = await authenticator();
    const options = await registrationOptions(store, RP, ME, NOW);
    const response = await key.create(options.challenge, { origin: "https://evil.example.net" });
    assert.equal(await register(store, RP, ME.id, response, "x", NOW), false);
  });

  test("挑战是别人的，不收", async () => {
    const store = new PasskeyStore(sqlStorage());
    const key = await authenticator();
    const options = await registrationOptions(store, RP, { ...ME, id: "m2" }, NOW);
    assert.equal(await register(store, RP, ME.id, await key.create(options.challenge), "x", NOW), false);
  });
});

describe("用通行密钥确认一件事", () => {
  test("签名、本人验证、挑战都对：算这个成员确认过", async () => {
    const { store, key } = await enrolled();
    assert.equal(await verifyProof(store, RP, ME.id, APPROVAL, await prove(store, key, APPROVAL), NOW), true);
    assert.ok(store.views(ME.id)[0]?.lastUsedAt);
  });

  test("为 A 确认的拿去批 B 不行", async () => {
    const { store, key } = await enrolled();
    const proof = await prove(store, key, APPROVAL);
    assert.equal(await verifyProof(store, RP, ME.id, { kind: "approval", id: "a2" }, proof, NOW), false);
  });

  test("邀请的邮箱大小写不同也是同一件事", async () => {
    const { store, key } = await enrolled();
    const proof = await prove(store, key, { kind: "invite", email: "Zhou@Example.com " });
    assert.equal(await verifyProof(store, RP, ME.id, { kind: "invite", email: "zhou@example.com" }, proof, NOW), true);
  });

  test("一个挑战只能用一次", async () => {
    const { store, key } = await enrolled();
    const proof = await prove(store, key, APPROVAL);
    assert.equal(await verifyProof(store, RP, ME.id, APPROVAL, proof, NOW), true);
    assert.equal(await verifyProof(store, RP, ME.id, APPROVAL, proof, NOW), false);
  });

  test("过了 5 分钟不算", async () => {
    const { store, key } = await enrolled();
    const proof = await prove(store, key, APPROVAL);
    assert.equal(await verifyProof(store, RP, ME.id, APPROVAL, proof, NOW + 5 * 60_000 + 1), false);
  });

  test("没验证本人不算", async () => {
    const { store, key } = await enrolled();
    const options = await proofOptions(store, RP, ME.id, APPROVAL, NOW);
    assert.ok(options);
    assert.equal(await verifyProof(store, RP, ME.id, APPROVAL, await key.get(options.challenge, { uv: false }), NOW), false);
  });

  test("没加过的密钥签的不算", async () => {
    const { store } = await enrolled();
    const stranger = await authenticator();
    const options = await proofOptions(store, RP, ME.id, APPROVAL, NOW);
    assert.ok(options);
    assert.equal(await verifyProof(store, RP, ME.id, APPROVAL, await stranger.get(options.challenge), NOW), false);
  });

  test("别的成员拿不到确认选项，也不能借我的挑战", async () => {
    const { store, key } = await enrolled();
    assert.equal(await proofOptions(store, RP, "m2", APPROVAL, NOW), null);
    const proof = await prove(store, key, APPROVAL);
    assert.equal(await verifyProof(store, RP, "m2", APPROVAL, proof, NOW), false);
  });

  test("在别的网址上没有通行密钥", async () => {
    const { store } = await enrolled();
    assert.equal(await proofOptions(store, { id: "other.example.com", origin: "https://other.example.com" }, ME.id, APPROVAL, NOW), null);
  });

  test("成员被移除后通行密钥一起作废，但仍算有过", async () => {
    const { store } = await enrolled();
    store.revokeMember(ME.id, NOW);
    assert.equal(await proofOptions(store, RP, ME.id, APPROVAL, NOW), null);
    assert.deepEqual(store.views(ME.id), []);
    assert.equal(store.everHad(ME.id), true);
  });
});

describe("确认过的算亲手确认", () => {
  const browser: Actor = { kind: "browser", memberId: "me", role: "member" };
  const creatorBrowser: Actor = { kind: "browser", memberId: "me", role: "creator" };

  test("允许：电脑主人用通行密钥确认过就行，别人确认过不行", () => {
    assert.equal(mayDecide("allow", browser, "me", "me"), true);
    assert.equal(mayDecide("allow", browser, "me", null), false);
    assert.equal(mayDecide("allow", browser, "me", "other"), false);
    assert.equal(mayDecide("allow", { ...browser, memberId: "other" }, "me", "me"), false, "设备不是主人的");
  });

  test("没有主人的电脑和新手机登录：通行密钥不顶手机", () => {
    assert.equal(mayDecide("allow", browser, null, "me"), false);
  });

  test("放宽分级不用通行密钥：主人的浏览器直接就能改", () => {
    assert.equal(mayChangePolicy("ask_risky", "trust", browser, "me"), true);
    assert.equal(mayChangePolicy("ask_risky", "trust", { ...browser, memberId: "other" }, "me"), false);
  });

  test("邀请成员：创建者用通行密钥确认过就行", () => {
    assert.equal(mayInvite(creatorBrowser, "me"), true);
    assert.equal(mayInvite(creatorBrowser, null), false);
    assert.equal(mayInvite(browser, "me"), false, "不是创建者");
  });
});

test("网页说要确认什么：形状不对的不认，register 不让直接要", () => {
  assert.deepEqual(asPurpose({ kind: "approval", id: "a1" }), { kind: "approval", id: "a1" });
  assert.deepEqual(asPurpose({ kind: "policy", computerId: "c1", policy: "trust" }), {
    kind: "policy",
    computerId: "c1",
    policy: "trust"
  });
  assert.equal(asPurpose({ kind: "approval" }), null);
  assert.equal(asPurpose({ kind: "register" }), null);
  assert.equal(asPurpose("approval"), null);
});
