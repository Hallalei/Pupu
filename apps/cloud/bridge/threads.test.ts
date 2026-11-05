import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { ProjectStore } from "../src/projects.ts";
import { THREAD_REFUSED_CLOSE_CODE } from "../src/protocol.ts";
import { PiSessionSockets } from "../src/sockets.ts";
import { MAIN_SESSION, mayOpen, seesWork, ThreadStore } from "../src/threads.ts";
import { sqlStorage } from "./sql-memory.ts";

function stores() {
  const sql = sqlStorage();
  const projects = new ProjectStore(sql);
  return { projects, threads: new ThreadStore(sql, projects) };
}

describe("会话是什么", () => {
  test("根会话是主会话，私聊和项目按表查，别的查不到", async () => {
    const { projects, threads } = stores();
    await threads.ensurePrivateChat("m1", async () => "7", 100);
    projects.insertProject({ session: "8", name: "周报", goal: "", background: "" });

    assert.deepEqual(threads.of(MAIN_SESSION), { kind: "main", session: "1" });
    assert.deepEqual(threads.of("7"), { kind: "private", session: "7", memberId: "m1" });
    assert.equal(threads.of("8")?.kind, "project");
    assert.equal(threads.of("9"), undefined);
  });
});

describe("私聊只建一次", () => {
  test("再要一次拿到同一条", async () => {
    const { threads } = stores();
    let created = 0;
    const create = async () => String(10 + ++created);

    const first = await threads.ensurePrivateChat("m1", create, 100);
    const again = await threads.ensurePrivateChat("m1", create, 200);

    assert.equal(created, 1);
    assert.equal(again.session, first.session);
  });

  test("同时来两个请求也只建一个会话", async () => {
    const { threads } = stores();
    let created = 0;
    const create = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return String(10 + ++created);
    };

    const [a, b] = await Promise.all([
      threads.ensurePrivateChat("m1", create, 100),
      threads.ensurePrivateChat("m1", create, 100)
    ]);

    assert.equal(created, 1);
    assert.equal(a.session, b.session);
  });

  test("建失败了下次还能再建", async () => {
    const { threads } = stores();
    await assert.rejects(threads.ensurePrivateChat("m1", () => Promise.reject(new Error("没建成")), 100));
    const row = await threads.ensurePrivateChat("m1", async () => "7", 100);
    assert.equal(row.session, "7");
  });

  test("每人一条", async () => {
    const { threads } = stores();
    const a = await threads.ensurePrivateChat("m1", async () => "7", 100);
    const b = await threads.ensurePrivateChat("m2", async () => "8", 100);
    assert.notEqual(a.session, b.session);
  });
});

describe("chats 里的回复时间", () => {
  test("主会话和私聊各记各的", async () => {
    const { threads } = stores();
    const own = await threads.ensurePrivateChat("m1", async () => "7", 100);
    assert.deepEqual(threads.chats(own), {
      main: { session: "1", lastAt: null },
      private: { session: "7", lastAt: null }
    });

    threads.recordReply({ kind: "main", session: "1" }, 300);
    threads.recordReply({ kind: "private", session: "7", memberId: "m1" }, 500);

    assert.deepEqual(threads.chats(threads.byMember("m1")!), {
      main: { session: "1", lastAt: 300 },
      private: { session: "7", lastAt: 500 }
    });
  });

  test("没有成员身份时没有私聊", () => {
    const { threads } = stores();
    assert.equal(threads.chats(null).private, null);
  });
});

describe("谁看得到私聊里发起的事", () => {
  const privately = { kind: "private", session: "7", memberId: "m1" } as const;

  test("发起人和批准人看得到，第三个人看不到", () => {
    assert.equal(seesWork(privately, "m1", "m2"), true);
    assert.equal(seesWork(privately, "m2", "m2"), true);
    assert.equal(seesWork(privately, "m3", "m2"), false);
  });

  test("没有成员身份的看不到", () => {
    assert.equal(seesWork(privately, null, null), false);
  });

  test("公开会话谁都看得到", () => {
    assert.equal(seesWork({ kind: "main", session: "1" }, "m3", "m2"), true);
    assert.equal(seesWork({ kind: "main", session: "1" }, null, "m2"), true);
  });

  test("说不准是哪个会话的只给批准人", () => {
    assert.equal(seesWork(undefined, "m2", "m2"), true);
    assert.equal(seesWork(undefined, "m3", "m2"), false);
  });
});

/** 只留这里用得到的：记下发给这条连接的帧和关闭码。 */
function fakeConnection(session: string, device: string | null) {
  const sent: { type: string; id?: string; message?: string }[] = [];
  const closed: number[] = [];
  return {
    tags: [`pi-session:${session}`, ...(device ? [`pupu-device:${device}`] : [])],
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
    close: (code: number) => closed.push(code),
    sent,
    closed
  };
}

