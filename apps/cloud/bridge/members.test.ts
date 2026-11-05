import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { ComputerStore } from "../src/bridge/store.ts";
import { deviceView, DeviceStore } from "../src/devices.ts";
import {
  actorOf,
  emailKey,
  isEmail,
  mayInvite,
  mayRemoveMember,
  mayRevoke,
  MemberStore,
  memberView,
  type Actor
} from "../src/members.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_800_000_000_000;

describe("邮箱", () => {
  test("Gmail 的点和大小写不算数，googlemail.com 就是 gmail.com；别家的点算数", () => {
    assert.equal(emailKey("Wang.Lei@GMail.com"), "wanglei@gmail.com");
    assert.equal(emailKey("wanglei@googlemail.com"), "wanglei@gmail.com");
    assert.equal(emailKey("wang.lei@example.com"), "wang.lei@example.com");
  });

  test("像不像邮箱", () => {
    assert.equal(isEmail(" mom@example.com "), true);
    assert.equal(isEmail("mom"), false);
    assert.equal(isEmail("a b@example.com"), false);
  });
});

describe("创建者和成员", () => {
  const creator: Actor = { kind: "phone", memberId: "c", role: "creator" };
  const member: Actor = { kind: "phone", memberId: "m", role: "member" };

  test("邀请只有创建者能做，而且要在手机上", () => {
    assert.equal(mayInvite(creator), true);
    assert.equal(mayInvite({ ...creator, kind: "browser" }), false);
    assert.equal(mayInvite({ ...creator, kind: "desktop" }), false);
    assert.equal(mayInvite(member), false);
    assert.equal(mayInvite(undefined), false);
    assert.equal(mayInvite(null), true, "本机开发不带凭据");
    assert.equal(mayInvite({ kind: "phone", memberId: null, role: "creator" }), false, "还没有创建者时邀请不了");
  });

  test("移除成员只有创建者能做，哪个设备都行；创建者移除不了", () => {
    assert.equal(mayRemoveMember({ ...creator, kind: "browser" }, { role: "member" }), true);
    assert.equal(mayRemoveMember(member, { role: "member" }), false);
    assert.equal(mayRemoveMember(creator, { role: "creator" }), false);
    assert.equal(mayRemoveMember(null, { role: "creator" }), false);
  });

  test("吊销：自己名下的自己能吊销，创建者能吊销所有人的", () => {
    assert.equal(mayRevoke(member, "m"), true);
    assert.equal(mayRevoke({ ...member, kind: "browser" }, "m"), true);
    assert.equal(mayRevoke(member, "c"), false);
    assert.equal(mayRevoke(member, null), false);
    assert.equal(mayRevoke(creator, "m"), true);
    assert.equal(mayRevoke(undefined, "m"), false);
    assert.equal(mayRevoke(null, "m"), true);
  });

  test("还没有创建者时，不属于谁的设备按创建者算；有了以后不算", () => {
    const device = { kind: "browser", memberId: null } as const;
    assert.equal(actorOf(device, [])?.role, "creator");
    assert.equal(actorOf(device, [{ id: "c", role: "creator" }])?.role, null);
    assert.deepEqual(actorOf({ kind: "phone", memberId: "m" }, [{ id: "c", role: "creator" }, { id: "m", role: "member" }]), {
      kind: "phone",
      memberId: "m",
      role: "member"
    });
    assert.equal(actorOf({ kind: "phone", memberId: "gone" }, [{ id: "c", role: "creator" }])?.memberId, null, "被移除的");
    assert.equal(actorOf(null, []), null);
    assert.equal(actorOf(undefined, []), undefined);
  });
});

describe("成员表", () => {
  test("只能有一个创建者；邀请过的邮箱不能再邀请", () => {
    const members = new MemberStore(sqlStorage());
    const creator = members.addCreator("Wang.Lei@gmail.com", NOW);
    assert.equal(creator?.email, "wanglei@gmail.com");
    assert.equal(creator?.role, "creator");
    assert.equal(creator?.joinedAt, NOW);
    assert.equal(members.addCreator("other@example.com", NOW), undefined);

    const mom = members.invite("mom@example.com", creator?.id ?? null, NOW + 1);
    assert.equal(mom?.role, "member");
    assert.equal(mom?.joinedAt, null);
    assert.equal(mom?.invitedBy, creator?.id);
    assert.equal(members.invite("MOM@example.com", null, NOW + 2), undefined);
    assert.equal(members.invite("wanglei@gmail.com", null, NOW + 2), undefined, "创建者也算在名单上");

    assert.equal(members.byEmail("wang.lei@gmail.com")?.id, creator?.id);
    members.markJoined(mom?.id ?? "", NOW + 3);
    members.markJoined(mom?.id ?? "", NOW + 4);
    assert.equal(members.byEmail("mom@example.com")?.joinedAt, NOW + 3, "只记第一次");
    assert.deepEqual(
      members.list().map((row) => [row.email, row.role]),
      [
        ["wanglei@gmail.com", "creator"],
        ["mom@example.com", "member"]
      ]
    );
    assert.equal(memberView(members.list()[1]!, mom?.id ?? null).current, true);
  });

  test("移除成员；创建者删不掉", () => {
    const members = new MemberStore(sqlStorage());
    const creator = members.addCreator("c@example.com", NOW);
    const mom = members.invite("mom@example.com", null, NOW);
    assert.equal(members.remove(creator?.id ?? ""), false);
    assert.equal(members.remove(mom?.id ?? ""), true);
    assert.equal(members.remove(mom?.id ?? ""), false);
    assert.equal(members.byEmail("mom@example.com"), undefined);
  });
});

