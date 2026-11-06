import assert from "node:assert/strict";
import { test } from "node:test";
import { updateFeed } from "./update-feed.ts";

test("清单的当前版本指向一条带下载地址的版本", () => {
  const feed = updateFeed("0.2.0", "https://dl.example.com/Pupu-0.2.0-arm64.zip", new Date("2026-11-05T00:00:00Z"));
  const release = feed.releases.find((it) => it.version === feed.currentRelease);
  assert.equal(release?.updateTo.url, "https://dl.example.com/Pupu-0.2.0-arm64.zip");
  assert.equal(release?.updateTo.name, "0.2.0");
});
