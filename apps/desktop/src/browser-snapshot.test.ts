import assert from "node:assert/strict";
import { test } from "node:test";
import { HIDDEN_VALUE, renderSnapshot, type AXNode } from "./browser-snapshot.ts";

const v = (value: unknown) => ({ value });
const nodes: AXNode[] = [
  { nodeId: "1", role: v("RootWebArea"), name: v("页"), childIds: ["2", "3", "5", "7", "9"] },
  { nodeId: "2", role: v("heading"), name: v("标题"), childIds: ["2a"] },
  { nodeId: "2a", role: v("StaticText"), name: v("标题") },
  { nodeId: "3", role: v("paragraph"), childIds: ["3a", "3b"] },
  { nodeId: "3a", role: v("StaticText"), name: v("计数：") },
  { nodeId: "3b", role: v("StaticText"), name: v("  1 ") },
  { nodeId: "5", role: v("button"), name: v("加一"), backendDOMNodeId: 10, childIds: ["5a"] },
  { nodeId: "5a", role: v("StaticText"), name: v("加一") },
  { nodeId: "7", ignored: true, childIds: ["8"] },
  { nodeId: "8", role: v("textbox"), name: v("名字"), value: v("小猫"), backendDOMNodeId: 13, properties: [{ name: "focused", value: v(true) }] },
  { nodeId: "9", role: v("generic"), childIds: ["9a"] },
  { nodeId: "9a", role: v("StaticText"), name: v("   ") }
];

test("快照：标题一行、正文合并、控件带编号且不重复打印自己的文字", () => {
  assert.equal(renderSnapshot(nodes), ['## 标题', "计数： 1", '[10] button "加一"', '[13] textbox "名字" = "小猫" (focused)'].join("\n"));
});

test("快照：query 只留匹配的行，没有匹配时说清楚", () => {
  assert.equal(renderSnapshot(nodes, "名字"), '[13] textbox "名字" = "小猫" (focused)');
  assert.match(renderSnapshot(nodes, "不存在"), /没有找到/);
});

test("快照：敏感输入框的值不给模型看（页面认出来的、按名字认的都算），框里的子文字也不漏", () => {
  const page: AXNode[] = [
    { nodeId: "1", role: v("RootWebArea"), name: v("登录"), childIds: ["2", "3", "4"] },
    { nodeId: "2", role: v("textbox"), name: v("邮箱"), value: v("xiaomao@example.com"), backendDOMNodeId: 20 },
    { nodeId: "3", role: v("textbox"), name: v("短信验证码"), value: v("482913"), backendDOMNodeId: 21, childIds: ["3a"] },
    { nodeId: "3a", role: v("StaticText"), name: v("482913") },
    { nodeId: "4", role: v("textbox"), name: v("口令"), value: v("hunter2"), backendDOMNodeId: 22 }
  ];
  const out = renderSnapshot(page, undefined, new Set([22]));
  assert.ok(!out.includes("482913") && !out.includes("hunter2"), out);
  assert.ok(out.includes(`[21] textbox "短信验证码" = "${HIDDEN_VALUE}"`), out);
  assert.ok(out.includes(`[22] textbox "口令" = "${HIDDEN_VALUE}"`), out);
  assert.ok(out.includes('"xiaomao@example.com"'), out);
  assert.equal(renderSnapshot(page, "482913"), "没有找到包含「482913」的内容。");
});

test("快照：按名字认敏感框要整词，「Passenger name」「laptop」照常显示", () => {
  const page: AXNode[] = [
    { nodeId: "1", role: v("RootWebArea"), childIds: ["2", "3", "4"] },
    { nodeId: "2", role: v("textbox"), name: v("Passenger name"), value: v("Xiao Mao"), backendDOMNodeId: 30 },
    { nodeId: "3", role: v("textbox"), name: v("Your laptop model"), value: v("MacBook"), backendDOMNodeId: 31 },
    { nodeId: "4", role: v("textbox"), name: v("Enter OTP"), value: v("123456"), backendDOMNodeId: 32 }
  ];
  const out = renderSnapshot(page);
  assert.ok(out.includes('"Xiao Mao"') && out.includes('"MacBook"'), out);
  assert.ok(!out.includes("123456"), out);
});
