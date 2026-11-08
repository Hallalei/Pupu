import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { OUTDATED_CODE, PROTOCOL_VERSION, REJECT_CODE } from "../src/bridge/protocol.ts";
import { openBridge } from "./session.ts";

/** 本地起一个假云端：先发 welcome，收到 hello 交给 `onHello`。 */
async function cloud(onHello: (socket: WebSocket, hello: { protocol: number }) => void) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "welcome" }));
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { type?: string; protocol?: number };
      if (frame.type === "hello") onHello(socket, { protocol: frame.protocol ?? 0 });
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    config: { url: `http://127.0.0.1:${port}`, computerId: "c1", token: "pbd_test", name: "书房" },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("云端说协议版本旧了，连接按要更新结束，不当成凭据被拒", async (t) => {
  const fake = await cloud((socket) => socket.close(OUTDATED_CODE, "outdated"));
  t.after(fake.close);
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  const connection = openBridge(fake.config, {}, []);
  assert.equal(await connection.done, "outdated");
});

test("云端收下 hello、推来状态之后才算连上，之前不往上发", async (t) => {
  let accept: (() => void) | null = null;
  const fake = await cloud((socket, hello) => {
    assert.equal(hello.protocol, PROTOCOL_VERSION);
    accept = () => socket.send(JSON.stringify({ type: "status", pending: [], screen: false }));
  });
  t.after(fake.close);
  const log = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = log;
  });
  let ready = false;
  const connection = openBridge(fake.config, { onReady: () => (ready = true) }, []);
  while (!accept) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(connection.welcomed(), true);
  assert.equal(connection.send({ type: "takeback" }), false);
  (accept as () => void)();
  while (!ready) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(connection.send({ type: "takeback" }), true);
  connection.close();
  assert.equal(await connection.done, "closed");
});
