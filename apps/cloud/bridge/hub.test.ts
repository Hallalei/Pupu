import assert from "node:assert/strict";
import { describe, mock } from "node:test";
import test from "node:test";
import { RemoteDesktopHub } from "../src/bridge/desktop.ts";
import { ComputerBridge, type BridgeSocket } from "../src/bridge/hub.ts";
import {
  ALREADY_CONNECTED_CODE,
  BRIDGE_PING,
  CANCEL_CONFIRM_MS,
  FIRST_BYTE_MS,
  OUTDATED_CODE,
  REJECT_CODE,
  STALE_MS,
  tokenHash
} from "../src/bridge/protocol.ts";
import type { ComputerDirectory, ComputerRow } from "../src/bridge/store.ts";

class MemoryDirectory implements ComputerDirectory {
  readonly rows: ComputerRow[] = [];

  byTokenHash(hash: string): ComputerRow | undefined {
    return this.rows.find((row) => row.tokenHash === hash);
  }

  list(): ComputerRow[] {
    return this.rows.filter((row) => row.revokedAt === null);
  }

  insert(input: { name: string; tokenHash: string }): ComputerRow {
    const row: ComputerRow = {
      id: `c${this.rows.length + 1}`,
      name: input.name,
      tokenHash: input.tokenHash,
      localRoot: "",
      terminalsFolder: "",
      createdAt: this.rows.length + 1,
      revokedAt: null,
      lastSeenAt: null,
      policy: "ask_risky",
      screen: { kind: "none" }
    };
    this.rows.push(row);
    return row;
  }

  revoke(id: string): ComputerRow | undefined {
    const row = this.rows.find((item) => item.id === id);
    if (!row || row.revokedAt !== null) return row;
    const next = { ...row, revokedAt: 1 };
    this.rows[this.rows.indexOf(row)] = next;
    return next;
  }

  setPolicy(id: string, policy: ComputerRow["policy"]): boolean {
    const index = this.rows.findIndex((row) => row.id === id);
    const row = this.rows[index];
    if (!row) return false;
    this.rows[index] = { ...row, policy };
    return true;
  }

  setScreen(id: string, grant: ComputerRow["screen"]): void {
    const index = this.rows.findIndex((row) => row.id === id);
    const row = this.rows[index];
    if (row) this.rows[index] = { ...row, screen: grant };
  }

  markSeen(
    id: string,
    patch: { name?: string; localRoot?: string; terminalsFolder?: string; seenAt: number }
  ): void {
    const index = this.rows.findIndex((row) => row.id === id);
    const row = this.rows[index];
    if (!row) return;
    this.rows[index] = {
      ...row,
      name: patch.name?.trim() || row.name,
      localRoot: patch.localRoot ?? row.localRoot,
      terminalsFolder: patch.terminalsFolder ?? row.terminalsFolder,
      lastSeenAt: patch.seenAt
    };
  }
}

class FakeSocket implements BridgeSocket {
  readyState = 1;
  attachment: unknown = null;
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed = { code, reason };
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  setState(state: unknown): unknown {
    const current = this.attachment && typeof this.attachment === "object" ? this.attachment : {};
    this.attachment = { ...current, __user: state };
    return state;
  }
}

