// 本机测「用 Google 登录」用的假 Google，不用真去 Google Cloud 建客户端：
// /auth 显示选账号的页面，/token 验 PKCE 后签一个 RS256 的 ID token，/certs 给公钥。
// 用法见 README 的「本地测 Google 登录」。只听 127.0.0.1，钥匙每次启动现生成。
import { createServer } from "node:http";
import { createHash, generateKeyPairSync, createSign, randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 9999);
const ISSUER = `http://localhost:${PORT}`;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fake-1", use: "sig", alg: "RS256" };
const codes = new Map();
/** 账号的名字。只有请求了 profile 才写进 ID token，和真的 Google 一样。 */
const NAMES = { "owner@example.com": "林夏", "family@example.com": "阿周" };

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (claims) => {
  const head = b64u(JSON.stringify({ alg: "RS256", kid: "fake-1", typ: "JWT" }));
  const body = b64u(JSON.stringify(claims));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64u(signer.sign(privateKey))}`;
};

createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  console.log(new Date().toISOString(), req.method, url.pathname, url.searchParams.get("email") ?? "");
  if (url.pathname === "/certs") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=300" });
    return res.end(JSON.stringify({ keys: [jwk] }));
  }
  if (url.pathname === "/auth") {
    const p = url.searchParams;
    const email = p.get("email");
    if (p.get("cancel")) {
      const back = new URL(p.get("redirect_uri"));
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("state", p.get("state"));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (!email) {
      const link = (extra) => `/auth?${new URLSearchParams({ ...Object.fromEntries(p), ...extra })}`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta name=viewport content="width=device-width"><title>假 Google</title>
<body style="font:18px -apple-system;padding:24px"><h2>假 Google：选一个账号</h2>
<p><a id=owner href="${link({ email: "owner@example.com" })}">owner@example.com（成员）</a></p>
<p><a id=family href="${link({ email: "family@example.com" })}">family@example.com（成员）</a></p>
<p><a id=stranger href="${link({ email: "stranger@example.com" })}">stranger@example.com</a></p>
<p><a id=cancel href="${link({ cancel: "1" })}">取消</a></p></body>`);
    }
    const code = b64u(randomBytes(16));
    codes.set(code, { nonce: p.get("nonce"), challenge: p.get("code_challenge"), clientId: p.get("client_id"), redirectUri: p.get("redirect_uri"), email, profile: (p.get("scope") ?? "").split(" ").includes("profile") });
    const back = new URL(p.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", p.get("state"));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const grant = codes.get(form.get("code"));
    codes.delete(form.get("code"));
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (!grant || grant.challenge !== challenge || grant.clientId !== form.get("client_id") || grant.redirectUri !== form.get("redirect_uri") || !form.get("client_secret")) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_grant" }));
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = sign({ iss: ISSUER, aud: grant.clientId, sub: `sub-${grant.email}`, email: grant.email, ...(grant.profile && NAMES[grant.email] ? { name: NAMES[grant.email] } : {}), email_verified: true, nonce: grant.nonce, iat: now, exp: now + 3600 });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id_token: idToken, access_token: "fake", token_type: "Bearer", expires_in: 3600 }));
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, "127.0.0.1", () => console.log(`fake google on ${ISSUER}`));
