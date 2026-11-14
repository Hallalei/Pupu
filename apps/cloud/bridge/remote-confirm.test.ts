import { test } from "node:test";
import assert from "node:assert/strict";
import { mayChangeRemoteConfirm } from "../src/bridge/remote-confirm.ts";

test("往严里改谁都行，放宽只有主人", () => {
  assert.equal(mayChangeRemoteConfirm("none", "always", { memberId: "m2" }, "m1"), true);
  assert.equal(mayChangeRemoteConfirm("always", "always", undefined, "m1"), true);
  assert.equal(mayChangeRemoteConfirm("always", "none", { memberId: "m2" }, "m1"), false);
  assert.equal(mayChangeRemoteConfirm("always", "device", { memberId: "m1" }, "m1"), true);
  assert.equal(mayChangeRemoteConfirm("device", "none", undefined, "m1"), false);
  assert.equal(mayChangeRemoteConfirm("device", "none", null, "m1"), true);
});