/** 真的 PiSessionSockets 接假的 pi：看谁的消息送到了 pi，谁拿到了快照。 */
function sockets(owner: Record<string, string>) {
  const { threads } = stores();
  const submitted: { session: string; input: unknown }[] = [];
  const watched: string[] = [];
  const harness = {
    session: (session: string) => ({
      events: async () => {
        watched.push(session);
        return { snapshot: { type: "snapshot" }, start: () => {}, stop: async () => {} };
      },
      submit: async (input: unknown) => {
        submitted.push({ session, input });
        return { ok: true };
      },
      abort: async () => null
    })
  };
  const handlers = new PiSessionSockets(
    harness as never,
    () => [],
    () => [],
    () => {},
    () => null,
    (session, device) => mayOpen(threads.of(session), device === null ? null : (owner[device] ?? null))
  ).options().handlers;
  const connect = (connection: ReturnType<typeof fakeConnection>, session: string) =>
    handlers.onConnect!(connection as never, {
      request: new Request(`https://pupu.test/agents/pupu/me?session=${session}`)
    } as never);
  const message = (connection: ReturnType<typeof fakeConnection>, body: unknown) =>
    handlers.onMessage!(connection as never, JSON.stringify(body));
  return { threads, submitted, watched, connect, message };
}

describe("按设备发的帧", () => {
  test("每条连接拿到自己那一份，桥的连接不收", () => {
    const lin = fakeConnection("1", "lin");
    const zhou = fakeConnection("1", "zhou");
    const bridge = { ...fakeConnection("1", null), tags: ["bridge"] };
    const connections = [lin, zhou, bridge];
    const route = {
      tag: "bridge",
      isRequest: () => false,
      onConnect: async () => {},
      onMessage: async () => {},
      onClose: () => {}
    };
    const pupu = new PiSessionSockets(
      {} as never,
      () => connections as never,
      (socket) => (socket as unknown as { tags: string[] }).tags,
      () => {},
      () => null,
      () => true,
      [route]
    );

    pupu.broadcastBy((device) => ({ type: "error", message: `给 ${device}` }));

    assert.deepEqual(lin.sent.map((frame) => frame.message), ["给 lin"]);
    assert.deepEqual(zhou.sent.map((frame) => frame.message), ["给 zhou"]);
    assert.deepEqual(bridge.sent, []);
  });
});

describe("私聊的连接", () => {
  const owner = { lin: "m1", zhou: "m2" };

  test("本人能打开、能发", async () => {
    const pupu = sockets(owner);
    await pupu.threads.ensurePrivateChat("m1", async () => "7", 100);
    const connection = fakeConnection("7", "lin");

    await pupu.connect(connection, "7");
    await pupu.message(connection, { type: "submit", id: "a", input: "下周哪天有空" });

    assert.deepEqual(connection.closed, []);
    assert.deepEqual(pupu.watched, ["7"]);
    assert.deepEqual(pupu.submitted, [{ session: "7", input: "下周哪天有空" }]);
  });

  test("别人连不上，也看不到内容", async () => {
    const pupu = sockets(owner);
    await pupu.threads.ensurePrivateChat("m1", async () => "7", 100);
    const connection = fakeConnection("7", "zhou");

    await pupu.connect(connection, "7");

    assert.deepEqual(connection.closed, [THREAD_REFUSED_CLOSE_CODE]);
    assert.deepEqual(pupu.watched, []);
    assert.deepEqual(connection.sent, []);
  });

  test("没带身份的连不上", async () => {
    const pupu = sockets(owner);
    await pupu.threads.ensurePrivateChat("m1", async () => "7", 100);
    const connection = fakeConnection("7", null);

    await pupu.connect(connection, "7");

    assert.deepEqual(connection.closed, [THREAD_REFUSED_CLOSE_CODE]);
  });

  test("查不到的会话不让开", async () => {
    const pupu = sockets(owner);
    const connection = fakeConnection("99", "lin");

    await pupu.connect(connection, "99");

    assert.deepEqual(connection.closed, [THREAD_REFUSED_CLOSE_CODE]);
    assert.deepEqual(pupu.watched, []);
  });

  test("混进来的连接发不了、也重新拉不到快照", async () => {
    const pupu = sockets(owner);
    await pupu.threads.ensurePrivateChat("m1", async () => "7", 100);
    const connection = fakeConnection("7", "zhou");

    await pupu.message(connection, { type: "submit", id: "a", input: "我是林夏" });
    await pupu.message(connection, { type: "resync", id: "b" });

    assert.deepEqual(pupu.submitted, []);
    assert.deepEqual(pupu.watched, []);
    assert.deepEqual(connection.sent.map((frame) => frame.type), ["error", "error"]);
  });

  test("主会话谁都能开", async () => {
    const pupu = sockets(owner);
    const connection = fakeConnection("1", "zhou");

    await pupu.connect(connection, "1");

    assert.deepEqual(connection.closed, []);
    assert.deepEqual(pupu.watched, ["1"]);
  });
});
