import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pairing } from "./credentials.ts";
import { readWithLegacy } from "./legacy-pairing.ts";

const NEW = "https://app.example.com";
const OLD = "https://old.example.dev";
const EMPTY: Pairing = { desktop: null, computer: null };
const SOME: Pairing = { desktop: { id: "d", name: "Mac", token: "t" }, computer: null };

function store(initial: Record<string, Pairing>) {
  const servers = { ...initial };
  return {
    servers,
    read: async (origin: string) => servers[origin] ?? EMPTY,
    write: async (origin: string, pairing: Pairing) => {
      servers[origin] = pairing;
    }
  };
}

test("新地址下没有凭据：从旧地址复制过来，旧的留着", async () => {
  const s = store({ [OLD]: SOME });
  const result = await readWithLegacy(NEW, NEW, [OLD], s.read, s.write);
  assert.deepEqual(result, { pairing: SOME, from: OLD });
  assert.deepEqual(s.servers[NEW], SOME);
  assert.deepEqual(s.servers[OLD], SOME);
});

test("新地址下已经有凭据：不碰旧的", async () => {
  const mine: Pairing = { desktop: null, computer: { id: "c", name: "Mac", token: "n" } };
  const s = store({ [NEW]: mine, [OLD]: SOME });
  assert.deepEqual(await readWithLegacy(NEW, NEW, [OLD], s.read, s.write), { pairing: mine, from: null });
});

test("开发时连别的地址：不搬", async () => {
  const s = store({ [OLD]: SOME });
  const result = await readWithLegacy("http://localhost:5199", NEW, [OLD], s.read, s.write);
  assert.deepEqual(result, { pairing: EMPTY, from: null });
  assert.equal(s.servers["http://localhost:5199"], undefined);
});

test("哪儿都没有：当成没配对", async () => {
  const s = store({});
  assert.deepEqual(await readWithLegacy(NEW, NEW, [OLD], s.read, s.write), { pairing: EMPTY, from: null });
});

test("新地址下两份凭据都被吊销了、只剩记号：不从旧地址搬回那份被吊销的", async () => {
  const revoked: Pairing = { desktop: null, computer: null, desktopRevoked: true, computerRevoked: true };
  const s = store({ [NEW]: revoked, [OLD]: SOME });
  assert.deepEqual(await readWithLegacy(NEW, NEW, [OLD], s.read, s.write), { pairing: revoked, from: null });
  assert.deepEqual(s.servers[NEW], revoked);
});
