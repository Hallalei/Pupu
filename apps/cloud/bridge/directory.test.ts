import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { DirectoryStore, pupuOfCredential, ROOT_PUPU, scopedCredential, seatsFrom } from "../src/directory.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_800_000_000_000;

describe("凭据前缀", () => {
  test("第一个 Pupu 的老凭据没有前缀，也认得回来", () => {
    assert.equal(scopedCredential(ROOT_PUPU, "pbd_abc"), "pbd_abc");
    assert.equal(pupuOfCredential("pbd_abc"), ROOT_PUPU);
  });

  test("别的 Pupu 的凭据带着自己的 id", () => {
    const token = scopedCredential("a1b2", "pbd_abc");
    assert.equal(pupuOfCredential(token), "a1b2");
  });
});

describe("名额", () => {
  test("没配或者乱填都是不开放", () => {
    assert.equal(seatsFrom({}), 0);
    assert.equal(seatsFrom({ PUPU_SEATS: "abc" }), 0);
    assert.equal(seatsFrom({ PUPU_SEATS: "-1" }), 0);
    assert.equal(seatsFrom({ PUPU_SEATS: "20" }), 20);
  });

  test("新账号各开各的，满了就不再开", () => {
    const store = new DirectoryStore(sqlStorage());
    const first = store.claim("a@example.com", 2, NOW);
    const second = store.claim("b@example.com", 2, NOW);
    assert.equal(first?.founder, true);
    assert.notEqual(first?.pupu, second?.pupu);
    assert.equal(store.claim("c@example.com", 2, NOW), null);
  });

  test("同一个账号再登录回到自己的 Pupu，不多占名额", () => {
    const store = new DirectoryStore(sqlStorage());
    const first = store.claim("A@Example.com", 1, NOW);
    assert.deepEqual(store.claim("a@example.com", 1, NOW), first);
    assert.equal(store.seatsTaken(), 1);
  });

  test("邀请的人也占名额，满了邀请不进来", () => {
    const store = new DirectoryStore(sqlStorage());
    const home = store.claim("a@example.com", 2, NOW);
    assert.equal(store.assign("b@example.com", home?.pupu ?? "", 2, NOW), "ok");
    assert.equal(store.assign("c@example.com", home?.pupu ?? "", 2, NOW), "full");
  });

  test("第一个 Pupu 的成员不占名额", () => {
    const store = new DirectoryStore(sqlStorage());
    assert.equal(store.assign("a@example.com", ROOT_PUPU, 0, NOW), "ok");
    assert.equal(store.seatsTaken(), 0);
  });

  test("移除成员空出名额，创建者不会被移走", () => {
    const store = new DirectoryStore(sqlStorage());
    const home = store.claim("a@example.com", 2, NOW);
    const pupu = home?.pupu ?? "";
    store.assign("b@example.com", pupu, 2, NOW);
    store.release("b@example.com", pupu);
    store.release("a@example.com", pupu);
    assert.equal(store.seatsTaken(), 1);
    assert.equal(store.home("b@example.com"), null);
  });
});

describe("邀请", () => {
  test("已经有自己 Pupu 的账号不搬家", () => {
    const store = new DirectoryStore(sqlStorage());
    const mine = store.claim("a@example.com", 5, NOW);
    store.claim("b@example.com", 5, NOW);
    assert.equal(store.assign("b@example.com", mine?.pupu ?? "", 5, NOW), "taken");
  });

  test("被邀请的人登录时进邀请他的 Pupu，不算创建者", () => {
    const store = new DirectoryStore(sqlStorage());
    const mine = store.claim("a@example.com", 5, NOW);
    store.assign("b@example.com", mine?.pupu ?? "", 5, NOW);
    assert.deepEqual(store.claim("b@example.com", 5, NOW), { pupu: mine?.pupu, founder: false });
  });
});

describe("目录认识的 Pupu 和配对码", () => {
  test("没开过的 id 不认", () => {
    const store = new DirectoryStore(sqlStorage());
    const home = store.claim("a@example.com", 1, NOW);
    assert.equal(store.knows(home?.pupu ?? ""), true);
    assert.equal(store.knows("made-up"), false);
  });

  test("配对码过期就查不到了", () => {
    const store = new DirectoryStore(sqlStorage());
    store.rememberCode("hash", "a1b2", NOW + 1000, NOW);
    assert.equal(store.pupuOfCode("hash", NOW), "a1b2");
    assert.equal(store.pupuOfCode("hash", NOW + 1000), null);
  });
});
