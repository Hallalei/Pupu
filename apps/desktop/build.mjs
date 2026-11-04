// 把主进程、两个 preload 和桥各打成一个文件，放进 dist/。桥的代码还在 apps/cloud/bridge/，
// 打包时一起打进来（技术方案 5.2）。
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const bridgeDir = path.join(root, "..", "cloud", "bridge");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = { bundle: true, platform: "node", target: "node24", sourcemap: "linked", logLevel: "warning" };

await Promise.all([
  build({ ...common, entryPoints: [path.join(root, "src/main.ts")], outfile: path.join(dist, "main.cjs"), format: "cjs", external: ["electron"] }),
  // sandbox 里的 preload 只能 require electron，所以要打成单个文件。
  build({ ...common, entryPoints: [path.join(root, "src/preload.ts")], outfile: path.join(dist, "preload.cjs"), format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: [path.join(root, "src/pair-preload.ts")], outfile: path.join(dist, "pair-preload.cjs"), format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: [path.join(root, "src/capture-preload.ts")], outfile: path.join(dist, "capture-preload.cjs"), format: "cjs", external: ["electron"] }),
  // 推流页跑在隐藏窗口里，是网页。
  build({ ...common, platform: "browser", target: "chrome140", entryPoints: [path.join(root, "src/capture-page.ts")], outfile: path.join(dist, "capture.js"), format: "iife" }),
  // 桥用 ESM：computer.ts 靠 import.meta.url 找旁边的 computer.swift。ws 是 CommonJS，
  // 里面 require 内置模块，ESM 里要先补一个 require。
  build({
    ...common,
    entryPoints: [path.join(root, "src/bridge-host.ts")],
    outfile: path.join(dist, "bridge.mjs"),
    format: "esm",
    external: ["electron", "bufferutil", "utf-8-validate"],
    banner: { js: 'import { createRequire as __pupuRequire } from "node:module"; const require = __pupuRequire(import.meta.url);' }
  })
]);

await cp(path.join(bridgeDir, "computer.swift"), path.join(dist, "computer.swift"));
await cp(path.join(bridgeDir, "input.swift"), path.join(dist, "input.swift"));
await cp(path.join(root, "static"), dist, { recursive: true });
console.log("已打到 dist/");
