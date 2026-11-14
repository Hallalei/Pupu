// 多组织端到端：本机验证实例 + 假 Google。浏览器的路径用 cookie 罐模拟，手机用 Authorization 头。
import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:5198";
const log = (...args) => console.log(...args);
let failed = 0;
const check = (ok, what) => {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

class Jar {
  constructor() {
    this.cookies = new Map();
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  take(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!value || attrs.some((a) => /max-age=0/i.test(a.trim()))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  async fetch(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (this.cookies.size) headers.Cookie = this.header();
    const response = await fetch(new URL(path, BASE), { ...init, headers, redirect: "manual" });
    this.take(response);
    return response;
  }
  async json(path, init = {}) {
    const response = await this.fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }
}

/** 浏览器用假 Google 登录。返回最后落在哪（"/" 或邀请页）。 */
async function googleSignIn(jar, email) {
  let response = await jar.fetch("/api/auth/google/start?client=browser");
  let location = response.headers.get("location");
  const auth = new URL(location);
  auth.searchParams.set("email", email);
  response = await fetch(auth, { redirect: "manual" });
  location = response.headers.get("location");
  response = await jar.fetch(location);
  return new URL(response.headers.get("location"), BASE).pathname;
}

async function fillInvite(jar, code) {
  const response = await jar.fetch("/api/auth/invite", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code })
  });
  return { status: response.status, location: response.headers.get("location") };
}

const local = new Jar(); // 本机开发不带凭据：当第一个 Pupu 的创建者用
const owner = new Jar();
const bee = new Jar();
const cat = new Jar();

// 1. 第一个 Pupu（A）的创建者林夏登录。
check((await googleSignIn(owner, "owner@example.com")) === "/", "owner 登录进第一个 Pupu");
const ownerState = (await owner.json("/api/state")).body;
const ownerMe = ownerState.members.find((m) => m.current);
check(ownerMe?.role === "creator", "owner 是第一个 Pupu 的创建者");

// 2. 林夏生成邀请码，bee 用它开自己的 Pupu（B）。
const { body: invite } = await owner.json("/api/invites", { method: "POST" });
check(typeof invite.code === "string", `生成邀请码 ${invite.code}`);
check((await googleSignIn(bee, "bee@example.com")) === "/api/auth/invite", "bee 没有 Pupu，停在填码页");
const filled = await fillInvite(bee, invite.code);
check(filled.status === 302 && filled.location === "/", "bee 填码开了自己的 Pupu");
let beeOrgs = (await bee.json("/api/orgs")).body;
check(beeOrgs.orgs.length === 1 && beeOrgs.orgs[0].role === "creator" && beeOrgs.orgs[0].name === "我的 Pupu", "bee 现在只有自己的 Pupu");
const orgB = beeOrgs.current;
check(orgB !== "me", `bee 的 Pupu 是新的一个（${orgB}）`);

// 3. 林夏把已经有自己 Pupu 的 bee 邀请进 A（以前会说「已经有自己的 Pupu 了」）。
const invited = await local.json("/api/members", { method: "POST", body: JSON.stringify({ email: "bee@example.com" }) });
check(invited.status === 200, `已经有自己 Pupu 的 bee 能被邀请进 A：${JSON.stringify(invited.body)}`);
beeOrgs = (await bee.json("/api/orgs")).body;
check(
  beeOrgs.orgs.length === 2 && beeOrgs.orgs[0].role === "creator" && beeOrgs.orgs[1].name === "林夏的 Pupu",
  `bee 的列表：${beeOrgs.orgs.map((o) => `${o.name}${o.current ? "✓" : ""}`).join("、")}`
);

