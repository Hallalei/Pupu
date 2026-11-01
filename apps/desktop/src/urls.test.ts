import assert from "node:assert/strict";
import { test } from "node:test";
import { canOpenExternally, computerName, isLocalOrigin, originOf, sameOrigin } from "./urls.ts";

test("地址只留 origin，只认 http 和 https", () => {
  assert.equal(originOf("https://pupu.example.com/a?b=1#c"), "https://pupu.example.com");
  assert.equal(originOf("http://localhost:5173/"), "http://localhost:5173");
  assert.throws(() => originOf("file:///etc/passwd"));
});

test("同源判断：端口、协议不同都不算", () => {
  assert.equal(sameOrigin("https://pupu.example.com/#/projects", "https://pupu.example.com"), true);
  assert.equal(sameOrigin("https://pupu.example.com.evil.com/", "https://pupu.example.com"), false);
  assert.equal(sameOrigin("http://pupu.example.com/", "https://pupu.example.com"), false);
  assert.equal(sameOrigin("not a url", "https://pupu.example.com"), false);
});

test("本机开发服务器", () => {
  assert.equal(isLocalOrigin("http://localhost:5173"), true);
  assert.equal(isLocalOrigin("http://127.0.0.1:8787"), true);
  assert.equal(isLocalOrigin("https://pupu.example.com"), false);
});

test("外链只把网页和邮件交给系统", () => {
  assert.equal(canOpenExternally("https://example.com"), true);
  assert.equal(canOpenExternally("mailto:a@example.com"), true);
  assert.equal(canOpenExternally("file:///Applications/Calculator.app"), false);
  assert.equal(canOpenExternally("x-apple.systempreferences:com.apple.preference.security"), false);
  assert.equal(canOpenExternally("javascript:alert(1)"), false);
});

test("电脑名去掉 .local", () => {
  assert.equal(computerName("mbpro.local"), "mbpro");
  assert.equal(computerName("Rancho-mbp"), "Rancho-mbp");
  assert.equal(computerName(""), "电脑");
});
