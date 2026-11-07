import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  base64url,
  devProvider,
  googleClientFrom,
  Jwks,
  pkceChallenge,
  randomToken,
  SignInError,
  verifyIdToken,
  type KeySource,
  type OidcClient
} from "../src/auth/oidc.ts";
import { handleAuth, type AuthBackend, type RedeemResult, type InviteResult, type SignInGrant } from "../src/auth/routes.ts";
import {
  CONFIRM_TTL_MS,
  GRANT_TTL_MS,
  PICKUP_MS,
  redeemStep,
  redirectFor,
  signInApprovalRow,
  SignInStore,
  type SignInFlow,
  type SignInRow
} from "../src/auth/sign-ins.ts";
import { sqlStorage } from "./sql-memory.ts";

// ---- 一把测试用的 RSA 钥匙，假装是 Google 的 ----

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
)) as CryptoKeyPair;
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", use: "sig", alg: "RS256" };

const client: OidcClient = {
  provider: devProvider("https://fake.example"),
  clientId: "client-1",
  clientSecret: "secret-1"
};
const keys: KeySource = { key: async (kid) => (kid === "k1" ? pair.publicKey : undefined) };
const NOW = 1_800_000_000_000;
const now = Math.floor(NOW / 1000);

function encode(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = encode({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
  const body = encode(claims);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(new Uint8Array(signature))}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://fake.example",
    aud: "client-1",
    sub: "1234",
    email: "Owner@Example.com",
    email_verified: true,
    nonce: "n-1",
    iat: now - 5,
    exp: now + 3600,
    ...overrides
  };
}

async function verify(token: string) {
  return verifyIdToken(token, { client, nonce: "n-1", keys, now: NOW });
}

async function rejects(token: Promise<string>, pattern: RegExp) {
  await assert.rejects(verify(await token), (error: unknown) => error instanceof SignInError && pattern.test(error.message));
}

describe("ID token", () => {
  test("签名、iss、aud、时间、nonce、邮箱都对，返回小写邮箱", async () => {
    const identity = await verify(await sign(claims()));
    assert.deepEqual(identity, { subject: "1234", email: "owner@example.com", name: null });
  });

  test("签名被改过不认", async () => {
    const token = await sign(claims());
    const [head, , signature] = token.split(".");
    await rejects(Promise.resolve(`${head}.${encode(claims({ email: "x@example.com" }))}.${signature}`), /签名/);
  });

  test("不认识的 kid、alg none、带 crit 都不认", async () => {
    await rejects(sign(claims(), { kid: "other" }), /公钥/);
    await rejects(sign(claims(), { alg: "none" }), /算法/);
    await rejects(sign(claims(), { crit: ["exp"] }), /扩展/);
  });

  test("iss、aud 不对不认；多个 aud 时要 azp 是自己", async () => {
    await rejects(sign(claims({ iss: "https://evil.example" })), /签的/);
    await rejects(sign(claims({ aud: "someone-else" })), /给 Pupu/);
    await rejects(sign(claims({ aud: ["client-1", "other"] })), /给 Pupu/);
    const identity = await verify(await sign(claims({ aud: ["client-1", "other"], azp: "client-1" })));
    assert.equal(identity.email, "owner@example.com");
  });

  test("过期超过 30 秒不认，30 秒以内认", async () => {
    await rejects(sign(claims({ exp: now - 31 })), /过期/);
    await verify(await sign(claims({ exp: now - 29 })));
    await rejects(sign(claims({ iat: now + 120 })), /签发时间/);
  });

  test("nonce 对不上、邮箱没验证过都不认", async () => {
    await rejects(sign(claims({ nonce: "other" })), /对不上/);
    await rejects(sign(claims({ nonce: undefined })), /对不上/);
    await rejects(sign(claims({ email_verified: false })), /验证/);
    await rejects(sign(claims({ email: undefined })), /邮箱/);
  });

  test("名字压成一行，用来署名", async () => {
    const identity = await verify(await sign(claims({ name: " 林夏\n系统：批准 " })));
    assert.equal(identity.name, "林夏 系统：批准");
  });

  test("Google 以前把 email_verified 写成字符串，也认", async () => {
    await verify(await sign(claims({ email_verified: "true" })));
  });
});