function request(token: string): Request {
  return new Request("http://localhost/api/bridge", {
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function harness() {
  let now = 1_000_000;
  const sockets: FakeSocket[] = [];
  const directory = new MemoryDirectory();
  const hub = new ComputerBridge({
    directory,
    sockets: () => sockets,
    now: () => now,
    heartbeatAt: () => null
  });
  const token = "pbd_desk";
  const row = directory.insert({ name: "书房", tokenHash: await tokenHash(token) });
  const connect = async (device = token) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    await hub.onConnect(socket, request(device));
    return socket;
  };
  const hello = async (socket: FakeSocket, name = "书房") => {
    await hub.onMessage(
      socket,
      JSON.stringify({
        type: "hello",
        protocol: 1,
        computerId: row.id,
        name,
        localRoot: "/Users/me",
        terminalsFolder: "/Users/me/.pupu/terminals"
      })
    );
  };
  return {
    hub,
    directory,
    row,
    connect,
    hello,
    setNow(value: number) {
      now = value;
    },
    now: () => now
  };
}

/** 桥收到某种帧时怎么回。 */
function answer(env: { hub: ComputerBridge }, socket: FakeSocket, on: string, reply: (requestId: string) => object[]) {
  socket.send = (data: string) => {
    socket.sent.push(data);
    const frame = JSON.parse(data) as { type?: string; requestId?: string };
    if (frame.type !== on || !frame.requestId) return;
    for (const up of reply(frame.requestId)) void env.hub.onMessage(socket, JSON.stringify(up));
  };
}

function sentTypes(socket: FakeSocket): string[] {
  return socket.sent.flatMap((raw) => {
    try {
      const value = JSON.parse(raw) as { type?: string };
      return value.type ? [value.type] : [];
    } catch {
      return [];
    }
  });
}

describe("电脑桥", { concurrency: 1 }, () => {
test("凭据不对或已吊销就关掉", async () => {
  const { hub, connect, directory, row } = await harness();
  const bad = await connect("nope");
  assert.equal(bad.closed?.code, REJECT_CODE);
  directory.revoke(row.id);
  const revoked = await connect();
  assert.equal(revoked.closed?.code, REJECT_CODE);
  assert.match(revoked.closed?.reason ?? "", /吊销/);
});

test("hello 之后这台电脑在线，心跳停了就变旧", async () => {
  const env = await harness();
  const socket = await env.connect();
  assert.equal(socket.sent[0], JSON.stringify({ type: "welcome" }));
  assert.equal(env.hub.list()[0]?.online, false);
  await env.hello(socket, "书房电脑");
  assert.equal(env.hub.list()[0]?.online, true);
  assert.equal(env.hub.list()[0]?.name, "书房电脑");
  env.setNow(env.now() + STALE_MS + 1);
  const view = env.hub.list()[0];
  assert.equal(view?.online, false);
  assert.equal(view?.stale, true);
  await env.hub.onMessage(socket, BRIDGE_PING);
  assert.equal(socket.sent.at(-1), "pupu:pong");
  assert.equal(env.hub.list()[0]?.online, true);
});

test("已经有一条健康连接时，后来的让开", async () => {
  const env = await harness();
  const first = await env.connect();
  await env.hello(first);
  const second = await env.connect();
  await env.hello(second);
  assert.equal(second.closed?.code, ALREADY_CONNECTED_CODE);
  assert.equal(first.readyState, 1);
  assert.equal(env.hub.list().filter((computer) => computer.online).length, 1);
});

test("前台命令把输出收回来；多台在线要指定", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hello(socket);
  socket.send = (data: string) => {
    socket.sent.push(data);
    const frame = JSON.parse(data) as { type?: string; requestId?: string };
    if (frame.type !== "exec" || !frame.requestId) return;
    const requestId = frame.requestId;
    void env.hub.onMessage(
      socket,
      JSON.stringify({ type: "started", requestId, commandId: "cmd-1", outputPath: "/tmp/cmd-1.log" })
    );
    void env.hub.onMessage(socket, JSON.stringify({ type: "output", requestId, text: "hello\n" }));
    void env.hub.onMessage(socket, JSON.stringify({ type: "exit", requestId, code: 0 }));
  };
  const chunks: string[] = [];
  const result = await env.hub.exec({
    requestId: "run-1",
    action: { kind: "run", command: "echo hello", background: false },
    onOutput: (chunk) => chunks.push(chunk)
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /退出码 0/);
  assert.match(result.text, /hello/);
  assert.deepEqual(chunks, ["hello\n"]);

  const laptop = env.directory.insert({ name: "笔记本", tokenHash: await tokenHash("pbd_laptop") });
  const other = new FakeSocket();
  const sockets = [socket, other];
  const hub = new ComputerBridge({
    directory: env.directory,
    sockets: () => sockets.filter((item) => item.readyState === 1),
    now: () => env.now(),
    heartbeatAt: () => null
  });
  await hub.onConnect(other, request("pbd_laptop"));
  await hub.onMessage(
    other,
    JSON.stringify({
      type: "hello",
      protocol: 1,
      computerId: laptop.id,
      name: "笔记本",
      localRoot: "/Users/me",
      terminalsFolder: "/Users/me/.pupu/terminals"
    })
  );
  const ambiguous = await hub.exec({
    requestId: "run-2",
    action: { kind: "run", command: "echo hi", background: false }
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.text, /请指定 computer_id/);
});

test("发出去的调用记在 running 里，回完就清掉", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hello(socket);
  let changes = 0;
  env.hub.onActivity = () => {
    changes += 1;
  };
  let reply: (() => void) | null = null;
  socket.send = (data: string) => {
    socket.sent.push(data);
    const frame = JSON.parse(data) as { type?: string; requestId?: string };
    if (frame.type !== "exec" || !frame.requestId) return;
    const requestId = frame.requestId;
    reply = () => void env.hub.onMessage(socket, JSON.stringify({ type: "listed", requestId, entries: [], truncated: false }));
  };
  const listing = env.hub.exec({ requestId: "list-1", action: { kind: "list", path: "" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.hub.running(), [
    { callId: "list-1", computerId: env.row.id, action: { kind: "list", path: "" }, startedAt: env.now() }
  ]);
  assert.equal(changes, 1);
  assert.ok(reply);
  (reply as () => void)();
  await listing;
  assert.deepEqual(env.hub.running(), []);
  assert.equal(changes, 2);
});

test("取消时桥确认没动手，就说没做", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hello(socket);
  answer(env, socket, "cancel", (requestId) => [{ type: "cancelled", requestId }]);
  const controller = new AbortController();
  const pending = env.hub.exec({
    requestId: "run-abort",
    action: { kind: "run", command: "sleep 10", background: false },
    signal: controller.signal
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.text, /取消了，没有做/);
});

test("取消发出去桥没确认，照实说可能已经做了", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hello(socket);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const controller = new AbortController();
    const pending = env.hub.exec({
      requestId: "run-abort",
      action: { kind: "run", command: "sleep 10", background: false },
      signal: controller.signal
    });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentTypes(socket).includes("cancel"), true);
    mock.timers.tick(CANCEL_CONFIRM_MS);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.text, /没有确认，这一步可能已经做了/);
  } finally {
    mock.timers.reset();
  }
});

test("取消的时候已经做完了，结果照样交回去", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hello(socket);
  answer(env, socket, "cancel", (requestId) => [
    { type: "listed", requestId, entries: [{ name: "a.txt", kind: "file" }], truncated: false }
  ]);
  const controller = new AbortController();
  const pending = env.hub.exec({ requestId: "list-late", action: { kind: "list", path: "" }, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.match(result.text, /取消的时候这一步已经做完了/);
  assert.match(result.text, /a\.txt/);
});

test("第一帧没来就停掉这次请求", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hello(socket);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const quiet = env.hub.exec({
      requestId: "run-quiet",
      action: { kind: "read", path: "a.txt", maxBytes: 10 }
    });
    await Promise.resolve();
    mock.timers.tick(FIRST_BYTE_MS);
    const timed = await quiet;
    assert.equal(timed.ok, false);
    assert.match(timed.text, /没有回应/);
    assert.equal(sentTypes(socket).includes("cancel"), true);
  } finally {
    mock.timers.reset();
  }
});

test("用户在电脑上停掉的命令，照实告诉模型，不说转后台", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hello(socket);
  answer(env, socket, "exec", (requestId) => [
    { type: "started", requestId, commandId: "cmd-1", outputPath: "/tmp/cmd-1.log" },
    { type: "output", requestId, text: "working\n" },
    { type: "exit", requestId, code: 143, stopped: "user" }
  ]);
  const result = await env.hub.exec({
    requestId: "run-stopped",
    action: { kind: "run", command: "npm run build", background: false }
  });
  assert.match(result.text, /被用户在电脑上停掉了/);
  assert.match(result.text, /working/);
  assert.doesNotMatch(result.text, /后台/);
});

