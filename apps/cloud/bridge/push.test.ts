import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { ApprovalRow } from "../src/bridge/approvals.ts";
import { Apns, PROVIDER_TOKEN_MS, apnsKeyFrom, signProviderToken, type ApnsPush, type ApnsResult } from "../src/push/apns.ts";
import { APPROVAL_CATEGORY, ApprovalPusher } from "../src/push/approvals.ts";
import type { ApprovalPushState, PushDirectory, PushTokenRow, PushTokenType } from "../src/push/store.ts";

async function newKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify"
  ])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const body = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

function decodePart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("provider token", () => {
  test("ES256 JWT 能用对应的公钥验过", async () => {
    const { pem, publicKey } = await newKey();
    const jwt = await signProviderToken({ key: pem, keyId: "ABC123DEFG", teamId: "TEAM123456" }, 1_700_000_000);
    const [header, claims, signature] = jwt.split(".");
    assert.deepEqual(decodePart(header!), { alg: "ES256", kid: "ABC123DEFG" });
    assert.deepEqual(decodePart(claims!), { iss: "TEAM123456", iat: 1_700_000_000 });
    const raw = Buffer.from(signature!, "base64url");
    assert.equal(raw.length, 64);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      raw,
      new TextEncoder().encode(`${header}.${claims}`)
    );
    assert.ok(ok);
  });

  test("secret 里粘成一行、带字面 \\n 的私钥也认", async () => {
    const { pem } = await newKey();
    const oneLine = pem.replace(/\n/g, "\\n");
    const jwt = await signProviderToken({ key: oneLine, keyId: "K", teamId: "T" }, 1);
    assert.equal(jwt.split(".").length, 3);
  });

  test("三个 secret 缺一个就不推", () => {
    assert.equal(apnsKeyFrom({ APNS_KEY: "k", APNS_KEY_ID: "i" }), null);
    assert.deepEqual(apnsKeyFrom({ APNS_KEY: "k", APNS_KEY_ID: " i ", APNS_TEAM_ID: "t" }), {
      key: "k",
      keyId: "i",
      teamId: "t"
    });
  });
});

type Sent = { url: string; headers: Record<string, string>; body: unknown; jwt: string };

async function apnsWith(answers: Array<{ status: number; reason?: string } | Error>) {
  const { pem } = await newKey();
  let now = 1_000_000_000;
  let cached: string | undefined;
  const sent: Sent[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    sent.push({
      url,
      headers,
      body: JSON.parse(String(init.body)),
      jwt: headers.authorization!.replace("bearer ", "")
    });
    const answer = answers.shift() ?? { status: 200 };
    if (answer instanceof Error) throw answer;
    return new Response(answer.reason ? JSON.stringify({ reason: answer.reason }) : null, { status: answer.status });
  }) as unknown as typeof fetch;
  const apns = new Apns({
    key: { key: pem, keyId: "KEY1234567", teamId: "TEAM123456" },
    cache: { get: () => cached, set: (value) => (cached = value) },
    now: () => now,
    fetch: fetcher
  });
  return {
    apns,
    sent,
    advance: (ms: number) => (now += ms),
    cached: () => cached
  };
}

const PUSH: ApnsPush = {
  token: "ab".repeat(32),
  env: "sandbox",
  type: "alert",
  priority: 10,
  collapseId: "approval-1",
  expiration: 123,
  payload: { aps: { alert: "hi" } }
};

