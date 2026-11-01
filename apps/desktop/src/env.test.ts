import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeEnv } from "./env.ts";

test("桥的环境变量去掉 Electron 和 Node 的调试开关", () => {
  const env = bridgeEnv({
    HOME: "/Users/me",
    PATH: "/usr/bin",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    NODE_OPTIONS: "--require /tmp/evil.js",
    NODE_DEBUG: "net",
    EMPTY: undefined
  });
  assert.deepEqual(env, { HOME: "/Users/me", PATH: "/usr/bin", PUPU_MENUBAR: "0" });
});
