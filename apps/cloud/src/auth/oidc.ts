/**
 * 用 Google 账号登录，走标准的 OpenID Connect。
 *
 * Worker 是 OAuth 的客户端（有 client secret），走授权码流程，带 PKCE、state 和 nonce。
 * 拿回来的 ID token 用 Google 的 JWKS 验签，再查 iss、aud、exp、nonce 和 email_verified，
 * 验过的邮箱交给 Pupu 那边看在不在成员名单上（见 members.ts）。
 *
 * 校验的步骤对照了 panva/oauth4webapi（`validateJwt`、`validateIdTokenNonce`、
 * `validateIdTokenAuthorizedParty`，时钟容差同样是 30 秒）；Google 的参数和 state 放 cookie 的写法
 * 对照了 pilcrowonpaper/arctic 的示例。代码是自己写的，没搬。
 */

import { cleanName } from "../members.ts";

/** Google 的几个地址。本机开发时换成假的，见 `devProvider`。 */
export type OidcProvider = {
  /** ID token 里 iss 认这几个。 */
  readonly issuers: readonly string[];
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly scope: string;
  /** 授权地址上另加的参数。 */
  readonly params?: Readonly<Record<string, string>>;
};

export const GOOGLE: OidcProvider = {
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
  scope: "openid email profile",
  // 登着好几个 Google 账号时让人挑一个，不默默用当前那个。
  params: { prompt: "select_account" }
};

export type OidcClient = {
  readonly provider: OidcProvider;
  readonly clientId: string;
  readonly clientSecret: string;
};

export type OidcEnv = {
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  readonly GOOGLE_OIDC_DEV_BASE?: string;
};

/**
 * 本机开发时用一个假的 Google 走通整个流程（授权、换 token、JWKS 都在 `base` 下面），
 * 不用真去 Google 建客户端。只在本机请求上认，线上就算设了也不用。
 */
export function devProvider(base: string): OidcProvider {
  const root = base.replace(/\/+$/, "");
  return {
    ...GOOGLE,
    issuers: [root],
    authorizationEndpoint: `${root}/auth`,
    tokenEndpoint: `${root}/token`,
    jwksUri: `${root}/certs`
  };
}

/** 客户端 ID 和密钥都设了才开 Google 登录。`local` 是本机开发的请求。 */
export function googleClientFrom(env: OidcEnv, local: boolean): OidcClient | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const dev = local ? env.GOOGLE_OIDC_DEV_BASE?.trim() : undefined;
  return { provider: dev ? devProvider(dev) : GOOGLE, clientId, clientSecret };
}

// ---- 编码 ----

export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("不是 base64url");
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** 32 字节随机数，base64url，43 个字符。state、nonce、PKCE 的 verifier 都用它。 */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** PKCE 的 S256：verifier 的 SHA-256，base64url。 */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** S256 的 challenge 正好 43 个 base64url 字符。 */
export function isChallenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

// ---- 授权和换 token ----

export function authorizationUrl(
  client: OidcClient,
  input: { redirectUri: string; state: string; nonce: string; verifierChallenge: string }
): string {
  const url = new URL(client.provider.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", client.provider.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.verifierChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // 不带 login_hint：这个地址谁都能拿到，不能把名单上的邮箱放进去。
  for (const [key, value] of Object.entries(client.provider.params ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

/** 登录没成，给人看的原因。 */
export class SignInError extends Error {}

const TOKEN_TIMEOUT_MS = 10_000;

/** 授权码换 ID token。 */
export async function exchangeCode(
  client: OidcClient,
  input: { code: string; redirectUri: string; verifier: string },
  fetcher: typeof fetch = fetch
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    client_id: client.clientId,
    client_secret: client.clientSecret
  });
  let response: Response;
  try {
    response = await fetcher(client.provider.tokenEndpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    });
  } catch {
    throw new SignInError("连不上 Google，再试一次。");
  }
  const value = (await response.json().catch(() => null)) as { id_token?: unknown; error?: unknown } | null;
  if (!response.ok || typeof value?.id_token !== "string") {
    // 只记错误码，不记响应体：里面可能有 token。
    console.warn(`Google 换 token 失败：${response.status} ${String(value?.error ?? "")}`);
    throw new SignInError("Google 没认这次登录，再试一次。");
  }
  return value.id_token;
}

// ---- JWKS ----

type Jwk = { kty?: string; kid?: string; n?: string; e?: string; alg?: string; use?: string };

/** Google 的公钥，按 kid 找。 */
export interface KeySource {
  key(kid: string): Promise<CryptoKey | undefined>;
}

/** 没给 Cache-Control 时公钥留这么久。 */
const JWKS_DEFAULT_MS = 60 * 60_000;
/** 碰到不认识的 kid 时重新拉一次，但两次之间至少隔这么久，免得被人拿假 token 刷。 */
const JWKS_REFETCH_MS = 60_000;

/**
 * 拉 JWKS 并按 Cache-Control 的 max-age 缓存。同一个 isolate 里的请求共用，DO 和 Worker 各一份。
 * Google 会轮换公钥：缓存里没有这个 kid 时，隔一分钟以上就重新拉一次。
 */
export class Jwks implements KeySource {
  readonly #uri: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #keys = new Map<string, CryptoKey>();
  #expiresAt = 0;
  #fetchedAt = 0;

  constructor(uri: string, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#uri = uri;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? (() => Date.now());
  }

  async key(kid: string): Promise<CryptoKey | undefined> {
    const now = this.#now();
    const stale = now >= this.#expiresAt;
    if (stale || (!this.#keys.has(kid) && now - this.#fetchedAt >= JWKS_REFETCH_MS)) {
      await this.#load(now);
    }
    return this.#keys.get(kid);
  }

  async #load(now: number): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(this.#uri, { signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    } catch {
      throw new SignInError("拿不到登录服务的公钥，再试一次。");
    }
    if (!response.ok) throw new SignInError("拿不到登录服务的公钥，再试一次。");
    const body = (await response.json().catch(() => null)) as { keys?: Jwk[] } | null;
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body?.keys ?? []) {
      if (jwk.kty !== "RSA" || !jwk.kid || !jwk.n || !jwk.e) continue;
      if (jwk.use !== undefined && jwk.use !== "sig") continue;
      if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"]
        )
      );
    }
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1]);
    this.#keys = keys;
    this.#fetchedAt = now;
    this.#expiresAt = now + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge * 1000 : JWKS_DEFAULT_MS);
  }
}