// 4. bee 切到 A：拿到 A 的 cookie，看到的是 A。
const beforeB = (await bee.json("/api/state")).body;
const switched = await bee.json("/api/orgs/switch", { method: "POST", body: JSON.stringify({ org: "me" }) });
check(switched.status === 200, "bee 切到 A");
check(bee.cookies.get("pupu_active") === "me" && bee.cookies.has("pupu_org_me"), "切完 cookie：选中 A，A 的凭据单放");
const beeInA = (await bee.json("/api/state")).body;
const beeMeA = beeInA.members.find((m) => m.current);
check(beeMeA?.email === "bee@example.com" && beeMeA.role === "member", "在 A 里 bee 是成员");
check(beeInA.members.length === 2 && beforeB.members.length === 1, "A 有两个人，B 只有 bee 一个：两边数据不串");
const beePrivateA = beeInA.chats.private?.session;
check(typeof beePrivateA === "string", `bee 在 A 的个人入口 ${beePrivateA}`);
check(beePrivateA !== beforeB.chats.private?.session, "两个 Pupu 的个人入口不是同一条");
const devicesA = beeInA.devices.filter((d) => d.current);
check(devicesA.length === 1 && devicesA[0].kind === "browser", "A 里给 bee 这个浏览器发了一张浏览器凭据");

// 5. 切回 B 再切回 A：用回已有的 cookie，不多发设备。
await bee.json("/api/orgs/switch", { method: "POST", body: JSON.stringify({ org: orgB }) });
check((await bee.json("/api/state")).body.members.length === 1, "切回 B");
await bee.json("/api/orgs/switch", { method: "POST", body: JSON.stringify({ org: "me" }) });
const ownerDevices = (await owner.json("/api/state")).body.devices.filter((d) => d.memberEmail === "bee@example.com" || d.owner === "bee@example.com");
const beeDevicesInA = (await owner.json("/api/state")).body.devices.length;
check(beeDevicesInA === 2, `再切回 A 不多发设备（A 里共 ${beeDevicesInA} 台：owner 一台、bee 一台）`);

// 6. 不在的 Pupu 切不进去；乱填的 id 也不行。
const stranger = await bee.json("/api/orgs/switch", { method: "POST", body: JSON.stringify({ org: "0".repeat(32) }) });
check(stranger.status === 403, "不在的 Pupu 切不进去");

// 7. 林夏打不开 bee 在 A 的个人入口（创建者也不行）。
async function opens(jar, session) {
  return new Promise((resolve) => {
    const url = `${BASE.replace("http", "ws")}/agents/pupu/me?_pk=${crypto.randomUUID()}&session=${encodeURIComponent(session)}`;
    const ws = new WebSocket(url, { headers: jar.cookies.size ? { Cookie: jar.header() } : {} });
    const done = (value) => {
      try {
        ws.close();
      } catch {}
      resolve(value);
    };
    ws.addEventListener("open", () => setTimeout(() => done(true), 300));
    ws.addEventListener("error", () => done(false));
    ws.addEventListener("close", () => done(false));
    setTimeout(() => done(false), 5000);
  });
}
check((await opens(bee, beePrivateA)) === true, "bee 自己打得开 A 里的个人入口");
check((await opens(owner, beePrivateA)) === false, "林夏打不开 bee 的个人入口");

// 7b. bee 切在 A 时建空间：落在 A，不落在自己的 B。bee 是主人，把林夏拉进来。
const created = await bee.json("/api/spaces", { method: "POST", body: JSON.stringify({ name: "定价", goal: "定下季度价格" }) });
check(created.status === 200 && created.body.id, "bee 在 A 里建了空间「定价」");
const spaceId = created.body.id;
const ownerIdInA = (await owner.json("/api/state")).body.members.find((m) => m.email === "owner@example.com").id;
const beeIdInA = (await owner.json("/api/state")).body.members.find((m) => m.email === "bee@example.com").id;
const spaceInA = (await bee.json("/api/state")).body.projects.find((p) => p.id === spaceId);
check(spaceInA?.ownerId === beeIdInA, "空间在 A 里，主人是 bee 在 A 的身份");
const pulled = await bee.json(`/api/spaces/${spaceId}`, { method: "POST", body: JSON.stringify({ kind: "add", memberId: ownerIdInA }) });
check(pulled.status === 200, "bee 把林夏拉进空间");
check((await owner.json("/api/state")).body.projects.some((p) => p.id === spaceId), "林夏看得到「定价」");

