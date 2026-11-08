import assert from "node:assert/strict";
import { test } from "node:test";
import { PairingRun, reasonOf, type PairingBusy } from "./pairing-state.ts";

const credential = { id: "d1", name: "mbpro", token: "secret" };

function deferred() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("用码配对还没做完，Google 登录不开始，只换出一台设备", async () => {
  const run = new PairingRun(() => {});
  const first = deferred();
  let minted = 0;
  const pairing = run.run("code", () => {
    minted += 1;
    return first.promise;
  });
  const refused = await run.run("google", async () => {
    minted += 1;
    return null;
  });
  assert.equal(refused, "上一次配对还没做完。");
  first.resolve(null);
  assert.equal(await pairing, null);
  assert.equal(minted, 1);
});

test("做完一次，下一次照常能开始", async () => {
  const run = new PairingRun(() => {});
  assert.equal(await run.run("code", async () => "配对码不对"), "配对码不对");
  assert.equal(await run.run("google", async () => null), null);
});

test("窗口看到的状态：开始时是在做的那一件，做完回到空闲", async () => {
  const seen: (PairingBusy | null)[] = [];
  const run: PairingRun = new PairingRun(() => seen.push(run.busy));
  await run.run("google", async () => null);
  assert.deepEqual(seen, ["google", null]);
});

test("取消只结束在等的那次", async () => {
  const run = new PairingRun(() => {});
  const waiting = run.run("google", (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve("已取消。"))));
  run.cancel();
  assert.equal(await waiting, "已取消。");
  assert.equal(run.busy, null);
});

test("窗口凭据拿到了、电脑授权没拿到：再试一次只要点重新授权，不用码", () => {
  assert.equal(reasonOf({ desktop: null, computer: null }), "first");
  assert.equal(reasonOf({ desktop: credential, computer: null }), "computer");
  assert.equal(reasonOf({ desktop: null, computer: credential }), "desktop");
});