test("协议版本对不上的 hello 关掉，并说明是版本旧了", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hub.onMessage(
    socket,
    JSON.stringify({
      type: "hello",
      protocol: 99,
      computerId: env.row.id,
      name: "书房",
      localRoot: "/Users/me",
      terminalsFolder: "/Users/me/.pupu/terminals"
    })
  );
  assert.deepEqual(socket.closed, { code: OUTDATED_CODE, reason: "outdated" });
  assert.equal(env.hub.list()[0]?.online, false);
});

test("被替换的旧连接晚些才关，新连接上的远程桌面不停", async () => {
  const env = await harness();
  const phones: FakeSocket[] = [];
  const desktop = new RemoteDesktopHub({
    sockets: () => phones,
    deviceOf: () => "phone",
    toBridge: (computerId, session, message) => env.hub.sendDesktop(computerId, session, message),
    mayView: () => true,
    iceServers: async () => [],
    deviceName: (device) => device ?? "",
    newSession: () => "s1"
  });
  env.hub.onGone = (computerId) => desktop.bridgeGone(computerId);

  const old = await env.connect();
  await env.hello(old);
  env.setNow(env.now() + STALE_MS + 1);
  const fresh = await env.connect();
  await env.hello(fresh);
  assert.equal(old.closed?.reason, "replaced");

  const phone = new FakeSocket();
  phones.push(phone);
  await desktop.onConnect(phone, new Request(`https://pupu.example/api/desktop/${env.row.id}`));
  await desktop.onMessage(phone, JSON.stringify({ type: "start", quality: "auto" }));
  assert.equal(sentTypes(phone).at(-1), "lease");

  env.hub.onClose(old);
  assert.equal(sentTypes(phone).includes("ended"), false);
  assert.equal(env.hub.list()[0]?.online, true);

  fresh.close(1006, "");
  env.hub.onClose(fresh);
  assert.match(phone.sent.at(-1) ?? "", /"ended".*"offline"/);
});

