import assert from "node:assert/strict";
import { test } from "node:test";
import { handleWaitlist, normalizeEmail, type WaitlistEnv } from "./waitlist.ts";

function fakeEnv(allowed = true) {
  const rows = new Map<string, string>();
  const env = {
    DB: {
      prepare: (sql: string) => ({
        run: async () => ({}),
        bind: (email: string, at: string) => ({
          run: async () => {
            if (sql.startsWith("INSERT") && !rows.has(email)) rows.set(email, at);
            return {};
          }
        })
      })
    },
    LIMIT: { limit: async () => ({ success: allowed }) }
  } as unknown as WaitlistEnv;
  return { env, rows };
}

const post = (body: unknown) =>
  new Request("https://site.test/api/waitlist", { method: "POST", body: JSON.stringify(body) });

test("邮箱去空格、转小写，不像邮箱的不收", () => {
  assert.equal(normalizeEmail("  Lin@Example.COM "), "lin@example.com");
  assert.equal(normalizeEmail("lin@example"), null);
  assert.equal(normalizeEmail("a b@example.com"), null);
  assert.equal(normalizeEmail(`${"a".repeat(250)}@b.co`), null);
  assert.equal(normalizeEmail(42), null);
});

test("收下邮箱，重复申请回一样的结果，只存一条", async () => {
  const { env, rows } = fakeEnv();
  const first = await handleWaitlist(post({ email: "lin@example.com" }), env);
  const second = await handleWaitlist(post({ email: "LIN@example.com" }), env);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), await second.json());
  assert.equal(rows.size, 1);
});

test("空栏被填了就当成功，不入库", async () => {
  const { env, rows } = fakeEnv();
  const res = await handleWaitlist(post({ email: "bot@example.com", website: "x" }), env);
  assert.equal(res.status, 200);
  assert.equal(rows.size, 0);
});

test("邮箱不对回 400，不是 JSON 回 400，太快回 429，GET 回 405", async () => {
  const { env, rows } = fakeEnv();
  assert.equal((await handleWaitlist(post({ email: "nope" }), env)).status, 400);
  const raw = new Request("https://site.test/api/waitlist", { method: "POST", body: "{" });
  assert.equal((await handleWaitlist(raw, env)).status, 400);
  assert.equal((await handleWaitlist(post({ email: "a@b.co" }), fakeEnv(false).env)).status, 429);
  assert.equal((await handleWaitlist(new Request("https://site.test/api/waitlist"), env)).status, 405);
  assert.equal(rows.size, 0);
});
