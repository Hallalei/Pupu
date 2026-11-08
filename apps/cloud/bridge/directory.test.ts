import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  DirectoryStore,
  INVITE_ATTEMPTS,
  pupuOfCredential,
  ROOT_PUPU,
  scopedCredential,
  seatsFrom,
  type HeldSignIn
} from "../src/directory.ts";
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
    assert.equal(store.invites(1).left, 0);
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
    assert.equal(store.invites(1).left, 1);
  });

  test("移除成员空出名额，创建者不会被移走", () => {
    const store = new DirectoryStore(sqlStorage());
    const home = store.claim("a@example.com", 2, NOW);
    const pupu = home?.pupu ?? "";
    store.assign("b@example.com", pupu, 2, NOW);
    store.release("b@example.com", pupu);
    store.release("a@example.com", pupu);
    assert.equal(store.invites(2).left, 1);
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

describe("邀请码", () => {
  const LATER = NOW + 60_000;

  function signIn(email: string): HeldSignIn {
    return {
      email,
      name: "Safari · Mac",
      displayName: null,
      flow: {
        state: "s",
        verifier: "v",
        nonce: "n",
        client: "browser",
        challenge: null,
        redirect: null,
        createdAt: NOW,
        expiresAt: LATER
      }
    };
  }

  function held(store: DirectoryStore, email: string): string {
    store.holdSignIn(email, signIn(email), LATER, NOW);
    return email;
  }

  test("一个码只开一个 Pupu，第二个人用就不认", () => {
    const store = new DirectoryStore(sqlStorage());
    const code = store.createInvite(5, NOW) ?? "";

    const first = store.activate(held(store, "a@example.com"), code, 5, NOW);
    assert.equal(first.status, "ok");
    assert.equal(store.home("a@example.com")?.founder, true);
    assert.equal(store.activate(held(store, "b@example.com"), code, 5, NOW).status, "wrong");
    assert.equal(store.home("b@example.com"), null);
    assert.equal(store.invites(5).invites[0]?.usedBy, "a@example.com");
  });

  test("填码不分大小写，也不管横线和空格", () => {
    const store = new DirectoryStore(sqlStorage());
    const code = store.createInvite(5, NOW) ?? "";
    const typed = ` ${code.toLowerCase().replace("-", " ")} `;
    assert.equal(store.activate(held(store, "a@example.com"), typed, 5, NOW).status, "ok");
  });

  test("没用掉的码也占名额，作废了还回来", () => {
    const store = new DirectoryStore(sqlStorage());
    const code = store.createInvite(2, NOW) ?? "";
    store.createInvite(2, NOW);
    assert.equal(store.invites(2).left, 0);
    assert.equal(store.createInvite(2, NOW), null);
    assert.equal(store.revokeInvite(code), true);
    assert.equal(store.invites(2).left, 1);
    assert.equal(store.activate(held(store, "a@example.com"), code, 2, NOW).status, "wrong");
  });

  test("用过的码作废不了", () => {
    const store = new DirectoryStore(sqlStorage());
    const code = store.createInvite(5, NOW) ?? "";
    store.activate(held(store, "a@example.com"), code, 5, NOW);
    assert.equal(store.revokeInvite(code), false);
    assert.equal(store.invites(5).invites.length, 1);
  });

  test("填错太多次这次登录就作废，对的码也不行了", () => {
    const store = new DirectoryStore(sqlStorage());
    const code = store.createInvite(5, NOW) ?? "";
    const token = held(store, "a@example.com");
    for (let attempt = 1; attempt < INVITE_ATTEMPTS; attempt++) {
      assert.equal(store.activate(token, "AAAA-AAAA", 5, NOW).status, "wrong");
    }
    assert.equal(store.activate(token, "AAAA-AAAA", 5, NOW).status, "gone");
    assert.equal(store.activate(token, code, 5, NOW).status, "gone");
    assert.equal(store.invites(5).invites[0]?.usedBy, null);
  });

  test("过期的登录不认", () => {
    const store = new DirectoryStore(sqlStorage());
    const code = store.createInvite(5, NOW) ?? "";
    assert.equal(store.activate(held(store, "a@example.com"), code, 5, LATER).status, "gone");
  });

  test("已经有 Pupu 的账号不花码", () => {
    const store = new DirectoryStore(sqlStorage());
    const home = store.claim("a@example.com", 5, NOW);
    const code = store.createInvite(5, NOW) ?? "";
    const result = store.activate(held(store, "a@example.com"), code, 5, NOW);
    assert.deepEqual(result.status === "ok" ? result.home : null, home);
    assert.equal(store.invites(5).invites[0]?.usedBy, null);
  });

  test("发出去的码占着名额，邀请成员占不走它", () => {
    const store = new DirectoryStore(sqlStorage());
    const code = store.createInvite(2, NOW) ?? "";
    const home = store.claim("owner@example.com", 2, NOW);
    assert.equal(store.assign("member@example.com", home?.pupu ?? "", 2, NOW), "full");
    assert.equal(store.activate(held(store, "a@example.com"), code, 2, NOW).status, "ok");
  });

  test("名额调小到比发出去的码还少：码留着，作废多的之后才能用，这次登录还能再填", () => {
    const store = new DirectoryStore(sqlStorage());
    const code = store.createInvite(2, NOW) ?? "";
    const extra = store.createInvite(2, NOW) ?? "";
    const token = held(store, "a@example.com");
    assert.equal(store.activate(token, code, 1, NOW).status, "full");
    assert.equal(store.invites(1).invites.find((invite) => invite.code === code)?.usedBy, null);
    assert.equal(store.revokeInvite(extra), true);
    assert.equal(store.activate(token, code, 1, NOW).status, "ok");
  });
});
