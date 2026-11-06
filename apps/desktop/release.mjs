// 把 npm run dist 打好的包发到 R2。清单最后传：用户看到新版本时，zip 已经在了。
// 发新版先改 package.json 的 version，版本号和线上一样时，老用户不会更新。
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOWNLOAD_ORIGIN, FEED_KEY, updateFeed } from "./src/update-feed.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const bucket = "pupu-downloads";
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const zip = `Pupu-${version}-arm64.zip`;

function put(key, file, type, cacheControl) {
  const args = ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--remote", "--file", file];
  args.push("--content-type", type, "--cache-control", cacheControl);
  const result = spawnSync("npx", args, { cwd: path.join(root, "..", "cloud"), stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${key} 没传上去`);
}

const feed = path.join(await mkdtemp(path.join(tmpdir(), "pupu-release-")), FEED_KEY);
await writeFile(feed, JSON.stringify(updateFeed(version, `${DOWNLOAD_ORIGIN}/${zip}`, new Date()), null, 2));

put(zip, path.join(root, "release", zip), "application/zip", "public, max-age=31536000, immutable");
put("Pupu-arm64.dmg", path.join(root, "release", `Pupu-${version}-arm64.dmg`), "application/x-apple-diskimage", "no-cache");
put(FEED_KEY, feed, "application/json", "no-cache");
console.log(`${version} 发好了：${DOWNLOAD_ORIGIN}/Pupu-arm64.dmg`);
