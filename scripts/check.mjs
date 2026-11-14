#!/usr/bin/env node
// 推送前的关口：各 app 的类型检查和测试。
//   node scripts/check.mjs                 全部
//   node scripts/check.mjs cloud desktop   只跑点名的
//   node scripts/check.mjs --since <提交>  只跑这之后改到的 app
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const APPS = {
  cloud: ["typecheck", "bridge:check", "test:bridge"],
  desktop: ["typecheck", "test"],
  site: ["check", "test"]
};
/** 电脑 App 直接引 apps/cloud 的源码，云端一改它也要重查。 */
const ALSO = { cloud: ["desktop"] };
/** 检查这个 app 要装谁的依赖：电脑 App 的类型检查会读到云端的包。 */
const NEEDS = { desktop: ["desktop", "cloud"] };

function changedSince(ref) {
  const files = execFileSync("git", ["diff", "--name-only", `${ref}...HEAD`], { cwd: repo, encoding: "utf8" }).split("\n");
  const picked = new Set();
  for (const app of Object.keys(APPS)) {
    if (!files.some((file) => file.startsWith(`apps/${app}/`))) continue;
    picked.add(app);
    for (const other of ALSO[app] ?? []) picked.add(other);
  }
  return [...picked];
}

const args = process.argv.slice(2);
const since = args.indexOf("--since");
const apps = since >= 0 ? changedSince(args[since + 1]) : args.length ? args : Object.keys(APPS);

const unknown = apps.filter((app) => !APPS[app]);
if (unknown.length) {
  console.error(`没有这个 app：${unknown.join("、")}。可选 ${Object.keys(APPS).join("、")}`);
  process.exit(2);
}
if (!apps.length) {
  console.log("check：没改到 apps 下的代码，跳过");
  process.exit(0);
}

const needed = [...new Set(apps.flatMap((app) => NEEDS[app] ?? [app]))];
const missing = needed.filter((app) => !existsSync(join(repo, "apps", app, "node_modules")));
if (missing.length) {
  console.error("check：依赖没装，检查没法跑。先装：");
  for (const app of missing) console.error(`  (cd apps/${app} && npm ci)`);
  process.exit(2);
}

const failed = [];
for (const app of apps) {
  for (const script of APPS[app]) {
    const started = Date.now();
    const result = spawnSync("npm", ["run", "-s", script], { cwd: join(repo, "apps", app), encoding: "utf8" });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const ok = result.status === 0;
    console.log(`${ok ? "ok " : "NO "} ${app} ${script}（${seconds}s）`);
    if (ok) continue;
    failed.push(`${app} ${script}`);
    const output = `${result.stdout}${result.stderr}`.trim().split("\n");
    console.log(output.filter((row) => /error|not ok|fail/i.test(row)).slice(0, 30).join("\n") || output.slice(-30).join("\n"));
  }
}

if (failed.length) {
  console.error(`check：没过 ${failed.join("、")}`);
  process.exit(1);
}
console.log("check：全过");
