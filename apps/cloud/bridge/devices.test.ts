import assert from "node:assert/strict";
import test from "node:test";
import { mayDecide, mayPair } from "../src/devices.ts";

test("允许只认手机", () => {
  assert.equal(mayDecide("allow", "phone"), true);
  assert.equal(mayDecide("allow", "desktop"), false);
  assert.equal(mayDecide("allow", "browser"), false);
});

test("拒绝哪台设备都能点", () => {
  assert.equal(mayDecide("deny", "phone"), true);
  assert.equal(mayDecide("deny", "desktop"), true);
  assert.equal(mayDecide("deny", "browser"), true);
});

test("本机开发不带设备照常放行，查不到的设备不放行", () => {
  assert.equal(mayDecide("allow", null), true);
  assert.equal(mayDecide("allow", undefined), false);
  assert.equal(mayDecide("deny", undefined), true);
});

test("配过手机以后，新手机只认手机生成的配对码", () => {
  assert.equal(mayPair("phone", true, true), true);
  assert.equal(mayPair("phone", false, true), false);
});

test("第一台手机哪儿生成的码都行", () => {
  assert.equal(mayPair("phone", false, false), true);
});

test("浏览器、电脑 App 和电脑不管码是谁生成的", () => {
  for (const kind of ["browser", "desktop", "computer"] as const) {
    assert.equal(mayPair(kind, false, true), true);
  }
});
