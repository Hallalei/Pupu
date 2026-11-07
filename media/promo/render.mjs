#!/usr/bin/env node
/**
 * 片子的渲染入口。起一个本地服务，让无头 Chrome 打开 film/index.html，
 * 页面按时间一帧一帧算好像素 POST 回来，这边接着喂给 ffmpeg。没有中间帧文件。
 *
 *   node media/promo/render.mjs stills --at 3.2,8.1 --size 960x540 --samples 8
 *   node media/promo/render.mjs video --from 21 --to 35 --samples 32 --out sample.mp4 --fadein 0.4 --fadeout 0.6
 *
 * 画面是时间的纯函数，同样的参数出同样的片子。
 * 「页面暴露按帧取画、不靠 requestAnimationFrame」这一招来自 hyperframes 和 remotion。
 * 无头 Chrome 不开窗口，不抢前台。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BEATS = JSON.parse(fs.readFileSync(path.join(HERE, "film/beats.json"), "utf8"));

function options(argv) {
  const out = { mode: argv[0] };
  for (let index = 1; index < argv.length; index += 2) out[argv[index].replace(/^--/, "")] = argv[index + 1];
  return out;
}

const args = options(process.argv.slice(2));
const [width, height] = (args.size ?? "1920x1080").split("x").map(Number);
const fps = Number(args.fps ?? BEATS.fps);
const samples = Number(args.samples ?? 8);
const outDir = path.join(HERE, "out");
fs.mkdirSync(outDir, { recursive: true });

let times;
if (args.mode === "stills") {
  times = args.at.split(",").map(Number);
} else {
  const from = Number(args.from ?? 0);
  const to = Number(args.to ?? BEATS.duration);
  const count = Math.round((to - from) * fps);
  times = Array.from({ length: count }, (_, index) => from + index / fps);
}

function encoder() {
  const raw = ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0"];
  if (args.mode === "stills") {
    const dir = path.resolve(outDir, args.dir ?? "stills");
    fs.mkdirSync(dir, { recursive: true });
    const list = args.at.split(",");
    return { dir, list, spawn: () => spawn("ffmpeg", [...raw, path.join(dir, "%03d.png")], { stdio: ["pipe", "inherit", "inherit"] }) };
  }
  const file = path.resolve(outDir, args.out ?? "film.mp4");
  const length = times.length / fps;
  const fades = [];
  if (args.fadein) fades.push(`fade=t=in:st=0:d=${args.fadein}`);
  if (args.fadeout) fades.push(`fade=t=out:st=${length - Number(args.fadeout)}:d=${args.fadeout}`);
  const audio = args.audio ? ["-ss", String(args.from ?? 0), "-t", String(times.length / fps), "-i", path.resolve(outDir, args.audio)] : [];
  const tail = [
    ...audio,
    "-vf", [...fades, "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"].join(","),
    "-c:v", "libx264", "-preset", "slow", "-crf", args.crf ?? "15", "-profile:v", "high",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    ...(args.audio ? ["-c:a", "aac", "-b:a", "256k", "-shortest"] : []),
    "-movflags", "+faststart", file
  ];
  return { file, spawn: () => spawn("ffmpeg", [...raw, ...tail], { stdio: ["pipe", "inherit", "inherit"] }) };
}

const output = encoder();
const ffmpeg = output.spawn();
const ffmpegDone = new Promise((resolve, reject) => {
  ffmpeg.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
});

const TYPES = { ".html": "text/html", ".json": "application/json", ".woff2": "font/woff2" };

/** 把仓库里的 .ts 去掉类型后当 ES 模块发出去。产品代码里没写扩展名的 import 也能找到。 */
function serveFile(url, response) {
  let file = path.join(ROOT, decodeURIComponent(url.split("?")[0]));
  if (!file.startsWith(ROOT)) return response.writeHead(403).end();
  if (!fs.existsSync(file) && fs.existsSync(`${file}.ts`)) file += ".ts";
  if (!fs.existsSync(file)) return response.writeHead(404).end();
  if (file.endsWith(".ts")) {
    response.setHeader("content-type", "text/javascript");
    return response.end(stripTypeScriptTypes(fs.readFileSync(file, "utf8")));
  }
  response.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
  fs.createReadStream(file).pipe(response);
}

let chrome;
let finished = false;
const started = Date.now();
let received = 0;

function finish(code) {
  if (finished) return;
  finished = true;
  ffmpeg.stdin.end();
  ffmpegDone
    .catch((error) => console.error(error.message))
    .finally(() => {
      chrome?.kill();
      server.close();
      if (output.file) console.log(`写好了 ${path.relative(process.cwd(), output.file)}`);
      else console.log(`写好了 ${path.relative(process.cwd(), output.dir)}/`);
      process.exit(code);
    });
}

const server = http.createServer((request, response) => {
  const { method, url } = request;
  if (method === "GET" && url === "/job") {
    response.setHeader("content-type", "application/json");
    return response.end(JSON.stringify({ width, height, samples, fps, times, shutter: Number(args.shutter ?? 0.5) }));
  }
  if (method === "GET") return serveFile(url, response);
  if (url.startsWith("/frame/")) {
    request.on("data", (chunk) => {
      if (!ffmpeg.stdin.write(chunk)) {
        request.pause();
        ffmpeg.stdin.once("drain", () => request.resume());
      }
    });
    request.on("end", () => {
      received += 1;
      response.end("ok");
      if (received % 30 === 0 || received === times.length) {
        const seconds = (Date.now() - started) / 1000;
        const left = (seconds / received) * (times.length - received);
        console.log(`${received}/${times.length}  ${(seconds / received).toFixed(2)} 秒一帧  还要 ${(left / 60).toFixed(1)} 分钟`);
      }
    });
    return;
  }
  const parts = [];
  request.on("data", (chunk) => parts.push(chunk));
  request.on("end", () => {
    response.end("ok");
    const body = Buffer.concat(parts).toString();
    if (url === "/log") console.log(body);
    if (url === "/fail") {
      console.error(`页面出错：${body}`);
      finish(1);
    }
    if (url === "/done") finish(0);
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pupu-film-"));
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-gpu-watchdog",
      "--disable-gpu-process-crash-limit",
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${port}/media/promo/film/index.html`
    ],
    { stdio: "ignore" }
  );
  chrome.on("exit", () => {
    fs.rmSync(profile, { recursive: true, force: true });
    if (!finished) {
      console.error("Chrome 提前退出了");
      finish(1);
    }
  });
});

process.on("SIGINT", () => finish(130));
process.on("SIGTERM", () => finish(143));
