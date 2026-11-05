// 出电脑 App 的正式包（技术方案 5.5），产物在 release/：
// 1. build.mjs 打出 dist/；
// 2. 屏幕助手 computer.swift、输入助手 input.swift 编到 out/，用同一个身份签名、开 hardened runtime；
// 3. electron-builder 按 electron-builder.yml 打 Pupu.app（Fuses、签名、公证并 staple）和 DMG；
// 4. DMG 签名、公证、staple；
// 5. 验签名、Gatekeeper、公证票据、Fuses 和 entitlements。
//
//   npm run dist               正式包。钥匙串里要有 Developer ID Application 证书，notarytool 要存好凭据
//                              （默认叫 pupu-notary，PUPU_NOTARY_PROFILE 换名字），见 README。
//   npm run dist -- --local    本机试打包：临时签名、不公证，只用来验打包本身，别拿去装。
//
// 签名顺序和 DMG 单独公证参考 cindy 的 scripts/ci/lib.mjs、deepchat 的 scripts/notarize-dmg.js。
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { Arch, build, Platform } from "electron-builder";

const root = path.dirname(fileURLToPath(import.meta.url));
const local = process.argv.includes("--local");
const profile = process.env.PUPU_NOTARY_PROFILE || "pupu-notary";
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const helpers = [
  { source: "computer.swift", name: "pupu-computer-use", identifier: "com.leizi.pupu.desktop.computer-use" },
  { source: "input.swift", name: "pupu-input", identifier: "com.leizi.pupu.desktop.input" }
];
const app = path.join(root, "release", "mac-arm64", "Pupu.app");
const dmg = path.join(root, "release", `Pupu-${version}-arm64.dmg`);

/** 跑一个命令，输出直接打到终端；`capture` 时收下 stdout 返回。 */
function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${command} ${args.join(" ")} 退出码 ${code}`));
    });
  });
}

/** 钥匙串里的 Developer ID Application 证书，返回它的 SHA-1。不打印证书名，名字里带着团队号。 */
async function signingIdentity() {
  const out = await run("security", ["find-identity", "-v", "-p", "codesigning"], { capture: true });
  const line = out.split("\n").find((it) => it.includes('"Developer ID Application:'));
  const hash = line?.match(/\b([0-9A-F]{40})\b/)?.[1];
  if (!hash) {
    throw new Error(
      "钥匙串里没有 Developer ID Application 证书。到 Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application 建一个。"
    );
  }
  return hash;
}

async function checkNotaryProfile() {
  try {
    await run("xcrun", ["notarytool", "history", "--keychain-profile", profile], { capture: true });
  } catch {
    throw new Error(`notarytool 里没有叫 ${profile} 的凭据，先按 README 跑一遍 xcrun notarytool store-credentials。`);
  }
}

async function buildHelpers(identity) {
  await mkdir(path.join(root, "out"), { recursive: true });
  const sign = identity ? ["--timestamp", "--sign", identity] : ["--sign", "-"];
  for (const { source, name, identifier } of helpers) {
    const bin = path.join(root, "out", name);
    await run("swiftc", ["-O", "-target", "arm64-apple-macos14.0", "-o", bin, path.join(root, "..", "cloud", "bridge", source)]);
    await run("codesign", ["--force", "--options", "runtime", "--identifier", identifier, ...sign, bin]);
  }
}

/** 公证一个文件，等苹果给结果；没过就把苹果的说明打出来。 */
async function notarize(file) {
  const out = await run(
    "xcrun",
    ["notarytool", "submit", file, "--keychain-profile", profile, "--wait", "--output-format", "json"],
    { capture: true }
  );
  const result = JSON.parse(out);
  if (result.status !== "Accepted") {
    await run("xcrun", ["notarytool", "log", result.id, "--keychain-profile", profile]).catch(() => {});
    throw new Error(`${path.basename(file)} 公证没过：${result.status}`);
  }
  console.log(`${path.basename(file)} 公证通过（${result.id}）。`);
}

async function verify() {
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  for (const { name } of helpers) {
    await run("codesign", ["--verify", "--strict", "--verbose=2", path.join(app, "Contents", "Resources", "helpers", name)]);
  }
  const wire = await getCurrentFuseWire(app);
  const fuses = Object.entries(wire)
    .filter(([key]) => key !== "version")
    // 线上每一位是字符 "1"（49）或 "0"（48）。
    .map(([key, value]) => `${FuseV1Options[Number(key)] ?? `第 ${key} 位`}=${value === 49 ? "开" : value === 48 ? "关" : value}`);
  console.log(`Fuses：${fuses.join(" ")}`);
  if (local) return;
  await run("spctl", ["--assess", "--type", "execute", "-vv", app]);
  await run("xcrun", ["stapler", "validate", app]);
  await run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", dmg]);
  await run("xcrun", ["stapler", "validate", dmg]);
}

const identity = local ? null : await signingIdentity();
if (!local) await checkNotaryProfile();
await run("node", ["build.mjs"]);
await buildHelpers(identity);
if (!local) process.env.APPLE_KEYCHAIN_PROFILE = profile;
await build({
  targets: Platform.MAC.createTarget(["dmg"], Arch.arm64),
  publish: "never",
  // 临时签名开 hardened runtime 要关库校验，本机试打包就不开了。
  config: local
    ? { mac: { identity: "-", hardenedRuntime: false } }
    : { mac: { identity, notarize: true } }
});
if (!local) {
  await run("codesign", ["--force", "--timestamp", "--sign", identity, dmg]);
  await notarize(dmg);
  await run("xcrun", ["stapler", "staple", dmg]);
}
await verify();
console.log(local ? `本机试打包好了：${app}` : `正式包好了：${dmg}`);
