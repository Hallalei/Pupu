#!/usr/bin/env node
// 发版前的只读体检：这份提交能不能发，要发哪几端。什么都不改，不推送。
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
let failed = false;
const line = (ok, label, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "ok " : "NO "} ${label}${detail ? `：${detail}` : ""}`);
};
const newer = (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0;

console.log(`提交 ${git("rev-parse", "--short", "HEAD")}，分支 ${git("branch", "--show-current") || "（游离）"}`);

const dirty = git("status", "--porcelain");
line(dirty === "", "工作目录干净", dirty ? `${dirty.split("\n").length} 处没提交` : "");

git("fetch", "-q", "origin");
const ahead = git("merge-base", "--is-ancestor", "origin/main", "HEAD") !== null;
line(ahead, "包含 origin/main，能快进推上去", ahead ? "" : "先变基到 origin/main");

/** 不进包的文件不算改到这一端。 */
const unshipped = /(\.test\.ts|\.md|tsconfig\.json)$/;
const files = (git("diff", "--name-only", "origin/main...HEAD") ?? "").split("\n").filter((file) => file && !unshipped.test(file));
const touches = (...prefixes) => files.some((file) => prefixes.some((prefix) => file.startsWith(prefix)));
const ends = [
  ["云端", touches("apps/cloud/src/", "apps/cloud/package", "apps/cloud/wrangler", "apps/cloud/vite", "apps/cloud/index.html", "apps/cloud/public/")],
  ["电脑 App", touches("apps/desktop/", "apps/cloud/bridge/")],
  ["TestFlight", touches("apps/ios/")],
  ["官网", touches("apps/site/")]
];
console.log(`--  origin/main 之后改到的端：${ends.filter(([, hit]) => hit).map(([name]) => name).join("、") || "没有要发的"}`);

const local = JSON.parse(readFileSync(join(repo, "apps/desktop/package.json"), "utf8")).version;
const live = await fetch("https://dl.getpupu.com/mac-arm64.json")
  .then((response) => response.json())
  .then((feed) => feed.currentRelease)
  .catch(() => null);
if (ends[1][1]) line(Boolean(live) && newer(local, live), "电脑 App 版本号比线上新", `本地 ${local}，线上 ${live ?? "读不到"}`);
else console.log(`--  电脑 App 没改：本地 ${local}，线上 ${live ?? "读不到"}`);

const check = spawnSync("node", [join(repo, "scripts/check.mjs")], { cwd: repo, encoding: "utf8" });
line(check.status === 0, "类型检查和测试全过", check.status === 0 ? "" : "跑 node scripts/check.mjs 看哪项");

process.exit(failed ? 1 : 0);
