import assert from "node:assert/strict";
import { test } from "node:test";
import { browse, receiveBrowserReply, useBrowserHost, type BrowserRequest } from "./browser.ts";

test("浏览器：请求按 id 回包，超时的回包丢掉", async () => {
  const sent: BrowserRequest[] = [];
  useBrowserHost((request) => sent.push(request));
  const first = browse({ op: "read" });
  const second = browse({ op: "look" }, 20);
  assert.equal(sent.length, 2);
  assert.equal(await second.then((result) => result.ok), false);
  receiveBrowserReply({ type: "browser-result", id: sent[1]!.id, result: { ok: true, text: "晚了", url: "" } });
  receiveBrowserReply({ type: "browser-result", id: sent[0]!.id, result: { ok: true, text: "页面", url: "https://a.test/" } });
  assert.deepEqual(await first, { ok: true, text: "页面", url: "https://a.test/" });
});