// 8. 林夏把 bee 移出 A。
const beeMemberA = (await owner.json("/api/state")).body.members.find((m) => m.email === "bee@example.com");
const removed = await local.json(`/api/members/${beeMemberA.id}/remove`, { method: "POST" });
check(removed.status === 200, "林夏移除 bee");
// 被移出的人是空间主人：空间留着，林夏照样看得到，bee 从成员里拿掉；主人还记着 bee，所以林夏改不了（这一条是现状，待定）。
const ownerView = await owner.json("/api/state");
const orphan = ownerView.body.projects?.find((p) => p.id === spaceId);
check(ownerView.status === 200 && orphan && !orphan.members.includes(beeIdInA), "主人被移出组织后空间还在，林夏的状态照常，bee 不在成员里");
const takeOver = await owner.json(`/api/spaces/${spaceId}`, { method: "POST", body: JSON.stringify({ kind: "level", level: "L2" }) });
log(`     （现状）主人被移出后林夏改空间：${takeOver.status}，空间主人还是 ${orphan?.ownerId === beeIdInA ? "bee" : orphan?.ownerId}`);
const after = await bee.json("/api/state");
check(after.status === 200 && after.body.members.length === 1 && after.body.members[0].role === "creator", "bee 的网页没 401，自动回到自己的 B");
beeOrgs = (await bee.json("/api/orgs")).body;
check(beeOrgs.orgs.length === 1 && beeOrgs.orgs[0].id === orgB, "bee 的列表里没有 A 了，自己的 B 还在");
const back = await bee.json("/api/orgs/switch", { method: "POST", body: JSON.stringify({ org: "me" }) });
check(back.status === 403, "被移除后切不回 A");
check((await opens(owner, beePrivateA)) === false, "移除后 bee 的个人入口锁着，林夏也打不开");
const ownerAfter = (await owner.json("/api/state")).body;
check(!ownerAfter.members.some((m) => m.email === "bee@example.com"), "A 的名单里没有 bee");

// 9. 再邀请回来：个人入口回来了，是同一条。
await local.json("/api/members", { method: "POST", body: JSON.stringify({ email: "bee@example.com" }) });
const again = await bee.json("/api/orgs/switch", { method: "POST", body: JSON.stringify({ org: "me" }) });
check(again.status === 200, "再邀请后又能切进 A");
const beeAgain = (await bee.json("/api/state")).body;
check(beeAgain.chats.private?.session === beePrivateA, "个人入口回来了，还是原来那条");
check((await opens(bee, beePrivateA)) === true, "bee 又打得开了");
const spaceForBee = beeAgain.projects.find((p) => p.id === spaceId);
log(`     （现状）bee 回来后看「定价」：${spaceForBee ? `看得到，成员 ${spaceForBee.members.length} 人` : "看不到"}`);

// 10. 没有 Pupu 的新账号 cat 被邀请进 A：只进 A，不替他开自己的；以后能用码开。
await local.json("/api/members", { method: "POST", body: JSON.stringify({ email: "cat@example.com" }) });
check((await googleSignIn(cat, "cat@example.com")) === "/", "cat 被邀请，直接进 A，不用填码");
let catOrgs = (await cat.json("/api/orgs")).body;
check(catOrgs.orgs.length === 1 && catOrgs.orgs[0].id === "me" && catOrgs.canOpenOwn === true, "cat 只在 A 里，能开自己的");
const { body: invite2 } = await owner.json("/api/invites", { method: "POST" });
const wrong = await cat.json("/api/orgs/own", { method: "POST", body: JSON.stringify({ code: "AAAA-AAAA" }) });
check(wrong.status === 400, "填错码开不了");
const opened = await cat.json("/api/orgs/own", { method: "POST", body: JSON.stringify({ code: invite2.code }) });
check(opened.status === 200, "cat 用码开了自己的 Pupu，直接切过去");
catOrgs = (await cat.json("/api/orgs")).body;
check(catOrgs.orgs.length === 2 && catOrgs.orgs[0].role === "creator" && catOrgs.orgs[0].current, "cat 现在两个：自己的（当前）和 A");

