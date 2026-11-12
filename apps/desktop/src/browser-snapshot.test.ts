import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSnapshot, type AXNode } from "./browser-snapshot.ts";

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