describe("设备和电脑属于谁", () => {
  test("设备记下成员，列表里显示成员的邮箱；不属于谁是 null", () => {
    const sql = sqlStorage();
    const members = new MemberStore(sql);
    const devices = new DeviceStore(sql);
    const mom = members.invite("mom@example.com", null, NOW);
    const phone = devices.insert({ name: "妈妈的 iPhone", kind: "phone", tokenHash: "t1", memberId: mom?.id ?? null });
    const old = devices.insert({ name: "旧浏览器", kind: "browser", tokenHash: "t2", memberId: null });
    const emails = new Map(members.list().map((member) => [member.id, member.email]));
    assert.equal(deviceView(phone, null, emails).member, "mom@example.com");
    assert.equal(deviceView(phone, null, emails).memberId, mom?.id);
    assert.equal(deviceView(old, null, emails).member, null);
    assert.deepEqual(
      devices.ofMember(mom?.id ?? "").map((row) => row.id),
      [phone.id]
    );
  });

  test("创建者第一次登录时，没主人的设备和电脑都归他", () => {
    const sql = sqlStorage();
    const devices = new DeviceStore(sql);
    const computers = new ComputerStore(sql);
    devices.insert({ name: "老手机", kind: "phone", tokenHash: "t1", memberId: null });
    devices.insert({ name: "妈妈的手机", kind: "phone", tokenHash: "t2", memberId: "mom" });
    computers.insert({ name: "老电脑", tokenHash: "c1" });
    computers.insert({ name: "妈妈的电脑", tokenHash: "c2", ownerId: "mom" });
    devices.claimUnowned("me");
    computers.claimUnowned("me");
    assert.equal(devices.byTokenHash("t1")?.memberId, "me");
    assert.equal(devices.byTokenHash("t2")?.memberId, "mom");
    assert.equal(computers.byTokenHash("c1")?.ownerId, "me");
    assert.equal(computers.byTokenHash("c2")?.ownerId, "mom");
  });

  test("配对码记下生成它的设备属于谁，换出来的设备也归他", () => {
    const devices = new DeviceStore(sqlStorage());
    assert.equal(devices.addCode("c1", NOW + 60_000, NOW, { byPhone: true, memberId: "m1" }), true);
    assert.equal(devices.addCode("c2", NOW + 60_000, NOW, { byPhone: false, memberId: null }), true);
    assert.deepEqual(devices.takeCode("c1", NOW), { byPhone: true, memberId: "m1" });
    assert.deepEqual(devices.takeCode("c2", NOW), { byPhone: false, memberId: null });
    assert.equal(devices.takeCode("c1", NOW), undefined, "一个码只能用一次");
  });

  test("早先建的表没有 member_id、owner_id，打开时补上", () => {
    const sql = sqlStorage();
    sql.exec(`CREATE TABLE pupu_devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
    )`);
    sql.exec(
      "INSERT INTO pupu_devices (id, name, kind, token_hash, created_at) VALUES ('d0', '老手机', 'phone', 't0', 1)"
    );
    sql.exec("CREATE TABLE pupu_pairing_codes (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    sql.exec(`CREATE TABLE pupu_computers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      local_root TEXT NOT NULL DEFAULT '', terminals_folder TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, revoked_at INTEGER, last_seen_at INTEGER
    )`);
    sql.exec("INSERT INTO pupu_computers (id, name, token_hash, created_at) VALUES ('p0', '老电脑', 'c0', 1)");
    const devices = new DeviceStore(sql);
    assert.equal(devices.byTokenHash("t0")?.memberId, null);
    assert.equal(devices.hadPhone(), true);
    assert.equal(devices.addCode("c", NOW + 1, NOW, { byPhone: true, memberId: "m" }), true);
    assert.deepEqual(devices.takeCode("c", NOW), { byPhone: true, memberId: "m" });
    const computers = new ComputerStore(sql);
    assert.equal(computers.byTokenHash("c0")?.ownerId, null);
  });
});
