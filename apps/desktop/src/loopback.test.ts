import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CALLBACK_PATH, challengeOf, newVerifier, parseCallback, receiveCode, SignInCancelled } from "./loopback.ts";

test("verifier 是 43 个 base64url 字符，challenge 是它的 SHA-256", () => {
  const verifier = newVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newVerifier(), verifier);
  assert.equal(challengeOf(verifier), createHash("sha256").update(verifier).digest("base64url"));
  // RFC 7636 附录 B 的例子。
  assert.equal(
    challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  );
});

test("回调地址：有 error 先认 error，没有 code 不算", () => {
  const at = (query: string) => new URL(`http://127.0.0.1:5000${CALLBACK_PATH}${query}`);
  assert.deepEqual(parseCallback(at("?code=abc")), { code: "abc" });
  assert.deepEqual(parseCallback(at("?code=abc&error=no")), { error: "no" });
  assert.equal(parseCallback(at("")), null);
  assert.equal(parseCallback(at("?code=")), null);
});

test("浏览器带回 code：只认回调路径，拿到一次就关端口", async () => {
  let port = 0;
  const code = await receiveCode(async (opened) => {
    port = opened;
    assert.equal((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}`)).status, 404);
    const page = await fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}?code=one-time`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /登录好了/);
  });
  assert.equal(code, "one-time");
  await assert.rejects(fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}?code=again`));
});

test("浏览器带回 error：页面上和 App 里都是这句", async () => {
  await assert.rejects(
    receiveCode(async (port) => {
      const page = await fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}?error=${encodeURIComponent("<你取消了>")}`);
      assert.match(await page.text(), /&#60;你取消了&#62;/);
    }),
    (error: unknown) => error instanceof SignInCancelled && error.message === "<你取消了>"
  );
});

test("超时和取消", async () => {
  await assert.rejects(receiveCode(async () => {}, { timeoutMs: 20 }), SignInCancelled);
  const controller = new AbortController();
  await assert.rejects(
    receiveCode(async () => controller.abort(), { signal: controller.signal }),
    (error: unknown) => error instanceof SignInCancelled && error.message === "已取消。"
  );
  controller.abort();
  await assert.rejects(receiveCode(async () => {}, { signal: controller.signal }), SignInCancelled);
});

test("浏览器打不开：原样抛出", async () => {
  await assert.rejects(
    receiveCode(async () => {
      throw new Error("没有浏览器");
    }),
    /没有浏览器/
  );
});
