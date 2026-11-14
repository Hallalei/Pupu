import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pairing } from "./credentials.ts";
import {
  computerAuth,
  hasRecord,
  PairingRun,
  reasonOf,
  rejectComputer,
  rejectDesktop,
  withComputer,
  withDesktop,
  type PairingBusy
} from "./pairing-state.ts";

const credential = { id: "d1", name: "mbpro", token: "secret" };
const computer = { id: "c1", name: "mbpro", token: "bridge-secret" };

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

test("两份都没有是第一次配对；只是窗口的没了，桥照常，配对窗口要码", () => {
  assert.equal(computerAuth({ desktop: null, computer: null }), "first");
  assert.equal(reasonOf({ desktop: null, computer: null }), "first");
  assert.equal(computerAuth({ desktop: null, computer }), "ok");
  assert.equal(reasonOf({ desktop: null, computer }), "desktop");
});

test("配对半路没做完（窗口的凭据存下了，第二步云端回 500）：是没做完，点一下再试，不算被吊销", () => {
  const halfway: Pairing = { desktop: credential, computer: null };
  assert.equal(computerAuth(halfway), "unfinished");
  assert.equal(reasonOf(halfway), "unfinished");
  // 重启后从凭据文件读回来还是没做完。
  assert.equal(computerAuth(JSON.parse(JSON.stringify(halfway)) as Pairing), "unfinished");
});

test("云端拒了这台电脑的凭据才算被吊销，重启后也是；重新配好以后记号去掉", () => {
  const revoked = rejectComputer({ desktop: credential, computer });
  assert.equal(revoked.computer, null);
  assert.equal(computerAuth(revoked), "revoked");
  assert.equal(reasonOf(revoked), "computer");
  assert.equal(computerAuth(JSON.parse(JSON.stringify(revoked)) as Pairing), "revoked");

  const repaired = withComputer(revoked, { ...computer, id: "c2" });
  assert.deepEqual(repaired, { desktop: credential, computer: { ...computer, id: "c2" } });
  assert.equal(computerAuth(repaired), "ok");
  // 再被拒一次，又是被吊销；不是半路没做完。
  assert.equal(computerAuth(rejectComputer(repaired)), "revoked");
});

test("两份都被吊销（先吊这台电脑、再吊窗口）：还是「授权被吊销」，不是还没配对；配对窗口要码", () => {
  const both = rejectDesktop(rejectComputer({ desktop: credential, computer }));
  assert.deepEqual([both.desktop, both.computer], [null, null]);
  assert.equal(computerAuth(both), "revoked");
  assert.equal(reasonOf(both), "revoked");
  // 重启后从凭据文件读回来还是被吊销。
  assert.equal(computerAuth(JSON.parse(JSON.stringify(both)) as Pairing), "revoked");
});

test("两份都被吊销（先吊窗口、再吊这台电脑，比如成员被移出组织）：同样是「授权被吊销」", () => {
  const windowGone = rejectDesktop({ desktop: credential, computer });
  assert.equal(computerAuth(windowGone), "ok");
  assert.equal(reasonOf(windowGone), "desktop");
  const both = rejectComputer(windowGone);
  assert.equal(computerAuth(both), "revoked");
  assert.equal(reasonOf(both), "revoked");
});

test("配对没做完时窗口又被吊销：两份都没了，是被吊销掉的", () => {
  const both = rejectDesktop({ desktop: credential, computer: null });
  assert.equal(computerAuth(both), "revoked");
  assert.equal(reasonOf(both), "revoked");
});

test("两份都被吊销后重新配好：两个记号都去掉；只拿回窗口的那一半算没做完，不算被吊销", () => {
  const both = rejectDesktop(rejectComputer({ desktop: credential, computer }));
  const halfway = withDesktop(both, { ...credential, id: "d2" });
  assert.equal(halfway.desktopRevoked, undefined);
  // 这台电脑的记号还在：它确实被吊销过，没重新拿到之前照旧是被吊销。
  assert.equal(computerAuth(halfway), "revoked");
  assert.equal(reasonOf(halfway), "computer");
  const repaired = withComputer(halfway, { ...computer, id: "c2" });
  assert.deepEqual(repaired, { desktop: { ...credential, id: "d2" }, computer: { ...computer, id: "c2" } });
  assert.equal(computerAuth(repaired), "ok");
});

test("凭据文件里只剩被吊销的记号也要留着，不然重启后成了还没配对", () => {
  assert.equal(hasRecord({ desktop: null, computer: null }), false);
  assert.equal(hasRecord({ desktop: credential, computer: null }), true);
  assert.equal(hasRecord(rejectDesktop(rejectComputer({ desktop: credential, computer }))), true);
  assert.equal(hasRecord(rejectDesktop({ desktop: credential, computer: null })), true);
});