// ---- ID token ----

/** 签发时间、过期时间允许和本机差这么多秒。 */
export const CLOCK_TOLERANCE_S = 30;

export type Identity = {
  readonly subject: string;
  /** 小写。 */
  readonly email: string;
  /** Google 账号的名字，聊天里显示。ID token 里没有是 null。 */
  readonly name: string | null;
};

type Claims = Record<string, unknown>;

function decodeJson(part: string): Claims {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  } catch {
    throw new SignInError("登录服务给的凭证坏了。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SignInError("登录服务给的凭证坏了。");
  return value as Claims;
}

/**
 * 验 ID token，返回是谁。哪一条不对都抛 `SignInError`。
 * 不在这里比成员名单，那是 Pupu 的事（server.ts 的 `finishSignIn`）。
 */
export async function verifyIdToken(
  token: string,
  input: { client: OidcClient; nonce: string; keys: KeySource; now: number }
): Promise<Identity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new SignInError("登录服务给的凭证坏了。");
  const [encodedHeader = "", encodedClaims = "", encodedSignature = ""] = parts;
  const header = decodeJson(encodedHeader);
  if (header.alg !== "RS256") throw new SignInError("登录凭证的签名算法不对。");
  if (header.crit !== undefined) throw new SignInError("登录凭证带了不认识的扩展。");
  if (typeof header.kid !== "string") throw new SignInError("登录凭证没说用哪把公钥签的。");

  const key = await input.keys.key(header.kid);
  if (!key) throw new SignInError("登录凭证的公钥对不上。");
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromBase64url(encodedSignature);
  } catch {
    throw new SignInError("登录凭证的签名不对。");
  }
  const signed = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`)
  );
  if (!signed) throw new SignInError("登录凭证的签名不对。");

  const claims = decodeJson(encodedClaims);
  const { client } = input;
  const now = Math.floor(input.now / 1000);
  if (typeof claims.iss !== "string" || !client.provider.issuers.includes(claims.iss)) {
    throw new SignInError("登录凭证不是这家签的。");
  }
  const aud = claims.aud;
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(client.clientId)) throw new SignInError("登录凭证不是给 Pupu 的。");
  // 给了好几个 aud 时，azp 要是 Pupu 自己。
  if (audiences.length > 1 && claims.azp !== client.clientId) throw new SignInError("登录凭证不是给 Pupu 的。");
  if (typeof claims.exp !== "number" || claims.exp <= now - CLOCK_TOLERANCE_S) {
    throw new SignInError("登录凭证过期了，再登录一次。");
  }
  if (typeof claims.iat !== "number" || claims.iat > now + CLOCK_TOLERANCE_S) {
    throw new SignInError("登录凭证的签发时间不对。");
  }
  if (claims.nonce !== input.nonce) throw new SignInError("登录凭证和这次登录对不上，再试一次。");
  if (typeof claims.sub !== "string" || !claims.sub) throw new SignInError("登录凭证没说是谁。");
  if (typeof claims.email !== "string" || !claims.email) {
    throw new SignInError("Google 没给邮箱。");
  }
  // Google 以前在一些 token 里把它写成字符串。
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new SignInError("这个账号的邮箱还没验证过。");
  }
  return { subject: claims.sub, email: claims.email.toLowerCase(), name: cleanName(claims.name) };
}
