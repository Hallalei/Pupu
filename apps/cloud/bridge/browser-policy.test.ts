import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { localRefusal } from "./local.ts";
import { classifyAction, describeAction, isPrivateHost, needFor } from "../src/bridge/policy.ts";
import { parseDownFrame, parseUpFrame, type Action } from "../src/bridge/protocol.ts";
import { actionForCall } from "../src/bridge/calls.ts";

const open = (url: string): Action => ({ kind: "browser", op: "open", url });
const level = (action: Action) => classifyAction(action, "/Users/me").level;
const ON = { allowCommands: true, allowScreen: true };

describe("浏览器的风险", () => {
  test("公开网页、看、点、普通输入是低风险", () => {
    assert.equal(level(open("https://example.com/a?q=1")), "low");
    assert.equal(level({ kind: "browser", op: "look" }), "low");
    assert.equal(level({ kind: "browser", op: "click", ref: 3 }), "low");
    assert.equal(level({ kind: "browser", op: "type", ref: 3, text: "猫" }), "low");
    assert.equal(level({ kind: "browser", op: "key", key: "Tab" }), "low");
  });

  test("本机、内网、file:、下载、提交、回车、sensitive 是高风险", () => {
    for (const url of [
      "http://127.0.0.1:8787/",
      "http://localhost/",
      "http://192.168.1.1/",
      "http://10.0.0.8/",
      "http://172.20.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://nas.local/",
      "http://router/",
      "file:///Users/me/.ssh/id_rsa",
      "chrome://settings",
      "不是网址"
    ]) {
      assert.equal(level(open(url)), "high", url);
    }
    assert.equal(level({ kind: "browser", op: "download", url: "https://example.com/a.pdf" }), "high");
    assert.equal(level({ kind: "browser", op: "type", ref: 3, text: "x", submit: true }), "high");
    assert.equal(level({ kind: "browser", op: "key", key: "Enter" }), "high");
    assert.equal(level({ kind: "browser", op: "click", ref: 3, sensitive: true }), "high");
  });

  test("内网判断只看字面，公网域名和公网 IP 不算", () => {
    assert.equal(isPrivateHost("example.com"), false);
    assert.equal(isPrivateHost("8.8.8.8"), false);
    assert.equal(isPrivateHost("172.32.0.1"), false);
    assert.equal(isPrivateHost("100.100.1.1"), true);
    assert.equal(isPrivateHost("::ffff:192.168.0.2"), true);
  });
});

describe("浏览器的分级", () => {
  test("和命令一个算法：不占屏幕授权，高风险单独问，每步都问时会动页面的也问", () => {
    const opts = { home: "/Users/me", screenGranted: false };
    assert.equal(needFor("ask_risky", open("https://example.com/"), opts).need, "none");
    assert.equal(needFor("ask_risky", open("http://192.168.1.1/"), opts).need, "step");
    assert.equal(needFor("ask_all", open("https://example.com/"), opts).need, "step");
    assert.equal(needFor("ask_all", { kind: "browser", op: "read" }, opts).need, "none");
    assert.equal(needFor("trust", open("http://192.168.1.1/"), opts).need, "none");
  });

  test("桥上再判一次：高风险没带批准就拒", () => {
    assert.match(localRefusal(open("http://127.0.0.1/"), false, ON, "/Users/me") ?? "", /内网/);
    assert.equal(localRefusal(open("http://127.0.0.1/"), true, ON, "/Users/me"), null);
    assert.equal(localRefusal(open("https://example.com/"), false, ON, "/Users/me"), null);
  });

  test("审批卡片说清楚是 Pupu 浏览器", () => {
    assert.deepEqual(describeAction(open("http://192.168.1.1/")), { title: "在 Pupu 浏览器里打开", detail: "http://192.168.1.1/" });
    assert.equal(describeAction({ kind: "browser", op: "type", ref: 3, text: "hi", submit: true, label: "搜索框" }).title, "在 Pupu 浏览器里填写并提交");
  });
});

describe("浏览器的协议", () => {
  test("工具参数换成动作", () => {
    assert.deepEqual(actionForCall("browser_click", { ref: 12, label: "登录", sensitive: true, computer_id: "c1" }), {
      action: { kind: "browser", op: "click", ref: 12, label: "登录", sensitive: true },
      computerId: "c1"
    });
  });

  test("exec 帧认 browser 动作，hello 只收认得的能力", () => {
    const frame = parseDownFrame(JSON.stringify({ type: "exec", requestId: "r1", action: { kind: "browser", op: "look" } }));
    assert.equal(frame?.type, "exec");
    const hello = parseUpFrame(
      JSON.stringify({ type: "hello", protocol: 1, computerId: "c", name: "n", localRoot: "/u", terminalsFolder: "/t", capabilities: ["browser", "flying"] })
    );
    assert.deepEqual(hello && "capabilities" in hello ? hello.capabilities : null, ["browser"]);
    const old = parseUpFrame(JSON.stringify({ type: "hello", protocol: 1, computerId: "c", name: "n", localRoot: "/u", terminalsFolder: "/t" }));
    assert.equal(old && "capabilities" in old, false);
  });
});