test("前台到时间改为后台，不杀进程", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hello(socket);
  socket.send = (data: string) => {
    socket.sent.push(data);
    const frame = JSON.parse(data) as { type?: string; requestId?: string };
    if (frame.type !== "exec" || !frame.requestId) return;
    void env.hub.onMessage(
      socket,
      JSON.stringify({
        type: "started",
        requestId: frame.requestId,
        commandId: "cmd-slow",
        outputPath: "/tmp/slow.log"
      })
    );
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = env.hub.exec({
      requestId: "run-slow",
      timeoutMs: 1000,
      action: { kind: "run", command: "sleep 100", background: false }
    });
    await Promise.resolve();
    mock.timers.tick(1000);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.match(result.text, /继续在后台跑/);
    assert.equal(sentTypes(socket).includes("detach"), true);
    assert.equal(sentTypes(socket).includes("cancel"), false);
  } finally {
    mock.timers.reset();
  }
});
});

describe("电脑那边晚些才有的消息", () => {
  test("报了有人在用：列表里在线的电脑带上 inUse，没变不再通知", async () => {
    const env = await harness();
    const socket = await env.connect();
    await env.hello(socket);
    assert.equal(env.hub.list()[0]?.inUse, undefined, "老的桥不报，就没有这一项");
    let changes = 0;
    env.hub.onChange = () => (changes += 1);
    await env.hub.onMessage(socket, JSON.stringify({ type: "presence", active: true }));
    await env.hub.onMessage(socket, JSON.stringify({ type: "presence", active: true }));
    assert.equal(env.hub.list()[0]?.inUse, true);
    assert.equal(changes, 1);
    await env.hub.onMessage(socket, JSON.stringify({ type: "presence", active: false }));
    assert.equal(env.hub.list()[0]?.inUse, false);
  });

  test("指定的电脑离线：报给 onUnavailable，带上是哪台", async () => {
    const env = await harness();
    const unavailable: [string, string | null][] = [];
    env.hub.onUnavailable = (requestId, computerId) => unavailable.push([requestId, computerId]);
    const result = await env.hub.exec({
      requestId: "r1",
      computerId: env.row.id,
      action: { kind: "run", command: "ls", background: false }
    });
    assert.equal(result.ok, false);
    assert.deepEqual(unavailable, [["r1", env.row.id]]);
  });

  test("没指定、一台都不在线：等随便哪台", async () => {
    const env = await harness();
    const unavailable: [string, string | null][] = [];
    env.hub.onUnavailable = (requestId, computerId) => unavailable.push([requestId, computerId]);
    await env.hub.exec({ requestId: "r2", action: { kind: "run", command: "ls", background: false } });
    assert.deepEqual(unavailable, [["r2", null]]);
  });

  test("没有这台电脑不算离线，不等", async () => {
    const env = await harness();
    let called = false;
    env.hub.onUnavailable = () => (called = true);
    await env.hub.exec({ requestId: "r3", computerId: "nope", action: { kind: "run", command: "ls", background: false } });
    assert.equal(called, false);
  });

  test("后台命令开始了：报给 onDetached；退出时的 finished 交给 onFinished", async () => {
    const env = await harness();
    const socket = await env.connect();
    await env.hello(socket);
    answer(env, socket, "exec", (requestId) => [
      { type: "started", requestId, commandId: "cmd-1", outputPath: "/tmp/cmd-1.log" }
    ]);
    const detached: [string, string, string][] = [];
    env.hub.onDetached = (requestId, computerId, command) => detached.push([requestId, computerId, command]);
    const result = await env.hub.exec({
      requestId: "bg-1",
      action: { kind: "run", command: "npm run build", background: true }
    });
    assert.equal(result.ok, true);
    assert.deepEqual(detached, [["bg-1", env.row.id, "npm run build"]]);

    const finished: [string, string, number | null][] = [];
    env.hub.onFinished = (computerId, frame) => finished.push([computerId, frame.requestId, frame.code]);
    await env.hub.onMessage(
      socket,
      JSON.stringify({
        type: "finished",
        requestId: "bg-1",
        commandId: "cmd-1",
        command: "npm run build",
        code: 0,
        outputPath: "/tmp/cmd-1.log",
        tail: "built"
      })
    );
    assert.deepEqual(finished, [[env.row.id, "bg-1", 0]]);
  });

  test("还没 hello 的连接发来的 finished 不认", async () => {
    const env = await harness();
    const socket = await env.connect();
    let called = false;
    env.hub.onFinished = () => (called = true);
    await env.hub.onMessage(
      socket,
      JSON.stringify({ type: "finished", requestId: "x", commandId: "c", command: "ls", code: 0, outputPath: "/tmp/x", tail: "" })
    );
    assert.equal(called, false);
  });

test("旧桥没报 browser 能力：浏览器动作不发下去，直接说要更新", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hello(socket);
  assert.equal(env.hub.list()[0]?.browser, undefined);
  const result = await env.hub.exec({ requestId: "b-old", action: { kind: "browser", op: "look" } });
  assert.equal(result.ok, false);
  assert.match(result.text, /0\.2\.4/);
  assert.equal(sentTypes(socket).includes("exec"), false);
});

test("报了 browser 能力：浏览器动作发下去，慢页面超过 10 秒也照样等结果", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hub.onMessage(
    socket,
    JSON.stringify({
      type: "hello",
      protocol: 1,
      computerId: env.row.id,
      name: "书房",
      localRoot: "/Users/me",
      terminalsFolder: "/Users/me/.pupu/terminals",
      capabilities: ["browser"]
    })
  );
  assert.equal(env.hub.list()[0]?.browser, true);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = env.hub.exec({ requestId: "b-slow", action: { kind: "browser", op: "open", url: "https://example.com/" } });
    await Promise.resolve();
    mock.timers.tick(FIRST_BYTE_MS + 5_000);
    await Promise.resolve();
    assert.equal(sentTypes(socket).includes("cancel"), false);
    await env.hub.onMessage(socket, JSON.stringify({ type: "data", requestId: "b-slow", bytes: 4, text: "页面" }));
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.text, "页面");
  } finally {
    mock.timers.reset();
  }
});

test("浏览器画面：报了 browser 能力的桥发来才转，旧桥发来不认", async () => {
  const frame = { type: "browser-frame", jpeg: "QUJD", width: 960, height: 600, url: "https://a.test/", title: "A", at: 1 };
  const env = await harness();
  const seen: string[] = [];
  env.hub.onBrowserFrame = (computerId, got) => seen.push(`${computerId}:${got.url}`);
  const old = await env.connect();
  await env.hello(old);
  await env.hub.onMessage(old, JSON.stringify(frame));
  assert.deepEqual(seen, []);
  const fresh = await harness();
  fresh.hub.onBrowserFrame = env.hub.onBrowserFrame;
  const socket = await fresh.connect();
  await fresh.hub.onMessage(
    socket,
    JSON.stringify({
      type: "hello",
      protocol: 1,
      computerId: fresh.row.id,
      name: "书房",
      localRoot: "/Users/me",
      terminalsFolder: "/Users/me/.pupu/terminals",
      capabilities: ["browser"]
    })
  );
  await fresh.hub.onMessage(socket, JSON.stringify(frame));
  assert.deepEqual(seen, [`${fresh.row.id}:https://a.test/`]);
});
});
