import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  DESKTOP_EXPIRE_MS,
  RemoteDesktopHub,
  computerIdOfPath,
  iceServersFrom,
  mayViewDesktop,
  parseInput,
  parsePhoneMessage,
  type DesktopDown
} from "../src/bridge/desktop.ts";
import { parseDownFrame, parseUpFrame } from "../src/bridge/protocol.ts";
import { RemoteAgent, type CaptureCommand } from "./remote.ts";

/** 假的手机连接：记下收到的消息。 */
function phone() {
  const sent: Record<string, unknown>[] = [];
  let state: unknown = null;
  return {
    sent,
    closed: false,
    readyState: 1,
    send(data: string) {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    close() {
      this.closed = true;
    },
    deserializeAttachment: () => ({ __user: state }),
    setState(value: unknown) {
      state = value;
      return value;
    },
    last(type: string) {
      return [...sent].reverse().find((message) => message.type === type);
    }
  };
}

function hub(options: { online?: boolean; allowed?: boolean } = {}) {
  const sockets: ReturnType<typeof phone>[] = [];
  const toBridge: { session: string; message: DesktopDown }[] = [];
  let seq = 0;
  const desktop = new RemoteDesktopHub({
    sockets: () => sockets,
    deviceOf: (request) => request.headers.get("x-device"),
    toBridge: (_computer, session, message) => {
      toBridge.push({ session, message });
      return options.online !== false;
    },
    mayView: () => options.allowed !== false,
    iceServers: async () => [{ urls: ["stun:example"] }],
    deviceName: (device) => `手机 ${device}`,
    newSession: () => `s${++seq}`
  });
  const connect = async (device: string) => {
    const socket = phone();
    sockets.push(socket);
    await desktop.onConnect(
      socket,
      new Request("https://pupu.example/api/desktop/c1", { headers: { "x-device": device } })
    );
    return socket;
  };
  return { desktop, connect, toBridge };
}

describe("远程桌面的租约", () => {
  test("开始时把 ICE 发给两边", async () => {
    const { desktop, connect, toBridge } = hub();
    const socket = await connect("a");
    await desktop.onMessage(socket, JSON.stringify({ type: "start", quality: "hd" }));
    assert.equal(socket.last("lease")?.session, "s1");
    assert.deepEqual(toBridge[0], {
      session: "s1",
      message: { type: "start", iceServers: [{ urls: ["stun:example"] }], quality: "hd" }
    });
  });

  test("有人在看时不抢，说清是谁；明说接管才换人", async () => {
    const { desktop, connect, toBridge } = hub();
    const first = await connect("a");
    const second = await connect("b");
    await desktop.onMessage(first, JSON.stringify({ type: "start" }));
    await desktop.onMessage(second, JSON.stringify({ type: "start" }));
    assert.equal(second.last("busy")?.by, "手机 a");
    assert.equal(second.last("lease"), undefined);
    await desktop.onMessage(second, JSON.stringify({ type: "start", takeover: true }));
    assert.equal(first.last("ended")?.reason, "taken_over");
    assert.equal(second.last("lease")?.session, "s2");
    assert.ok(toBridge.some((item) => item.session === "s1" && item.message.type === "stop"));
  });

  test("没拿到租约的手机发的东西不转", async () => {
    const { desktop, connect, toBridge } = hub();
    const socket = await connect("a");
    await desktop.onMessage(socket, JSON.stringify({ type: "input", event: { t: "release" } }));
    assert.equal(toBridge.length, 0);
  });

  test("旧会话的消息不会发给新的观看者", async () => {
    const { desktop, connect } = hub();
    const socket = await connect("a");
    await desktop.onMessage(socket, JSON.stringify({ type: "start" }));
    desktop.fromBridge("c1", "old", { type: "offer", sdp: "x" });
    assert.equal(socket.last("offer"), undefined);
    desktop.fromBridge("c1", "s1", { type: "offer", sdp: "x" });
    assert.equal(socket.last("offer")?.sdp, "x");
  });

  test("手机断了告诉桥，桥断了告诉手机", async () => {
    const { desktop, connect, toBridge } = hub();
    const socket = await connect("a");
    await desktop.onMessage(socket, JSON.stringify({ type: "start" }));
    desktop.bridgeGone("c1");
    assert.equal(socket.last("ended")?.reason, "offline");
    await desktop.onMessage(socket, JSON.stringify({ type: "start" }));
    desktop.onClose(socket);
    assert.deepEqual(toBridge.at(-1), { session: "s2", message: { type: "stop" } });
  });

  test("电脑不在线时手机马上知道", async () => {
    const { desktop, connect } = hub({ online: false });
    const socket = await connect("a");
    await desktop.onMessage(socket, JSON.stringify({ type: "start" }));
    assert.equal(socket.last("ended")?.reason, "offline");
    assert.equal(socket.last("lease"), undefined);
  });

  test("不让看的连接直接关掉", async () => {
    const { connect } = hub({ allowed: false });
    const socket = await connect("a");
    assert.equal(socket.last("ended")?.reason, "not_allowed");
    assert.equal(socket.closed, true);
  });

  test("地址里的票交给权限判断", async () => {
    const seen: (string | null)[] = [];
    const desktop = new RemoteDesktopHub({
      sockets: () => [],
      deviceOf: () => "b",
      toBridge: () => true,
      mayView: (_device, _computer, ticket) => {
        seen.push(ticket);
        return ticket === "t1";
      },
      iceServers: async () => [],
      deviceName: () => "",
      newSession: () => "s"
    });
    const ok = phone();
    await desktop.onConnect(ok, new Request("https://pupu.example/api/desktop/c1?ticket=t1"));
    const bad = phone();
    await desktop.onConnect(bad, new Request("https://pupu.example/api/desktop/c1"));
    assert.deepEqual(seen, ["t1", null]);
    assert.equal(ok.closed, false);
    assert.equal(bad.last("ended")?.reason, "not_allowed");
  });

  test("网页和电脑 App 要主人刚为这台电脑按过通行密钥", () => {
    assert.equal(mayViewDesktop({ kind: "browser", memberId: "m1" }, "m1", "m1"), true);
    assert.equal(mayViewDesktop({ kind: "desktop", memberId: "m1" }, "m1", "m1"), true);
    assert.equal(mayViewDesktop({ kind: "browser", memberId: "m1" }, "m1", null), false);
    // 票是别人换的、或者不是主人：都不行。
    assert.equal(mayViewDesktop({ kind: "browser", memberId: "m1" }, "m1", "m2"), false);
    assert.equal(mayViewDesktop({ kind: "browser", memberId: "m2" }, "m1", "m2"), false);
    // 没主人的电脑手机能开，网页不行。
    assert.equal(mayViewDesktop({ kind: "browser", memberId: "m1" }, null, "m1"), false);
    assert.equal(mayViewDesktop({ kind: "browser", memberId: null }, null, null), false);
  });

  test("只有主人自己的手机能看", () => {
    assert.equal(mayViewDesktop({ kind: "phone", memberId: "m1" }, "m1"), true);
    assert.equal(mayViewDesktop({ kind: "phone", memberId: "m2" }, "m1"), false);
    assert.equal(mayViewDesktop({ kind: "browser", memberId: "m1" }, "m1"), false);
    assert.equal(mayViewDesktop({ kind: "desktop", memberId: "m1" }, "m1"), false);
    assert.equal(mayViewDesktop({ kind: "phone", memberId: null }, null), true);
    assert.equal(mayViewDesktop(undefined, "m1"), false);
    assert.equal(mayViewDesktop(null, "m1"), true);
  });
});

describe("消息格式", () => {
  test("地址里的电脑 id", () => {
    assert.equal(computerIdOfPath("/api/desktop/c1"), "c1");
    assert.equal(computerIdOfPath("/api/desktop/"), null);
    assert.equal(computerIdOfPath("/api/desktop/c1/x"), null);
    assert.equal(computerIdOfPath("/api/state"), null);
  });

  test("坐标夹到 0 到 1，乱的输入丢掉", () => {
    assert.deepEqual(parseInput({ t: "move", x: 2, y: -1 }), { t: "move", x: 1, y: 0 });
    assert.equal(parseInput({ t: "move", x: "a", y: 0 }), null);
    assert.equal(parseInput({ t: "shell", s: "rm" }), null);
    assert.equal(parseInput({ t: "text", s: "x".repeat(3000) }), null);
    assert.equal(parsePhoneMessage("not json"), null);
  });

  test("帧能穿过桥的协议", () => {
    const down = parseDownFrame(
      JSON.stringify({ type: "desktop", session: "s", message: { type: "start", iceServers: [], quality: "saver" } })
    );
    assert.deepEqual(down, { type: "desktop", session: "s", message: { type: "start", iceServers: [], quality: "saver" } });
    const up = parseUpFrame(JSON.stringify({ type: "desktop", session: "s", message: { type: "ended", reason: "expired" } }));
    assert.deepEqual(up, { type: "desktop", session: "s", message: { type: "ended", reason: "expired" } });
    assert.equal(parseUpFrame(JSON.stringify({ type: "desktop", session: "s", message: { type: "frame", data: "", width: 1, height: 1 } })), null);
  });
});

describe("TURN 凭证", () => {
  test("没配密钥只用 STUN", async () => {
    const servers = await iceServersFrom({});
    assert.deepEqual(servers, [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });

  test("换到凭证，去掉 53 端口", async () => {
    const fetcher = (async () =>
      Response.json({
        iceServers: { urls: ["turn:a:3478", "turn:a:53"], username: "u", credential: "c" }
      })) as unknown as typeof fetch;
    const servers = await iceServersFrom({ TURN_KEY_ID: "k", TURN_KEY_TOKEN: "t" }, fetcher);
    assert.deepEqual(servers, [{ urls: ["turn:a:3478"], username: "u", credential: "c" }]);
  });

  test("换不到时退回 STUN，不让人连不上", async () => {
    const fetcher = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const original = console.warn;
    console.warn = () => {};
    const servers = await iceServersFrom({ TURN_KEY_ID: "k", TURN_KEY_TOKEN: "t" }, fetcher);
    console.warn = original;
    assert.deepEqual(servers, [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });

  test("换凭证卡住时到点退回 STUN，租约不一直占着", async () => {
    // 只在被取消时才结束，模拟 Cloudflare 那边一直不回。
    const fetcher = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const original = console.warn;
    console.warn = () => {};
    // AbortSignal.timeout 的计时器不拖住 Node 的事件循环，测试自己留一个。
    const hold = setTimeout(() => {}, 1_000);
    const servers = await iceServersFrom({ TURN_KEY_ID: "k", TURN_KEY_TOKEN: "t" }, fetcher, 20);
    clearTimeout(hold);
    console.warn = original;
    assert.deepEqual(servers, [{ urls: ["stun:stun.cloudflare.com:3478"] }]);
  });
});

describe("电脑这边的把关", () => {
  function agent(options: { capture?: boolean; allowScreen?: boolean } = {}) {
    let now = 1_000;
    const sent: { session: string; message: Record<string, unknown> }[] = [];
    const commands: CaptureCommand[] = [];
    const inputs: unknown[] = [];
    let stopped = 0;
    let allowScreen = options.allowScreen !== false;
    const remote = new RemoteAgent({
      send: (session, message) => sent.push({ session, message }),
      capture: options.capture === false ? null : (command) => commands.push(command),
      allowScreen: () => allowScreen,
      input: { send: (event) => inputs.push(event), stop: () => (stopped += 1) },
      onChange: () => {},
      now: () => now
    });
    return {
      remote,
      sent,
      commands,
      inputs,
      stopped: () => stopped,
      tick: (ms: number) => (now += ms),
      setScreen: (value: boolean) => (allowScreen = value)
    };
  }
  const start: DesktopDown = { type: "start", iceServers: [], quality: "auto" };
  const click: DesktopDown = { type: "input", event: { t: "down", x: 0.5, y: 0.5 } };

  test("命令行的桥没有推流窗口，照实说", () => {
    const { remote, sent } = agent({ capture: false });
    remote.handle("s", start);
    assert.equal(sent[0]?.message.reason, "needs_app");
    assert.equal(remote.status, null);
  });

  test("本机关了操作屏幕就不开", () => {
    const { remote, sent, commands } = agent({ allowScreen: false });
    remote.handle("s", start);
    assert.equal(sent[0]?.message.reason, "screen_off");
    assert.equal(commands.length, 0);
  });

  test("输入要控制开着、本机允许才注入，DataChannel 来的也一样", () => {
    const { remote, inputs, setScreen } = agent();
    remote.handle("s", start);
    remote.handle("s", click);
    remote.fromCapture({ type: "input", session: "s", event: { t: "release" } });
    assert.equal(inputs.length, 2);
    remote.handle("s", { type: "control", on: false });
    remote.fromCapture({ type: "input", session: "s", event: { t: "release" } });
    assert.equal(inputs.length, 2);
    assert.equal(remote.status, "viewing");
    remote.handle("s", { type: "control", on: true });
    setScreen(false);
    remote.handle("s", click);
    assert.equal(inputs.length, 2);
    remote.stop("stopped");
  });

  test("别的会话的消息不算数", () => {
    const { remote, inputs, commands } = agent();
    remote.handle("s", start);
    remote.handle("old", click);
    remote.fromCapture({ type: "input", session: "old", event: { t: "release" } });
    remote.handle("old", { type: "stop" });
    assert.equal(inputs.length, 0);
    assert.equal(commands.length, 1);
    remote.stop("stopped");
  });

  test("键鼠失灵时收回控制，画面继续", () => {
    const { remote, sent, inputs, commands } = agent();
    remote.handle("s", start);
    remote.inputFailed("没有辅助功能权限");
    assert.deepEqual(sent.at(-1)?.message, { type: "control", on: false, message: "没有辅助功能权限" });
    remote.handle("s", click);
    assert.equal(inputs.length, 0);
    assert.equal(remote.status, "viewing");
    assert.equal(commands.some((command) => command.type === "stop"), false);
    remote.stop("stopped");
  });

  test("结束时松开按键、关掉推流窗口", () => {
    const { remote, commands, stopped, sent } = agent();
    remote.handle("s", start);
    remote.stop("takeback");
    assert.equal(sent.at(-1)?.message.reason, "takeback");
    assert.equal(commands.at(-1)?.type, "stop");
    assert.ok(stopped() >= 1);
    assert.equal(remote.status, null);
  });

  test("心跳过期就停，不靠云端", async () => {
    const { remote, sent, tick } = agent();
    remote.handle("s", start);
    tick(DESKTOP_EXPIRE_MS + 1);
    await new Promise((resolve) => setTimeout(resolve, 3100));
    assert.equal(sent.at(-1)?.message.reason, "expired");
    assert.equal(remote.status, null);
  });
});
