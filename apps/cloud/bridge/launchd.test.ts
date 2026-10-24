import assert from "node:assert/strict";
import test from "node:test";
import { renderPlist } from "./launchd.ts";

test("plist 开机拉起 start，并转义路径", () => {
  const plist = renderPlist("/usr/local/bin/node", "/tmp/a&b<c>.ts", "/tmp/bridge.log");
  assert.match(plist, /<string>com\.pupu\.bridge<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/tmp\/a&amp;b&lt;c&gt;\.ts<\/string>/);
  assert.match(plist, /<string>start<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/tmp\/bridge\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/tmp\/bridge\.log<\/string>/);
});
