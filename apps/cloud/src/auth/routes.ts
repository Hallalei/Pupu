import { tokenHash } from "../bridge/protocol.ts";
import {
  authorizationUrl,
  exchangeCode,
  isChallenge,
  Jwks,
  pkceChallenge,
  randomToken,
  SignInError,
  verifyIdToken,
  type KeySource,
  type OidcClient
} from "./oidc.ts";
import { FLOW_TTL_MS, isSignInClient, redirectFor, type SignInFlow } from "./sign-ins.ts";

/**
 * Worker 上登录的几个接口，都不要设备凭据：
 * - GET  /api/auth/google：开没开 Google 登录，登录页看它决定显不显示按钮；
 * - GET  /api/auth/google/start?client=…：记下这次登录，跳到 Google；
 * - GET  /api/auth/google/callback：Google 跳回来，换 token、验身份，浏览器种 cookie，App 拿一次性的码；
 * - GET、POST /api/auth/invite：还没有 Pupu 的账号填邀请码，填对了接着走回调后半段；
 * - POST /api/auth/redeem：手机和电脑 App 拿码和自己的 verifier 换凭据。
 *
 * 状态都在 Pupu 这个 Durable Object 里（`AuthBackend`），这里只管 HTTP 和跟 Google 说话。
 */

export const AUTH_PREFIX = "/api/auth/";
const START_PATH = "/api/auth/google/start";
const CALLBACK_PATH = "/api/auth/google/callback";
const INVITE_PATH = "/api/auth/invite";

/** 这次登录是哪个浏览器开始的。回调时对不上就不认，别人发来的登录链接点了也没用。 */
const FLOW_COOKIE = "pupu_sign_in";
/** 停在邀请码这一步的登录。只放 cookie，别的网站发来的表单带不上。 */
const INVITE_COOKIE = "pupu_invite";
const JOIN_URL = "https://getpupu.com/#join";

export type SignInGrant =
  | { readonly kind: "cookie"; readonly token: string }
  | { readonly kind: "code"; readonly code: string }
  /** 不在成员名单上。`error` 给人看，不说名单里有谁。 */
  | { readonly kind: "refused"; readonly error: string }
  /** 还没有 Pupu，要先填邀请码。`token` 换得回这次登录。 */
  | { readonly kind: "invite"; readonly token: string };

export type InviteResult =
  | { readonly status: "ok"; readonly flow: SignInFlow; readonly grant: SignInGrant }
  /** 还能再填一次。 */
  | { readonly status: "retry"; readonly error: string }
  /** 过期了，或者填错太多次。 */
  | { readonly status: "gone" };

export type SignInCredential = { readonly id: string; readonly name: string; readonly token: string };

export type RedeemResult =
  | {
      readonly status: "ok";
      readonly device: SignInCredential;
      /** 电脑 App 顺带拿桥的凭据；手机、或者沿用了命令行桥的授权，是 null。 */
      readonly computer: SignInCredential | null;
    }
  | { readonly status: "waiting"; readonly expiresAt: number }
  | { readonly status: "refused"; readonly code: 400 | 403 | 410 | 429; readonly error: string };

/** Pupu 那边要给的几个方法，见 server.ts 里同名的 RPC。 */
export type AuthBackend = {
  addSignInFlow(flow: SignInFlow): Promise<void>;
  takeSignInFlow(state: string): Promise<SignInFlow | null>;
  /** `name` 是这台设备的名字，`displayName` 是这个人在 Google 上的名字。 */
  finishSignIn(input: {
    flow: SignInFlow;
    email: string;
    name: string;
    displayName: string | null;
  }): Promise<SignInGrant>;
  activate(token: string, code: string): Promise<InviteResult>;
  /** `code` 的前缀说明这次登录在哪个 Pupu，`codeHash` 才是它要比的。 */
  redeemSignIn(input: {
    code: string;
    codeHash: string;
    challenge: string;
    name: string;
    place: string;
    source: string;
    computer: boolean;
  }): Promise<RedeemResult>;
};

export type AuthContext = {
  readonly backend: AuthBackend;
  /** 没开 Google 登录是 null。 */
  readonly google: OidcClient | null;
  /** 浏览器的名字，比如「Safari · Mac」。 */
  readonly browserName: (userAgent: string | null) => string;
  /** 浏览器凭据的 cookie。 */
  /** 登录成功种下的 cookie。可以是几条：网页登录回来顺手清掉选中的组织，回到这次登录的那个。 */
  readonly deviceCookie: (url: URL, token: string) => string | readonly string[];
  readonly source: (request: Request) => string;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly keys?: KeySource;
};

/** 一个 isolate 里共用一份 Google 公钥。 */
const jwksByUri = new Map<string, Jwks>();

function keysFor(client: OidcClient): KeySource {
  let keys = jwksByUri.get(client.provider.jwksUri);
  if (!keys) {
    keys = new Jwks(client.provider.jwksUri);
    jwksByUri.set(client.provider.jwksUri, keys);
  }
  return keys;
}