describe("Apns", () => {
  test("请求发到对应环境，带上 topic、collapse id 和过期时间", async () => {
    const { apns, sent } = await apnsWith([{ status: 200 }]);
    assert.deepEqual(await apns.send(PUSH), { status: 200, reason: null, gone: false });
    assert.equal(sent[0]!.url, `https://api.sandbox.push.apple.com/3/device/${"ab".repeat(32)}`);
    assert.equal(sent[0]!.headers["apns-topic"], "com.leizi.pupu");
    assert.equal(sent[0]!.headers["apns-push-type"], "alert");
    assert.equal(sent[0]!.headers["apns-collapse-id"], "approval-1");
    assert.equal(sent[0]!.headers["apns-expiration"], "123");
    assert.deepEqual(sent[0]!.body, { aps: { alert: "hi" } });
  });

  test("实时活动的 topic 后面加 .push-type.liveactivity", async () => {
    const { apns, sent } = await apnsWith([{ status: 200 }]);
    await apns.send({ ...PUSH, env: "production", type: "liveactivity", priority: 5 });
    assert.ok(sent[0]!.url.startsWith("https://api.push.apple.com/"));
    assert.equal(sent[0]!.headers["apns-topic"], "com.leizi.pupu.push-type.liveactivity");
  });

  test("JWT 存起来，50 分钟内复用，到点才换", async () => {
    const { apns, sent, advance, cached } = await apnsWith([]);
    await apns.send(PUSH);
    await apns.send(PUSH);
    assert.equal(sent[0]!.jwt, sent[1]!.jwt);
    assert.ok(cached()?.includes(sent[0]!.jwt));
    advance(PROVIDER_TOKEN_MS - 1000);
    await apns.send(PUSH);
    assert.equal(sent[2]!.jwt, sent[0]!.jwt);
    advance(2000);
    await apns.send(PUSH);
    assert.notEqual(sent[3]!.jwt, sent[0]!.jwt);
  });

  test("一批推送同时要 JWT，只签一次", async () => {
    const { apns, sent } = await apnsWith([]);
    await Promise.all([apns.send(PUSH), apns.send(PUSH), apns.send(PUSH)]);
    assert.equal(new Set(sent.map((item) => item.jwt)).size, 1);
  });

  test("APNs 说 JWT 过期了就换一个重发一次", async () => {
    const { apns, sent, advance } = await apnsWith([{ status: 403, reason: "ExpiredProviderToken" }, { status: 200 }]);
    advance(1000);
    const result = await apns.send(PUSH);
    assert.equal(result.status, 200);
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0]!.jwt, sent[1]!.jwt);
  });

  test("410 和 BadDeviceToken 算 token 作废，别的错误不算", async () => {
    const { apns } = await apnsWith([
      { status: 410, reason: "Unregistered" },
      { status: 400, reason: "BadDeviceToken" },
      { status: 403, reason: "InvalidProviderToken" },
      new Error("Network connection lost.")
    ]);
    assert.deepEqual(await apns.send(PUSH), { status: 410, reason: "Unregistered", gone: true });
    assert.equal((await apns.send(PUSH)).gone, true);
    assert.deepEqual(await apns.send(PUSH), { status: 403, reason: "InvalidProviderToken", gone: false });
    assert.deepEqual(await apns.send(PUSH), { status: 0, reason: "Network connection lost.", gone: false });
  });
});

class MemoryPush implements PushDirectory {
  rows: PushTokenRow[] = [];
  readonly states = new Map<string, { state: ApprovalPushState; at: number }>();

  tokens(type: PushTokenType) {
    return this.rows.filter((row) => row.type === type);
  }

  save(input: { deviceId: string; token: string; type: PushTokenType; env: "sandbox" | "production" }, now: number) {
    this.rows = this.rows.filter(
      (row) => !(row.type === input.type && (row.token === input.token || row.deviceId === input.deviceId))
    );
    this.rows.push({ ...input, createdAt: now, lastSeen: now });
  }

  remove(token: string) {
    this.rows = this.rows.filter((row) => row.token !== token);
  }

  removeDevice(deviceId: string) {
    this.rows = this.rows.filter((row) => row.deviceId !== deviceId);
  }

  approvalState(id: string) {
    return this.states.get(id)?.state;
  }

  markApproval(id: string, state: ApprovalPushState, now: number) {
    this.states.set(id, { state, at: now });
  }

  sentApprovals() {
    return [...this.states].filter(([, value]) => value.state === "sent").map(([id]) => id);
  }

  pruneApprovals(before: number) {
    for (const [id, value] of this.states) if (value.at < before) this.states.delete(id);
  }
}

function approval(id: string, patch: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id,
    callId: `call-${id}`,
    computerId: "c1",
    kind: "step",
    screen: false,
    title: "在「mbpro」上跑命令",
    detail: "git push origin main",
    reason: "推送到远端仓库",
    status: "pending",
    note: null,
    createdAt: 1_000,
    expiresAt: 601_000,
    decidedAt: null,
    ...patch
  };
}

function pusherSetup(options: { configured?: boolean; answer?: (push: ApnsPush) => ApnsResult } = {}) {
  let now = 2_000;
  let rows: ApprovalRow[] = [];
  const store = new MemoryPush();
  const sent: ApnsPush[] = [];
  const sender = {
    send: async (push: ApnsPush) => {
      sent.push(push);
      return options.answer?.(push) ?? { status: 200, reason: null, gone: false };
    }
  };
  const pusher = new ApprovalPusher({
    approvals: {
      byId: (id) => rows.find((row) => row.id === id),
      pending: (at) => rows.filter((row) => row.status === "pending" && row.expiresAt > at)
    },
    store,
    apns: () => (options.configured === false ? null : sender),
    now: () => now
  });
  store.save({ deviceId: "phone-a", token: "aa".repeat(32), type: "alert", env: "sandbox" }, 0);
  store.save({ deviceId: "phone-b", token: "bb".repeat(32), type: "alert", env: "production" }, 0);
  return {
    pusher,
    store,
    sent,
    set: (next: ApprovalRow[]) => (rows = next),
    advance: (ms: number) => (now += ms)
  };
}