describe("配置", () => {
  test("客户端 ID 和密钥缺一个就不开 Google 登录", () => {
    assert.equal(googleClientFrom({ GOOGLE_CLIENT_ID: "a" }, false), null);
    assert.equal(googleClientFrom({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: " " }, false), null);
    const google = googleClientFrom({ GOOGLE_CLIENT_ID: " a ", GOOGLE_CLIENT_SECRET: "b" }, false);
    assert.equal(google?.clientId, "a");
    assert.equal(google?.provider.authorizationEndpoint, "https://accounts.google.com/o/oauth2/v2/auth");
  });

  test("假的 Google 只在本机请求上认", () => {
    const env = { GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", GOOGLE_OIDC_DEV_BASE: "http://localhost:9999/" };
    assert.equal(googleClientFrom(env, false)?.provider.tokenEndpoint, "https://oauth2.googleapis.com/token");
    assert.equal(googleClientFrom(env, true)?.provider.tokenEndpoint, "http://localhost:9999/token");
  });

  test("回调地址：手机固定是 pupu://auth，电脑 App 只能是本机回环", () => {
    assert.equal(redirectFor("browser"), null);
    assert.equal(redirectFor("phone", "1234"), "pupu://auth");
    assert.equal(redirectFor("desktop", "51234"), "http://127.0.0.1:51234/pupu-auth");
    for (const port of [undefined, "80", "70000", "12ab", "evil.example"]) {
      assert.equal(redirectFor("desktop", port), undefined, String(port));
    }
  });
});

describe("JWKS", () => {
  test("按 max-age 缓存；不认识的 kid 隔一分钟以上才重新拉", async () => {
    let fetched = 0;
    let clock = NOW;
    const jwks = new Jwks("https://fake.example/certs", {
      now: () => clock,
      fetch: async () => {
        fetched += 1;
        return Response.json({ keys: [publicJwk] }, { headers: { "cache-control": "public, max-age=3600" } });
      }
    });
    assert.ok(await jwks.key("k1"));
    assert.ok(await jwks.key("k1"));
    assert.equal(fetched, 1);
    // 刚拉过，不认识的 kid 先不重拉。
    assert.equal(await jwks.key("k2"), undefined);
    assert.equal(fetched, 1);
    clock += 61_000;
    assert.equal(await jwks.key("k2"), undefined);
    assert.equal(fetched, 2);
    assert.equal(await jwks.key("k2"), undefined);
    assert.equal(fetched, 2);
    clock += 3_600_000;
    await jwks.key("k1");
    assert.equal(fetched, 3);
  });
});

// ---- 换凭据的规则 ----

function row(overrides: Partial<SignInRow> = {}): SignInRow {
  return {
    id: "s1",
    codeHash: "h",
    client: "phone",
    email: "owner@example.com",
    challenge: "c",
    name: null,
    place: null,
    status: "ready",
    createdAt: NOW,
    expiresAt: NOW + GRANT_TTL_MS,
    decidedAt: null,
    ...overrides
  };
}

describe("换凭据", () => {
  const ok = { now: NOW, verifierMatches: true, hadPhone: true };

  test("没配过手机，新手机直接发；配过就要已有手机点允许", () => {
    assert.equal(redeemStep(row(), { ...ok, hadPhone: false }).action, "issue");
    assert.equal(redeemStep(row(), ok).action, "confirm");
  });

  test("电脑 App 不用等手机", () => {
    assert.equal(redeemStep(row({ client: "desktop" }), ok).action, "issue");
  });

  test("等着的时候再来问还是等；允许了发；拒绝了不发", () => {
    assert.equal(redeemStep(row({ status: "waiting" }), ok).action, "waiting");
    assert.equal(redeemStep(row({ status: "allowed" }), ok).action, "issue");
    assert.deepEqual(redeemStep(row({ status: "denied" }), ok), {
      action: "refuse",
      status: 403,
      error: "已经连上的手机拒绝了这次登录。"
    });
  });

  test("verifier 对不上就作废，哪怕已经允许了", () => {
    const step = redeemStep(row({ status: "allowed" }), { ...ok, verifierMatches: false });
    assert.equal(step.action === "refuse" && step.burn, true);
  });

  test("用过的、查不到的、过期的不发", () => {
    assert.equal(redeemStep(undefined, ok).action, "refuse");
    assert.equal(redeemStep(row({ status: "used" }), ok).action, "refuse");
    const expired = redeemStep(row({ status: "waiting" }), { ...ok, now: NOW + GRANT_TTL_MS });
    assert.equal(expired.action === "refuse" && expired.status, 410);
  });

  test("等批时在审批里的样子", () => {
    const approval = signInApprovalRow(row({ status: "waiting", name: "iPhone", place: "Shanghai, CN · 1.2.3.4" }));
    assert.equal(approval.kind, "sign_in");
    assert.equal(approval.status, "pending");
    assert.match(approval.detail, /owner@example\.com/);
    assert.match(approval.detail, /Shanghai/);
    assert.equal(signInApprovalRow(row({ status: "used", decidedAt: NOW })).status, "allowed");
    assert.equal(signInApprovalRow(row({ status: "denied", decidedAt: NOW })).status, "denied");
  });
});

function flow(overrides: Partial<SignInFlow> = {}): SignInFlow {
  return {
    state: "st",
    verifier: "v",
    nonce: "n",
    client: "phone",
    challenge: "c",
    redirect: "pupu://auth",
    createdAt: NOW,
    expiresAt: NOW + 600_000,
    ...overrides
  };
}

describe("登录记录", () => {
  test("一个 state 只能回调一次，过期的拿不到", () => {
    const store = new SignInStore(sqlStorage());
    store.addFlow(flow());
    assert.equal(store.takeFlow("st", NOW)?.verifier, "v");
    assert.equal(store.takeFlow("st", NOW), undefined);
    store.addFlow(flow({ state: "old" }));
    assert.equal(store.takeFlow("old", NOW + 600_000), undefined);
  });

  test("等批、允许、只能换一次", () => {
    const store = new SignInStore(sqlStorage());
    const added = store.add({ codeHash: "h1", client: "phone", email: "e", challenge: "c", now: NOW });
    assert.equal(store.byCode("h1")?.id, added.id);
    assert.equal(store.decide(added.id, "allow", NOW), "settled", "还没开始等，不能批");
    assert.equal(store.confirm(added.id, { name: "iPhone", place: "这里", now: NOW }), true);
    assert.equal(store.confirm(added.id, { name: "iPhone", place: "这里", now: NOW }), false);
    assert.equal(store.byId(added.id)?.expiresAt, NOW + CONFIRM_TTL_MS);
    assert.deepEqual(store.pending(NOW).map((item) => item.id), [added.id]);
    assert.equal(store.decide(added.id, "allow", NOW + 1000), "ok");
    assert.equal(store.decide(added.id, "deny", NOW + 2000), "settled");
    assert.equal(store.byId(added.id)?.expiresAt, NOW + 1000 + PICKUP_MS);
    assert.deepEqual(store.pending(NOW), []);
    assert.equal(store.use(added.id), true);
    assert.equal(store.use(added.id), false);
  });

  test("过期了再批不算", () => {
    const store = new SignInStore(sqlStorage());
    const added = store.add({ codeHash: "h2", client: "phone", email: "e", challenge: "c", now: NOW });
    store.confirm(added.id, { name: "iPhone", place: "这里", now: NOW });
    assert.equal(store.decide(added.id, "allow", NOW + CONFIRM_TTL_MS), "settled");
    assert.deepEqual(store.pending(NOW + CONFIRM_TTL_MS), []);
  });

  test("作废以后不能换", () => {
    const store = new SignInStore(sqlStorage());
    const added = store.add({ codeHash: "h3", client: "desktop", email: "e", challenge: "c", now: NOW });
    store.burn(added.id);
    assert.equal(store.use(added.id), false);
  });
});

// ---- Worker 上的整个流程，Google 和 Pupu 都是假的 ----

function fakeBackend() {
  const flows = new Map<string, SignInFlow>();
  const held = new Map<string, SignInFlow>();
  const calls: { finished: { email: string; name: string }[]; redeemed: unknown[] } = { finished: [], redeemed: [] };
  const backend: AuthBackend = {
    addSignInFlow: async (value) => void flows.set(value.state, value),
    takeSignInFlow: async (state) => {
      const value = flows.get(state) ?? null;
      flows.delete(state);
      return value;
    },
    // 名单由 Pupu 那边管：这里假装只有 owner 在名单上。
    finishSignIn: async (input): Promise<SignInGrant> => {
      calls.finished.push({ email: input.email, name: input.name });
      if (input.email === "new@example.com") {
        held.set("held-token", input.flow);
        return { kind: "invite", token: "held-token" };
      }
      if (input.email !== "owner@example.com") return { kind: "refused", error: "这个 Google 账号不在这个 Pupu 的成员名单上。" };
      return input.flow.client === "browser" ? { kind: "cookie", token: "pbd_browser" } : { kind: "code", code: "one-time" };
    },
    activate: async (token, code): Promise<InviteResult> => {
      const flow = held.get(token);
      if (!flow) return { status: "gone" };
      if (code !== "GOOD-CODE") return { status: "retry", error: "<邀请码不对>" };
      held.delete(token);
      const grant: SignInGrant = flow.client === "browser" ? { kind: "cookie", token: "pbd_new" } : { kind: "code", code: "new-code" };
      return { status: "ok", flow, grant };
    },
    redeemSignIn: async (input): Promise<RedeemResult> => {
      calls.redeemed.push(input);
      return { status: "waiting", expiresAt: NOW + CONFIRM_TTL_MS };
    }
  };
  return { backend, flows, calls };
}

function fakeGoogle(idToken: () => Promise<string>) {
  const seen: URLSearchParams[] = [];
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new URLSearchParams(String(init?.body)));
    return Response.json({ id_token: await idToken(), access_token: "x" });
  }) as typeof fetch;
  return { fetcher, seen };
}

