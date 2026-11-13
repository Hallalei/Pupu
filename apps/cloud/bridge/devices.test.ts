import assert from "node:assert/strict";
import test from "node:test";
import { mayChangePolicy, mayDecide, mayPair, type DeviceKind } from "../src/devices.ts";
import type { Actor } from "../src/members.ts";

/** 主人 me 的设备、别人 other 的设备。 */
const mine = (kind: DeviceKind): Actor => ({ kind, memberId: "me", role: "member" });
const others = (kind: DeviceKind): Actor => ({ kind, memberId: "other", role: "creator" });

test("允许只认这台电脑主人的手机", () => {
  assert.equal(mayDecide("allow", mine("phone"), "me"), true);
  assert.equal(mayDecide("allow", mine("desktop"), "me"), false);
  assert.equal(mayDecide("allow", mine("browser"), "me"), false);
  assert.equal(mayDecide("allow", others("phone"), "me"), false, "创建者的手机也批不了别人的电脑");
});

test("还没主人的电脑、新手机登录的等批，谁的手机都能批", () => {
  assert.equal(mayDecide("allow", others("phone"), null), true);
  assert.equal(mayDecide("allow", others("browser"), null), false);
});

test("拒绝哪台设备都能点", () => {
  for (const kind of ["phone", "desktop", "browser"] as const) {
    assert.equal(mayDecide("deny", mine(kind), "me"), true);
    assert.equal(mayDecide("deny", others(kind), "me"), true);
  }
});

test("本机开发不带设备照常放行，查不到的设备不放行", () => {
  assert.equal(mayDecide("allow", null, "me"), true);
  assert.equal(mayDecide("allow", undefined, "me"), false);
  assert.equal(mayDecide("deny", undefined, "me"), true);
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

test("权限分级往宽里改：主人在哪个端都行，不用再确认；别人不行", () => {
  assert.equal(mayChangePolicy("ask_risky", "trust", mine("phone"), "me"), true);
  assert.equal(mayChangePolicy("ask_risky", "trust", mine("desktop"), "me"), true);
  assert.equal(mayChangePolicy("ask_all", "ask_risky", mine("browser"), "me"), true);
  assert.equal(mayChangePolicy("ask_risky", "trust", others("phone"), "me"), false, "创建者也不行");
  assert.equal(mayChangePolicy("ask_all", "trust", undefined, "me"), false);
  assert.equal(mayChangePolicy("ask_risky", "trust", others("phone"), null), true, "还没主人的老电脑");
});

test("权限分级往严里改、不变，哪儿都行", () => {
  for (const actor of [mine("phone"), others("browser"), others("desktop"), undefined]) {
    assert.equal(mayChangePolicy("trust", "ask_risky", actor, "me"), true);
    assert.equal(mayChangePolicy("ask_risky", "ask_all", actor, "me"), true);
    assert.equal(mayChangePolicy("trust", "trust", actor, "me"), true);
  }
});

test("本机开发不带设备，改哪个方向都行", () => {
  assert.equal(mayChangePolicy("ask_all", "trust", null, "me"), true);
});