// 11. 手机：bee 在 B 配一台手机，切到 A 要换码，A 已经有手机了就等已有的手机点允许。
await bee.json("/api/orgs/switch", { method: "POST", body: JSON.stringify({ org: orgB }) });
const pairCode = (await bee.json("/api/pairing-codes", { method: "POST" })).body.code;
const phone = await (await fetch(`${BASE}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "phone", name: "bee 的手机", code: pairCode }) })).json();
check(typeof phone.token === "string" && phone.token.startsWith(orgB), "bee 的手机连上 B");
const phoneOrgs = await (await fetch(`${BASE}/api/orgs`, { headers: { Authorization: `Bearer ${phone.token}` } })).json();
check(phoneOrgs.orgs.length === 2 && phoneOrgs.current === orgB, "手机看到两个 Pupu");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const phoneSwitch = await (await fetch(`${BASE}/api/orgs/switch`, { method: "POST", headers: { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ org: "me", challenge }) })).json();
check(typeof phoneSwitch.code === "string" && !phoneSwitch.token, "手机切 A 拿到的是码，不是直接发凭据");
const aHadPhone = (await owner.json("/api/state")).body.devices.some((d) => d.kind === "phone");
check(aHadPhone === false, "A 这时还没有手机");
const redeem = await fetch(`${BASE}/api/auth/redeem`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: phoneSwitch.code, verifier, name: "bee 的手机" }) });
const redeemBody = await redeem.json();
log("   换码结果", redeem.status, JSON.stringify(redeemBody).slice(0, 160));
check(redeem.status === 200 && typeof redeemBody.device?.token === "string", "A 还没有手机：直接发 A 的手机凭据（和新手机 Google 登录同一条规则）");
const phoneA = await (await fetch(`${BASE}/api/state`, { headers: { Authorization: `Bearer ${redeemBody.device.token}` } })).json();
check(phoneA.members.find((m) => m.current)?.email === "bee@example.com", "手机用 A 的凭据看到的是 A，算 bee");

// 12. cat 在自己的 Pupu 配手机，切到 A：A 已经有手机了，要等已有的手机点允许。
const catCode = (await cat.json("/api/pairing-codes", { method: "POST" })).body.code;
const catPhone = await (await fetch(`${BASE}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "phone", name: "cat 的手机", code: catCode }) })).json();
const v2 = randomBytes(32).toString("base64url");
const c2 = createHash("sha256").update(v2).digest("base64url");
const catSwitch = await (await fetch(`${BASE}/api/orgs/switch`, { method: "POST", headers: { Authorization: `Bearer ${catPhone.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ org: "me", challenge: c2 }) })).json();
const wait = await fetch(`${BASE}/api/auth/redeem`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: catSwitch.code, verifier: v2, name: "cat 的手机" }) });
check(wait.status === 202, "A 已经有手机：cat 的手机切进来要等已有的手机点允许");
const pendingA = (await owner.json("/api/state")).body.approvals.filter((a) => a.kind === "sign_in");
check(pendingA.length === 1, "A 里出现一条「新手机想连上 Pupu」等批（不替用户点）");
const bad = await fetch(`${BASE}/api/auth/redeem`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: catSwitch.code, verifier: randomBytes(32).toString("base64url"), name: "x" }) });
check(bad.status === 400, "换码时 verifier 对不上不给");

log(failed ? `\n${failed} 项没过` : "\n全部通过");
process.exit(failed ? 1 : 0);
