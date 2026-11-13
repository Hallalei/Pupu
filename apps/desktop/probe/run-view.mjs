// 打出 view-probe，在后台起 Electron（open -g，不进程序坞），等它写出 report.txt。用法：node probe/run-view.mjs <输出目录>
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.resolve(process.argv[2] ?? path.join(root, "probe-out"));
rmSync(out, { recursive: true, force: true });
await build({ bundle: true, platform: "node", target: "node24", logLevel: "warning", external: ["electron"], entryPoints: [path.join(root, "probe/view-probe.ts")], outfile: path.join(out, "main.cjs"), format: "cjs" });
spawnSync("open", ["-g", "-n", "-a", path.join(root, "node_modules/electron/dist/Electron.app"), "--env", `PROBE_OUT=${out}`, "--args", path.join(out, "main.cjs")], { stdio: "inherit" });
const report = path.join(out, "report.txt");
const deadline = Date.now() + 60_000;
while (!existsSync(report) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
console.log(existsSync(report) ? readFileSync(report, "utf8") : "一分钟没出报告。");
