import assert from "node:assert/strict";
import { describe, mock } from "node:test";
import test from "node:test";
import { ComputerBridge, type BridgeSocket } from "../src/bridge/hub.ts";
import {
  ALREADY_CONNECTED_CODE,
  BRIDGE_PING,
  FIRST_BYTE_MS,
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
      lastSeenAt: null
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

test("取消和没回应都会停掉这次请求", async () => {
  const env = await harness();
  const socket = await env.connect();
  await env.hello(socket);
  const controller = new AbortController();
  const pending = env.hub.exec({
    requestId: "run-abort",
    action: { kind: "run", command: "sleep 10", background: false },
    signal: controller.signal
  });
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.ok, false);
  assert.match(aborted.text, /取消/);
  assert.equal(sentTypes(socket).includes("cancel"), true);

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
    assert.equal(sentTypes(socket).filter((type) => type === "cancel").length >= 2, true);
  } finally {
    mock.timers.reset();
  }
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