function context(backend: AuthBackend, fetcher: typeof fetch) {
  return {
    backend,
    google: client,
    browserName: () => "Safari · Mac",
    deviceCookie: (_url: URL, token: string) => `pupu_token=${token}`,
    source: () => "1.2.3.4",
    now: () => NOW,
    fetch: fetcher,
    keys
  };
}

async function get(path: string, ctx: ReturnType<typeof context>, cookie?: string): Promise<Response> {
  const url = new URL(path, "https://pupu.example");
  const response = await handleAuth(new Request(url, { headers: cookie ? { cookie } : {} }), url, ctx);
  assert.ok(response, `${path} 应该被登录接口接住`);
  return response;
}

async function postInvite(code: string, ctx: ReturnType<typeof context>, cookie?: string): Promise<Response> {
  const url = new URL("/api/auth/invite", "https://pupu.example");
  const body = new URLSearchParams({ code });
  const headers = { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) };
  const response = await handleAuth(new Request(url, { method: "POST", body, headers }), url, ctx);
  assert.ok(response, "邀请码应该被登录接口接住");
  return response;
}

/** 走到 Google 回调，账号是 `new@example.com`。 */
async function signInNewAccount(start: string, backend: AuthBackend) {
  let nonce = "";
  const ctx = context(backend, fakeGoogle(() => sign(claims({ nonce, email: "new@example.com" }))).fetcher);
  const started = await get(start, ctx);
  const location = new URL(started.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  nonce = location.searchParams.get("nonce") ?? "";
  const done = await get(`/api/auth/google/callback?state=${state}&code=abc`, ctx, `pupu_sign_in=${state}`);
  return { ctx, done };
}

describe("邀请码这一步", () => {
  test("浏览器：没有 Pupu 的账号先到填码页，填错留在这页，填对种 cookie 回首页", async () => {
    const { backend } = fakeBackend();
    const { ctx, done } = await signInNewAccount("/api/auth/google/start?client=browser", backend);
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), "/api/auth/invite");
    const cookies = done.headers.getSetCookie();
    assert.ok(cookies.some((value) => /^pupu_invite=held-token;.*Path=\/api\/auth; HttpOnly; Secure; SameSite=Lax/.test(value)));
    assert.ok(!cookies.some((value) => value.startsWith("pupu_token=")));

    const cookie = "pupu_invite=held-token";
    const form = await get("/api/auth/invite", ctx, cookie);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /<form method="post" action="\/api\/auth\/invite">/);

    const wrong = await postInvite("NOPE", ctx, cookie);
    assert.equal(wrong.status, 400);
    assert.match(await wrong.text(), /&#60;邀请码不对&#62;/);

    const right = await postInvite("GOOD-CODE", ctx, cookie);
    assert.equal(right.headers.get("location"), "/");
    const set = right.headers.getSetCookie();
    assert.ok(set.includes("pupu_token=pbd_new"));
    assert.ok(set.some((value) => value.startsWith("pupu_invite=;")));
  });

  test("手机：填对后跳回 pupu://auth，手机 App 不用改", async () => {
    const { backend } = fakeBackend();
    const challenge = await pkceChallenge(randomToken());
    const { ctx } = await signInNewAccount(`/api/auth/google/start?client=phone&challenge=${challenge}`, backend);
    const right = await postInvite("GOOD-CODE", ctx, "pupu_invite=held-token");
    assert.equal(right.headers.get("location"), "pupu://auth?code=new-code");
  });

  test("没有这次登录的 cookie，别的网站发来的表单不算", async () => {
    const { backend } = fakeBackend();
    const { ctx } = await signInNewAccount("/api/auth/google/start?client=browser", backend);
    const forged = await postInvite("GOOD-CODE", ctx);
    assert.equal(forged.status, 410);
    assert.equal(forged.headers.get("location"), null);
  });

  test("这次登录作废了，清掉 cookie，让人重新登录", async () => {
    const { backend } = fakeBackend();
    const ctx = context(backend, fakeGoogle(() => sign(claims())).fetcher);
    const gone = await postInvite("GOOD-CODE", ctx, "pupu_invite=old");
    assert.equal(gone.status, 410);
    assert.ok(gone.headers.getSetCookie().some((value) => value.startsWith("pupu_invite=;")));
  });
});

