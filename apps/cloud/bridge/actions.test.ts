import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cancelCall, perform, reconcileRequests, stopCommands, type ActionHost } from "./actions.ts";
import type { UpFrame } from "../src/bridge/protocol.ts";

process.env.SHELL = "/bin/sh";

function hostIn(root: string, frames: UpFrame[]): ActionHost {
  return {
    root,
    terminals: path.join(root, "terminals"),
    requests: path.join(root, "requests"),
    blocked: [path.join(root, ".pupu", "bridge.json")],
    send(frame) {
      frames.push(frame);
    }
  };
}

async function workspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pupu-actions-"));
}

async function waitFor(ready: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 4_000) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等太久：${label}`);
}

test("读写和列目录限制在主目录里", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames: UpFrame[] = [];
  const host = hostIn(root, frames);
  await perform("write-1", { kind: "write", path: "notes/a.txt", content: "你好" }, host);
  const wrote = frames.at(-1);
  assert.equal(wrote?.type, "done");
  if (wrote?.type === "done") assert.equal(await readFile(wrote.path ?? "", "utf8"), "你好");

  frames.length = 0;
  await perform("read-1", { kind: "read", path: "notes/a.txt", maxBytes: 100 }, host);
  const data = frames.at(-1);
  assert.equal(data?.type, "data");
  if (data?.type === "data") assert.equal(data.text, "你好");

  frames.length = 0;
  await perform("list-1", { kind: "list", path: "" }, host);
  const listed = frames.at(-1);
  assert.equal(listed?.type, "listed");
  if (listed?.type === "listed") {
    assert.equal(listed.entries[0]?.name, "notes");
    assert.equal(listed.entries[0]?.kind, "dir");
  }

  frames.length = 0;
  await perform("read-out", { kind: "read", path: "../secret", maxBytes: 20 }, host);
  const denied = frames.at(-1);
  assert.equal(denied?.type, "error");
  if (denied?.type === "error") assert.match(denied.message, /主目录/);

  frames.length = 0;
  await perform("read-missing", { kind: "read", path: "missing.txt", maxBytes: 20 }, host);
  const missing = frames.at(-1);
  assert.equal(missing?.type, "error");
  if (missing?.type === "error") assert.match(missing.message, /没有这个文件/);
});

test("前台命令把输出送回来，同一请求不跑第二遍", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames: UpFrame[] = [];
  const host = hostIn(root, frames);
  await perform("echo-1", { kind: "run", command: "echo hello", background: false }, host);
  await waitFor(() => frames.some((frame) => frame.type === "exit"), "exit");
  const started = frames.find((frame) => frame.type === "started");
  assert.equal(started?.type, "started");
  const output = frames.filter((frame) => frame.type === "output").map((frame) => frame.text).join("");
  assert.match(output, /hello/);
  const exit = frames.find((frame) => frame.type === "exit");
  assert.equal(exit?.type, "exit");
  if (exit?.type === "exit") assert.equal(exit.code, 0);
  if (started?.type !== "started") return;
  const log = await readFile(started.outputPath, "utf8");
  assert.match(log, /\$ echo hello/);
  assert.match(log, /hello/);
  assert.match(log, /--- exit 0 ---/);

  const again: UpFrame[] = [];
  await perform("echo-1", { kind: "run", command: "echo hello", background: false }, hostIn(root, again));
  assert.equal(again.some((frame) => frame.type === "started"), true);
  assert.equal(again.some((frame) => frame.type === "exit"), true);
  const logAfter = await readFile(started.outputPath, "utf8");
  assert.equal(logAfter.split("$ echo hello").length, 2);
});

test("后台命令不往连接上送输出，取消会停掉进程", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames: UpFrame[] = [];
  const host = hostIn(root, frames);
  t.after(() => cancelCall("bg-1"));
  await perform("bg-1", { kind: "run", command: "echo background-out && sleep 30", background: true }, host);
  const started = frames.find((frame) => frame.type === "started");
  assert.equal(started?.type, "started");
  assert.equal(frames.some((frame) => frame.type === "output" || frame.type === "exit"), false);
  if (started?.type !== "started") return;
  await waitFor(
    async () => (await readFile(started.outputPath, "utf8")).includes("\nbackground-out"),
    "background output"
  );
  cancelCall("bg-1");
  await waitFor(async () => (await readFile(started.outputPath, "utf8")).includes("--- exit"), "killed");
  assert.equal(frames.some((frame) => frame.type === "exit"), false);
});

test("能往还在跑的命令写标准输入", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames: UpFrame[] = [];
  const host = hostIn(root, frames);
  t.after(() => cancelCall("cat-1"));
  await perform("cat-1", { kind: "run", command: "cat", background: true }, host);
  const started = frames.find((frame) => frame.type === "started");
  assert.equal(started?.type, "started");
  if (started?.type !== "started") return;
  const stdin: UpFrame[] = [];
  await perform(
    "stdin-1",
    { kind: "stdin", commandId: started.commandId, data: "line\n", eof: true },
    hostIn(root, stdin)
  );
  assert.equal(stdin.at(-1)?.type, "done");
  await waitFor(async () => (await readFile(started.outputPath, "utf8")).includes("line"), "stdin output");
  await waitFor(async () => (await readFile(started.outputPath, "utf8")).includes("--- exit"), "cat exit");
});

test("二进制文件不按文本读", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
  const frames: UpFrame[] = [];
  await perform("read-bin", { kind: "read", path: "bin.dat", maxBytes: 20 }, hostIn(root, frames));
  const frame = frames.at(-1);
  assert.equal(frame?.type, "data");
  if (frame?.type === "data") {
    assert.equal(frame.binary, true);
    assert.equal(frame.text, undefined);
  }
});

test("动手之前取消的命令不跑，回 cancelled，再送来也照这样回", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const action = { kind: "run", command: "touch marker", background: false } as const;
  const frames: UpFrame[] = [];
  const pending = perform("early-run", action, hostIn(root, frames));
  cancelCall("early-run");
  await pending;
  assert.deepEqual(frames.map((frame) => frame.type), ["cancelled"]);
  await assert.rejects(access(path.join(root, "marker")));

  const again: UpFrame[] = [];
  await perform("early-run", action, hostIn(root, again));
  assert.deepEqual(again.map((frame) => frame.type), ["cancelled"]);
  await assert.rejects(access(path.join(root, "marker")));
});

test("动手之前取消的写文件不写", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames: UpFrame[] = [];
  const pending = perform("early-write", { kind: "write", path: "b.txt", content: "x" }, hostIn(root, frames));
  cancelCall("early-write");
  await pending;
  assert.deepEqual(frames.map((frame) => frame.type), ["cancelled"]);
  await assert.rejects(access(path.join(root, "b.txt")));
});

test("菜单栏停掉的前台命令，退出那一帧说是用户停的", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames: UpFrame[] = [];
  await perform("menubar-stop", { kind: "run", command: "sleep 30", background: false }, hostIn(root, frames));
  assert.equal(frames[0]?.type, "started");
  stopCommands();
  await waitFor(() => frames.some((frame) => frame.type === "exit"), "exit");
  const exit = frames.find((frame) => frame.type === "exit");
  assert.equal(exit?.type === "exit" ? exit.stopped : undefined, "user");
});

test("云端取消在跑的前台命令，退出那一帧说是云端停的", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames: UpFrame[] = [];
  await perform("cloud-stop", { kind: "run", command: "sleep 30", background: false }, hostIn(root, frames));
  cancelCall("cloud-stop");
  await waitFor(() => frames.some((frame) => frame.type === "exit"), "exit");
  const exit = frames.find((frame) => frame.type === "exit");
  assert.equal(exit?.type === "exit" ? exit.stopped : undefined, "cloud");
});

test("桥上次做到一半退出了，重放时说不知道做完没有，不再做一遍", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = path.join(root, "requests");
  await mkdir(requests, { recursive: true });
  const outputPath = path.join(root, "terminals", "crashed.log");
  await writeFile(
    path.join(requests, "crashed.json"),
    JSON.stringify({ status: "running", kind: "run", commandId: "crashed", outputPath })
  );
  await reconcileRequests(requests);
  const frames: UpFrame[] = [];
  await perform("crashed", { kind: "run", command: "touch marker", background: false }, hostIn(root, frames));
  assert.equal(frames.length, 1);
  const frame = frames[0];
  assert.equal(frame?.type, "error");
  if (frame?.type === "error") {
    assert.match(frame.message, /桥退出了/);
    assert.ok(frame.message.includes(outputPath));
  }
  await assert.rejects(access(path.join(root, "marker")));
});
