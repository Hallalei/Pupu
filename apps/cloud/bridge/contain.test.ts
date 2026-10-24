import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { containPath } from "./contain.ts";

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

test("文件落在主目录里，缺的后几截也能解析", async (t) => {
  const root = await tempDir("pupu-contain-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "ok.txt"), "hi");
  assert.equal(await containPath(root, "ok.txt"), path.join(root, "ok.txt"));
  assert.equal(await containPath(root, "nested/new.txt"), path.join(root, "nested", "new.txt"));
  assert.equal(await containPath(root, ""), root);
});

test("主目录外面和符号链接逃逸都拒绝", async (t) => {
  const root = await tempDir("pupu-contain-");
  const outside = await tempDir("pupu-outside-");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret"), "x");
  await symlink(outside, path.join(root, "link"));
  await symlink(path.join(outside, "secret"), path.join(root, "secret"));
  assert.equal(await containPath(root, "../outside.txt"), null);
  assert.equal(await containPath(root, "link/file"), null);
  assert.equal(await containPath(root, "secret"), null);
  assert.equal(await containPath(root, path.join(outside, "secret")), null);
});

test("凭据文件按真实路径挡住", async (t) => {
  const root = await tempDir("pupu-contain-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = path.join(root, ".pupu", "bridge.json");
  await mkdir(path.dirname(secret), { recursive: true });
  await writeFile(secret, "{}");
  const alias = path.join(root, "alias.json");
  await symlink(secret, alias);
  assert.equal(await containPath(root, ".pupu/bridge.json", [secret]), null);
  assert.equal(await containPath(root, "alias.json", [secret]), null);
  assert.equal(await containPath(root, ".pupu/other.json", [secret]), path.join(root, ".pupu", "other.json"));
});
