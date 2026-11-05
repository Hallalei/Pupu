import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeEnv, debugSwitches, devVariables } from "./env.ts";

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

test("正式包认得出调试开关，别的参数不管", () => {
  assert.deepEqual(
    debugSwitches([
      "/Applications/Pupu.app/Contents/MacOS/Pupu",
      "--remote-debugging-port=9222",
      "-remote-debugging-pipe",
      "--inspect",
      "--inspect-brk=0",
      "--js-flags=--allow-natives-syntax",
      "--remote-debugging-portal",
      "--enable-logging",
      "inspect"
    ]),
    ["--remote-debugging-port=9222", "-remote-debugging-pipe", "--inspect", "--inspect-brk=0", "--js-flags=--allow-natives-syntax"]
  );
  assert.deepEqual(debugSwitches(["/Applications/Pupu.app/Contents/MacOS/Pupu"]), []);
});

test("开发用的环境变量都以 PUPU_ 开头", () => {
  assert.deepEqual(devVariables({ PUPU_URL: "http://localhost:5173", PUPU_DIR: "/tmp/p", HOME: "/Users/me", PUPUX: "1" }), [
    "PUPU_URL",
    "PUPU_DIR"
  ]);
});
