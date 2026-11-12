// 原型取证：打出探针，在后台起 Electron（open -g，不进程序坞、不抢前台），等它写出 report.txt。
// 用法：node probe/run.mjs <输出目录>
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(process.argv[2] ?? path.join(root, "probe-out"));
const bundle = path.join(out, "bundle");
rmSync(out, { recursive: true, force: true });
const common = { bundle: true, platform: "node", target: "node24", logLevel: "warning", external: ["electron"] };
await build({ ...common, entryPoints: [path.join(root, "probe/browser-probe-main.ts")], outfile: path.join(bundle, "main.cjs"), format: "cjs" });
await build({ ...common, entryPoints: [path.join(root, "probe/browser-probe-bridge.ts")], outfile: path.join(bundle, "bridge.mjs"), format: "esm" });

const electronApp = path.join(root, "node_modules/electron/dist/Electron.app");
spawnSync("open", ["-g", "-n", "-a", electronApp, "--env", `PROBE_OUT=${out}`, "--args", path.join(bundle, "main.cjs")], { stdio: "inherit" });
const report = path.join(out, "report.txt");
const deadline = Date.now() + 120_000;
while (!existsSync(report) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
console.log(existsSync(report) ? `报告：${report}` : "两分钟没出报告。");
