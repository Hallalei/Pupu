#!/usr/bin/env node
// 电脑 App 传完 R2 之后：线上清单指向本地这一版，下载回来的 zip 和 dmg 与本地打的包一字不差。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../apps/desktop");
const origin = "https://dl.getpupu.com";
const { version } = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let failed = false;
const line = (ok, label, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "ok " : "NO "} ${label}${detail ? `：${detail}` : ""}`);
};

const feed = await fetch(`${origin}/mac-arm64.json`, { cache: "no-store" }).then((response) => response.json());
line(feed.currentRelease === version, `清单指向 ${version}`, `线上是 ${feed.currentRelease}`);

const pairs = [
  [`Pupu-${version}-arm64.zip`, `Pupu-${version}-arm64.zip`],
  ["Pupu-arm64.dmg", `Pupu-${version}-arm64.dmg`]
];
for (const [remote, file] of pairs) {
  const response = await fetch(`${origin}/${remote}`, { cache: "no-store" });
  const online = response.ok ? sha(Buffer.from(await response.arrayBuffer())) : null;
  const mine = sha(readFileSync(join(desktop, "release", file)));
  line(online === mine, `${remote} 和本地 ${file} 一致`, online ? online.slice(0, 12) : `下载回 ${response.status}`);
}

process.exit(failed ? 1 : 0);