describe("ApprovalPusher", () => {
  test("新的审批给每台手机推一条带按钮的通知，collapse id 是审批 id", async () => {
    const { pusher, sent, set } = pusherSetup();
    set([approval("a1")]);
    await pusher.sync();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((push) => push.env).sort(), ["production", "sandbox"]);
    for (const push of sent) {
      assert.equal(push.collapseId, "a1");
      assert.equal(push.priority, 10);
      assert.equal(push.expiration, 601);
      const payload = push.payload as { aps: { category: string; alert: { title: string; subtitle: string; body: string } }; approvalId: string };
      assert.equal(payload.aps.category, APPROVAL_CATEGORY);
      assert.equal(payload.approvalId, "a1");
      assert.equal(payload.aps.alert.title, "在「mbpro」上跑命令");
      assert.equal(payload.aps.alert.subtitle, "高风险：推送到远端仓库");
      assert.equal(payload.aps.alert.body, "git push origin main");
    }
  });

  test("推过的不再推；同时来两轮也只推一次", async () => {
    const { pusher, sent, set } = pusherSetup();
    set([approval("a1")]);
    await Promise.all([pusher.sync(), pusher.sync()]);
    await pusher.sync();
    assert.equal(sent.length, 2);
  });

  test("处理完换成没有按钮的「已处理」，在哪台手机上批的就不给它推", async () => {
    const { pusher, sent, set } = pusherSetup();
    set([approval("a1")]);
    await pusher.sync();
    sent.length = 0;
    pusher.decidedBy("a1", "phone-a");
    set([approval("a1", { status: "allowed", decidedAt: 3_000 })]);
    await pusher.sync();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.token, "bb".repeat(32));
    assert.equal(sent[0]!.collapseId, "a1");
    const payload = sent[0]!.payload as { aps: Record<string, unknown> & { alert: { title: string } }; settled: string };
    assert.equal(payload.aps.category, undefined);
    assert.equal(payload.aps["interruption-level"], "passive");
    assert.equal(payload.aps.alert.title, "已允许：在「mbpro」上跑命令");
    assert.equal(payload.settled, "allowed");
    sent.length = 0;
    await pusher.sync();
    assert.equal(sent.length, 0);
  });

  test("过期了还没人处理，两台手机都换成「已过期」", async () => {
    const { pusher, sent, set, advance } = pusherSetup();
    set([approval("a1")]);
    await pusher.sync();
    sent.length = 0;
    advance(700_000);
    await pusher.sync();
    assert.equal(sent.length, 2);
    for (const push of sent) {
      const payload = push.payload as { aps: { alert: { title: string } }; settled: string };
      assert.equal(payload.aps.alert.title, "已过期，没有做：在「mbpro」上跑命令");
      assert.equal(payload.settled, "expired");
    }
  });

  test("电脑上收回时拒掉的，「已处理」里带上来由", async () => {
    const { pusher, sent, set } = pusherSetup();
    set([approval("a1")]);
    await pusher.sync();
    sent.length = 0;
    set([approval("a1", { status: "denied", note: "用户在电脑上收回了屏幕控制" })]);
    await pusher.sync();
    const payload = sent[0]!.payload as { aps: { alert: { title: string; body: string } } };
    assert.equal(payload.aps.alert.title, "已拒绝：在「mbpro」上跑命令");
    assert.equal(payload.aps.alert.body, "用户在电脑上收回了屏幕控制");
  });

  test("APNs 说 token 作废了就删掉", async () => {
    const { pusher, store, set } = pusherSetup({
      answer: (push) =>
        push.token === "aa".repeat(32)
          ? { status: 410, reason: "Unregistered", gone: true }
          : { status: 200, reason: null, gone: false }
    });
    set([approval("a1")]);
    await pusher.sync();
    assert.deepEqual(
      store.tokens("alert").map((row) => row.deviceId),
      ["phone-b"]
    );
  });

  test("没配密钥时什么都不推也不记，配好以后还在等的照样推", async () => {
    const off = pusherSetup({ configured: false });
    off.set([approval("a1")]);
    await off.pusher.sync();
    assert.equal(off.sent.length, 0);
    assert.equal(off.store.approvalState("a1"), undefined);
  });
});