describe("登录接口", () => {
  test("浏览器：跳到 Google，带 PKCE、state、nonce，state 放进 cookie；回来后种设备 cookie", async () => {
    const { backend, flows, calls } = fakeBackend();
    let nonce = "";
    const google = fakeGoogle(() => sign(claims({ nonce })));
    const ctx = context(backend, google.fetcher);

    const started = await get("/api/auth/google/start?client=browser", ctx);
    assert.equal(started.status, 302);
    const location = new URL(started.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, "https://fake.example/auth");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.equal(location.searchParams.get("redirect_uri"), "https://pupu.example/api/auth/google/callback");
    assert.equal(location.searchParams.get("login_hint"), null, "不能把名单上的邮箱放进地址");
    const state = location.searchParams.get("state") ?? "";
    nonce = location.searchParams.get("nonce") ?? "";
    assert.match(started.headers.get("set-cookie") ?? "", new RegExp(`pupu_sign_in=${state};.*Path=/api/auth; HttpOnly; Secure; SameSite=Lax`));
    const verifier = flows.get(state)?.verifier ?? "";
    assert.equal(location.searchParams.get("code_challenge"), await pkceChallenge(verifier));

    const done = await get(`/api/auth/google/callback?state=${state}&code=abc`, ctx, `pupu_sign_in=${state}`);
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), "/");
    const cookies = done.headers.getSetCookie();
    assert.ok(cookies.includes("pupu_token=pbd_browser"));
    assert.ok(cookies.some((value) => value.startsWith("pupu_sign_in=;")));
    assert.equal(google.seen[0]?.get("code_verifier"), verifier);
    assert.equal(google.seen[0]?.get("code"), "abc");
    assert.deepEqual(calls.finished, [{ email: "owner@example.com", name: "Safari · Mac" }]);
  });

  test("手机：码送回 pupu://auth", async () => {
    const { backend } = fakeBackend();
    let nonce = "";
    const ctx = context(backend, fakeGoogle(() => sign(claims({ nonce }))).fetcher);
    const challenge = await pkceChallenge(randomToken());
    const started = await get(`/api/auth/google/start?client=phone&challenge=${challenge}`, ctx);
    const location = new URL(started.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    nonce = location.searchParams.get("nonce") ?? "";
    const done = await get(`/api/auth/google/callback?state=${state}&code=abc`, ctx, `pupu_sign_in=${state}`);
    assert.equal(done.headers.get("location"), "pupu://auth?code=one-time");
  });

  test("不是从这个浏览器开始的登录不认，也不往回调地址送东西", async () => {
    const { backend, calls } = fakeBackend();
    const ctx = context(backend, fakeGoogle(() => sign(claims())).fetcher);
    const started = await get(`/api/auth/google/start?client=desktop&port=50000&challenge=${await pkceChallenge(randomToken())}`, ctx);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const done = await get(`/api/auth/google/callback?state=${state}&code=abc`, ctx, "pupu_sign_in=other");
    assert.equal(done.status, 400);
    assert.equal(done.headers.get("location"), null);
    assert.deepEqual(calls.finished, []);
    // state 已经用掉了，拿对的 cookie 再来也不行。
    const again = await get(`/api/auth/google/callback?state=${state}&code=abc`, ctx, `pupu_sign_in=${state}`);
    assert.equal(again.status, 400);
  });

  test("不在名单上的账号：把原因送回 App，不发凭据", async () => {
    const { backend, calls } = fakeBackend();
    let nonce = "";
    const ctx = context(backend, fakeGoogle(() => sign(claims({ nonce, email: "other@example.com" }))).fetcher);
    const started = await get(`/api/auth/google/start?client=desktop&port=50000&challenge=${await pkceChallenge(randomToken())}`, ctx);
    const location = new URL(started.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    nonce = location.searchParams.get("nonce") ?? "";
    const done = await get(`/api/auth/google/callback?state=${state}&code=abc`, ctx, `pupu_sign_in=${state}`);
    const back = new URL(done.headers.get("location") ?? "");
    assert.equal(back.origin + back.pathname, "http://127.0.0.1:50000/pupu-auth");
    assert.match(back.searchParams.get("error") ?? "", /成员名单/);
    assert.equal(back.searchParams.get("code"), null);
    assert.deepEqual(calls.finished, [{ email: "other@example.com", name: "Safari · Mac" }]);
  });

  test("在 Google 那边点了取消", async () => {
    const { backend } = fakeBackend();
    const ctx = context(backend, fakeGoogle(() => sign(claims())).fetcher);
    const started = await get("/api/auth/google/start?client=browser", ctx);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const done = await get(`/api/auth/google/callback?state=${state}&error=access_denied`, ctx, `pupu_sign_in=${state}`);
    const back = new URL(done.headers.get("location") ?? "", "https://pupu.example");
    assert.equal(back.pathname, "/");
    assert.equal(back.searchParams.get("sign_in_error"), "你取消了 Google 登录。");
  });

  test("App 没给 challenge、电脑 App 的端口不对，不开始登录", async () => {
    const { backend, flows } = fakeBackend();
    const ctx = context(backend, fakeGoogle(() => sign(claims())).fetcher);
    assert.equal((await get("/api/auth/google/start?client=phone", ctx)).status, 400);
    assert.equal((await get(`/api/auth/google/start?client=desktop&port=80&challenge=${await pkceChallenge("x")}`, ctx)).status, 400);
    assert.equal(flows.size, 0);
  });

  test("没开 Google 登录：enabled 是 false，start 回 404", async () => {
    const { backend } = fakeBackend();
    assert.deepEqual(await (await get("/api/auth/google", context(backend, fetch))).json(), { enabled: true });
    const ctx = { ...context(backend, fetch), google: null };
    assert.deepEqual(await (await get("/api/auth/google", ctx)).json(), { enabled: false });
    assert.equal((await get("/api/auth/google/start?client=browser", ctx)).status, 404);
  });

  test("redeem：Worker 只把码的哈希和 verifier 的 S256 交给 Pupu；等批时回 202", async () => {
    const { backend, calls } = fakeBackend();
    const ctx = context(backend, fetch);
    const verifier = randomToken();
    const url = new URL("/api/auth/redeem", "https://pupu.example");
    const response = await handleAuth(
      new Request(url, { method: "POST", body: JSON.stringify({ code: "one-time", verifier, name: "iPhone" }) }),
      url,
      ctx
    );
    assert.equal(response?.status, 202);
    const input = calls.redeemed[0] as { codeHash: string; challenge: string; computer: boolean };
    assert.notEqual(input.codeHash, "one-time");
    assert.equal(input.challenge, await pkceChallenge(verifier));
    assert.equal(input.computer, true);
  });
});