/** 不是登录的接口返回 null。 */
export async function handleAuth(request: Request, url: URL, context: AuthContext): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith(AUTH_PREFIX)) return null;
  if (pathname === "/api/auth/google" && request.method === "GET") {
    return Response.json({ enabled: context.google !== null });
  }
  if (pathname === "/api/auth/redeem" && request.method === "POST") return redeem(request, context);
  if (pathname === INVITE_PATH) return invite(request, url, context);
  const step = pathname === START_PATH ? "start" : pathname === CALLBACK_PATH ? "callback" : null;
  if (!step || request.method !== "GET") return null;
  const client = context.google;
  if (!client) return page(404, "这个 Pupu 还没开 Google 登录。");
  return step === "start" ? start(request, url, client, context) : callback(request, url, client, context);
}

function callbackUrl(url: URL): string {
  return new URL(CALLBACK_PATH, url).toString();
}

function authCookie(url: URL, name: string, content: string | null): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const value = content ? `${content}; Max-Age=${FLOW_TTL_MS / 1000}` : "; Max-Age=0";
  return `${name}=${value}; Path=/api/auth; HttpOnly${secure}; SameSite=Lax`;
}

function flowCookie(url: URL, state: string | null): string {
  return authCookie(url, FLOW_COOKIE, state);
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === name && value) return value;
  }
  return null;
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function document(status: number, main: string, cookies: readonly string[]): Response {
  const body = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pupu</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#6f8fb3;color:#14202e}
main{background:rgba(255,255,255,.92);border-radius:24px;padding:24px;max-width:22rem;margin:16px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#4a5868}
form{display:flex;flex-direction:column;gap:12px;margin:16px 0 0}input,button{box-sizing:border-box;width:100%;height:48px;border-radius:24px;border:0;font:inherit}
input{background:rgba(20,32,46,.08);color:inherit;text-align:center;letter-spacing:.08em;text-transform:uppercase}button{background:#14202e;color:#fff;font-weight:600;cursor:pointer}
.error{margin-top:12px;color:#b3261e}.more{margin-top:16px;text-align:center;font-size:14px}a{color:inherit}</style>
</head><body><main>${main}</main></body></html>`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(body, { status, headers });
}

/** 浏览器里看到的错误页。登录在 App 里开始时，回不到 App 就停在这一页。 */
export function page(status: number, message: string, cookies: readonly string[] = []): Response {
  return document(status, `<h1>没连上 Pupu</h1><p>${escapeHtml(message)}</p>`, cookies);
}

function invitePage(status: number, error: string | null): Response {
  const main = `<h1>输入邀请码</h1>
<form method="post" action="${INVITE_PATH}">
<input name="code" aria-label="邀请码" placeholder="ABCD-EFGH" autocomplete="off" autocapitalize="characters" spellcheck="false" required autofocus>
<button>激活</button>
</form>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<p class="more"><a href="${JOIN_URL}">申请内测</a></p>`;
  return document(status, main, []);
}

async function start(request: Request, url: URL, client: OidcClient, context: AuthContext): Promise<Response> {
  const kind = url.searchParams.get("client");
  if (!isSignInClient(kind)) return page(400, "登录链接不对：client 只能是 browser、phone 或 desktop。");
  const to = redirectFor(kind, url.searchParams.get("port"));
  if (to === undefined) return page(400, "登录链接不对：端口要在 1024 到 65535 之间。");
  const challenge = url.searchParams.get("challenge");
  if (kind !== "browser" && !isChallenge(challenge)) return page(400, "登录链接不对：缺少 challenge。");
  const now = context.now?.() ?? Date.now();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  await context.backend.addSignInFlow({
    state,
    verifier,
    nonce,
    client: kind,
    challenge: kind === "browser" ? null : challenge,
    redirect: to,
    createdAt: now,
    expiresAt: now + FLOW_TTL_MS
  });
  const location = authorizationUrl(client, {
    redirectUri: callbackUrl(url),
    state,
    nonce,
    verifierChallenge: await pkceChallenge(verifier)
  });
  return redirect(location, [flowCookie(url, state)]);
}

/** 登录没成，把原因送回发起的地方：浏览器回首页，App 回它的回调地址。 */
function fail(flow: SignInFlow, message: string, cleared: string): Response {
  if (!flow.redirect) return redirect(`/?${new URLSearchParams({ sign_in_error: message })}`, [cleared]);
  const target = new URL(flow.redirect);
  target.searchParams.set("error", message);
  return redirect(target.toString(), [cleared]);
}

async function callback(request: Request, url: URL, client: OidcClient, context: AuthContext): Promise<Response> {
  const cleared = flowCookie(url, null);
  const state = url.searchParams.get("state") ?? "";
  // 先把这个 state 用掉，不管后面成不成：一次登录只能回调一次。
  const flow = state ? await context.backend.takeSignInFlow(state) : null;
  if (!flow) return page(400, "这次登录过期了，或者已经用过了。回到 Pupu 重新点「用 Google 登录」。", [cleared]);
  // 别人从自己那儿开始一次登录，再把 Google 的链接发给你点：你这个浏览器没有这次登录的 cookie，不认，
  // 也不往他留的回调地址送任何东西。
  if (cookieValue(request, FLOW_COOKIE) !== state) {
    return page(400, "这次登录不是从这个浏览器开始的。回到 Pupu 重新点「用 Google 登录」。", [cleared]);
  }

  const error = url.searchParams.get("error");
  if (error) return fail(flow, error === "access_denied" ? "你取消了 Google 登录。" : `Google 没让登录（${error}）。`, cleared);
  const code = url.searchParams.get("code");
  if (!code) return fail(flow, "Google 没给授权码，再试一次。", cleared);

  let email: string;
  let displayName: string | null;
  try {
    const idToken = await exchangeCode(
      client,
      { code, redirectUri: callbackUrl(url), verifier: flow.verifier },
      context.fetch
    );
    const identity = await verifyIdToken(idToken, {
      client,
      nonce: flow.nonce,
      keys: context.keys ?? keysFor(client),
      now: context.now?.() ?? Date.now()
    });
    email = identity.email;
    displayName = identity.name;
  } catch (cause) {
    if (cause instanceof SignInError) return fail(flow, cause.message, cleared);
    throw cause;
  }

  const grant = await context.backend.finishSignIn({
    flow,
    email,
    displayName,
    name: context.browserName(request.headers.get("User-Agent"))
  });
  return granted(flow, grant, url, cleared, context);
}

/** 回调和填完邀请码都走到这里：把登录结果交给发起的地方。 */
function granted(flow: SignInFlow, grant: SignInGrant, url: URL, cleared: string, context: AuthContext): Response {
  if (grant.kind === "refused") return fail(flow, grant.error, cleared);
  if (grant.kind === "invite") return redirect(INVITE_PATH, [cleared, authCookie(url, INVITE_COOKIE, grant.token)]);
  if (grant.kind === "cookie") return redirect("/", [cleared, ...[context.deviceCookie(url, grant.token)].flat()]);
  const target = new URL(flow.redirect ?? "/", url);
  target.searchParams.set("code", grant.code);
  return redirect(target.toString(), [cleared]);
}

async function invite(request: Request, url: URL, context: AuthContext): Promise<Response | null> {
  const expired = "这次登录过期了。回到 Pupu 重新点「用 Google 登录」。";
  const token = cookieValue(request, INVITE_COOKIE);
  if (!token) return page(410, expired);
  if (request.method === "GET") return invitePage(200, null);
  if (request.method !== "POST") return null;
  const code = (await request.formData()).get("code");
  const result = await context.backend.activate(token, typeof code === "string" ? code : "");
  const cleared = authCookie(url, INVITE_COOKIE, null);
  if (result.status === "gone") return page(410, expired, [cleared]);
  if (result.status === "retry") return invitePage(400, result.error);
  return granted(result.flow, result.grant, url, cleared, context);
}

/** 设置里显示的「从哪儿登录」，比如「Shanghai, CN · 203.0.113.5」。 */
export function placeOf(request: Request): string {
  const cf = (request as { cf?: { city?: unknown; country?: unknown } }).cf;
  const where = [cf?.city, cf?.country].filter((value): value is string => typeof value === "string" && value !== "");
  const ip = request.headers.get("CF-Connecting-IP");
  return [where.join(", "), ip].filter(Boolean).join(" · ") || "不知道在哪";
}

async function redeem(request: Request, context: AuthContext): Promise<Response> {
  let body: { code?: unknown; verifier?: unknown; name?: unknown; computer?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "请求体不是合法的 JSON" }, { status: 400 });
  }
  if (typeof body.code !== "string" || !body.code || body.code.length > 200) {
    return Response.json({ error: "缺少登录码" }, { status: 400 });
  }
  // App 的 verifier 是 32 字节随机数的 base64url，和 challenge 一样正好 43 个字符。
  if (typeof body.verifier !== "string" || !isChallenge(body.verifier)) {
    return Response.json({ error: "verifier 不对" }, { status: 400 });
  }
  const result = await context.backend.redeemSignIn({
    code: body.code,
    codeHash: await tokenHash(body.code),
    challenge: await pkceChallenge(body.verifier),
    name: typeof body.name === "string" ? body.name : "",
    place: placeOf(request),
    source: context.source(request),
    computer: body.computer !== false
  });
  if (result.status === "refused") return Response.json({ error: result.error }, { status: result.code });
  if (result.status === "waiting") return Response.json(result, { status: 202 });
  return Response.json(result);
}
