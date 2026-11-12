import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { makeFakeChrome } from "../probe/fake-chrome.ts";
import { chromeKey, decryptValue, listProfiles, readChromeCookies } from "./chrome-import.ts";

const NOW = Date.UTC(2026, 10, 12) / 1000;
const LATER = NOW + 86_400;

for (const metaVersion of [23, 24]) {
  test(`假 Chrome 用户资料（meta ${metaVersion}）：解开、换算时间、跳过过期和分区的`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fake-chrome-"));
    try {
      await makeFakeChrome(
        dir,
        "fake-password",
        [
          { host: ".example.com", name: "sid", value: "密文里的值", expires: LATER, sameSite: 1, httpOnly: true },
          { host: "app.example.com", name: "__Host-token", value: "t", sameSite: 2 },
          { host: "plain.test", name: "old", value: "明文", plain: true, secure: false, expires: LATER },
          { host: ".example.com", name: "gone", value: "x", expires: NOW - 10 },
          { host: ".embed.test", name: "third", value: "x", partition: "https://top.test" }
        ],
        { metaVersion }
      );
      assert.deepEqual(await listProfiles(dir), [{ dir: "Default", name: "测试用户" }]);
      const { cookies, skipped } = await readChromeCookies({ chromeDir: dir, profile: "Default", password: "fake-password", now: NOW * 1000 });
      assert.equal(skipped, 2);
      assert.deepEqual(cookies[0], {
        url: "https://example.com/",
        name: "sid",
        value: "密文里的值",
        domain: ".example.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: LATER,
        sameSite: "lax"
      });
      assert.equal(cookies[1]!.domain, undefined);
      assert.equal(cookies[1]!.expirationDate, undefined);
      assert.equal(cookies[1]!.sameSite, "strict");
      assert.equal(cookies[2]!.value, "明文");
      assert.equal(cookies[2]!.url, "http://plain.test/");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("密码不对：一个也解不开，不抛错", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fake-chrome-"));
  try {
    await makeFakeChrome(dir, "right", [{ host: ".a.test", name: "n", value: "v", expires: LATER }]);
    const { cookies, skipped } = await readChromeCookies({ chromeDir: dir, profile: "Default", password: "wrong", now: NOW * 1000 });
    assert.equal(cookies.length, 0);
    assert.equal(skipped, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("不认识的格式返回 null", () => {
  assert.equal(decryptValue(Buffer.from("v11xxxxxxxxxxxxxxxx"), chromeKey("p"), 24), null);
  assert.equal(decryptValue(Buffer.alloc(0), chromeKey("p"), 24), "");
});
