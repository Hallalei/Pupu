import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { canonicalUrl } from "./index.ts";

function fakeEnv() {
  const seen: string[] = [];
  const env = {
    ASSETS: {
      fetch: async (request: Request) => {
        seen.push(request.url);
        return new Response("asset");
      }
    },
    DB: {
      prepare: () => ({ run: async () => ({}), bind: () => ({ run: async () => ({}) }) })
    },
    LIMIT: { limit: async () => ({ success: true }) }
  };
  return { env: env as unknown as Parameters<typeof worker.fetch>[1], seen };
}

const call = (url: string, init?: RequestInit) => {
  const { env, seen } = fakeEnv();
  return Promise.resolve(worker.fetch(new Request(url, init), env)).then((res) => ({ res, seen }));
};

test("http 和 www 都 301 到 https://getpupu.com，路径和参数不变", async () => {
  for (const from of [
    "http://getpupu.com/privacy?a=1&b=2",
    "https://www.getpupu.com/privacy?a=1&b=2",
    "http://www.getpupu.com/privacy?a=1&b=2"
  ]) {
    const { res, seen } = await call(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get("location"), "https://getpupu.com/privacy?a=1&b=2", from);
    assert.equal(seen.length, 0, from);
  }
  const root = await call("http://www.getpupu.com/");
  assert.equal(root.res.headers.get("location"), "https://getpupu.com/");
});

test("POST 到 www 用 308，不把请求变成 GET", async () => {
  const { res } = await call("https://www.getpupu.com/api/waitlist", {
    method: "POST",
    body: JSON.stringify({ email: "lin@example.com" })
  });
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "https://getpupu.com/api/waitlist");
});

test("https://getpupu.com 正常交给静态资源和申请接口", async () => {
  const page = await call("https://getpupu.com/privacy");
  assert.equal(page.res.status, 200);
  assert.deepEqual(page.seen, ["https://getpupu.com/privacy"]);

  const api = await call("https://getpupu.com/api/waitlist", {
    method: "POST",
    body: JSON.stringify({ email: "lin@example.com" })
  });
  assert.equal(api.res.status, 200);
  assert.equal(api.seen.length, 0);

  assert.equal((await call("https://getpupu.com/api/nope")).res.status, 404);
});

test("workers.dev 和本地地址不转", () => {
  assert.equal(canonicalUrl(new URL("https://pupu-site.example.workers.dev/")), null);
  assert.equal(canonicalUrl(new URL("http://localhost:4330/privacy")), null);
  assert.equal(canonicalUrl(new URL("https://getpupu.com/")), null);
  assert.equal(canonicalUrl(new URL("http://getpupu.com:8080/x")), "https://getpupu.com/x");
});
