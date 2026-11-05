import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComputerAction, UpFrame } from "../src/bridge/protocol.ts";
import type { ActionHost } from "./actions.ts";
import { yieldToHuman } from "./remote.ts";
import { ensureSwiftBinary } from "./swift.ts";

const SOURCE = fileURLToPath(new URL("./computer.swift", import.meta.url));

type Shot = {
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly width: number;
  readonly height: number;
  readonly summary: string;
  readonly jpeg: Buffer;
};

let lastShot: Shot | null = null;

/** 把模型在截图上点的位置，换回主屏幕的像素。原点都在左上角。 */
export function screenPoint(
  x: number,
  y: number,
  shot: Pick<Shot, "screenWidth" | "screenHeight" | "width" | "height">
): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (shot.width <= 0 || shot.height <= 0 || shot.screenWidth <= 0 || shot.screenHeight <= 0) return null;
  const realX = Math.round((x / shot.width) * shot.screenWidth);
  const realY = Math.round((y / shot.height) * shot.screenHeight);
  if (realX < 0 || realY < 0 || realX >= shot.screenWidth || realY >= shot.screenHeight) return null;
  return { x: realX, y: realY };
}

export async function performComputer(
  requestId: string,
  action: ComputerAction,
  host: ActionHost
): Promise<void> {
  const bin = await ensureHelper();
  if (action.op === "permissions") {
    const result = await run(bin, ["permissions"]);
    const access = result.accessibility === true ? "辅助功能已允许" : "辅助功能还没允许";
    const screen = result.screen === true ? "屏幕录制已允许" : "屏幕录制还没允许";
    const grantee = typeof result.grantee === "string" ? result.grantee : "运行 Pupu 桥的程序";
    host.send({
      type: "data",
      requestId,
      bytes: Buffer.byteLength(`${access}。${screen}。`),
      text: `权限记在「${grantee}」名下：${access}。${screen}。没允许的话，到系统设置 → 隐私与安全性里给它打开，开了还不行就把它退出再打开。`
    });
    return;
  }
  if (action.op === "screenshot") {
    await sendShot(requestId, host, await capture(bin));
    return;
  }
  const shot = lastShot;
  if (!shot) throw new Error("还没有截图。先截一张，再用图上的坐标。");
  await yieldToHuman();
  if (action.op === "type") {
    const text = action.text ?? "";
    if (!text.trim()) throw new Error("没有要输入的文字。");
    if (text.length > 20_000) throw new Error("一次输入太长了。");
    await run(bin, ["type"], text);
  } else if (action.op === "key") {
    const key = action.key?.trim() ?? "";
    if (!key || key.length > 40) throw new Error("键名不对。");
    await run(bin, ["key", key]);
  } else {
    const start = located(action.x, action.y, shot);
    if (action.op === "click") {
      await run(bin, [
        "click",
        String(start.x),
        String(start.y),
        action.button ?? "left",
        String(Math.min(3, Math.max(1, Math.round(action.count ?? 1))))
      ]);
    } else if (action.op === "move") {
      await run(bin, ["move", String(start.x), String(start.y)]);
    } else if (action.op === "scroll") {
      if (typeof action.delta !== "number" || !Number.isFinite(action.delta)) throw new Error("滚动量不对。");
      await run(bin, ["scroll", String(start.x), String(start.y), String(Math.round(action.delta))]);
    } else if (action.op === "drag") {
      const end = located(action.x2, action.y2, shot);
      await run(bin, ["drag", String(start.x), String(start.y), String(end.x), String(end.y), action.button ?? "left"]);
    }
  }
  await sendShot(requestId, host, await capture(bin));
}

function located(x: number | undefined, y: number | undefined, shot: Shot): { x: number; y: number } {
  const point = screenPoint(x ?? Number.NaN, y ?? Number.NaN, shot);
  if (!point) throw new Error("坐标不在最近一张截图里面。先看图，再用图上的像素。");
  return point;
}

async function sendShot(requestId: string, host: ActionHost, shot: Shot): Promise<void> {
  lastShot = shot;
  const frame: UpFrame = {
    type: "picture",
    requestId,
    mime: "image/jpeg",
    width: shot.width,
    height: shot.height,
    screenWidth: shot.screenWidth,
    screenHeight: shot.screenHeight,
    data: shot.jpeg.toString("base64"),
    ...(shot.summary ? { summary: shot.summary } : {})
  };
  host.send(frame);
}

async function capture(bin: string): Promise<Shot> {
  const directory = await mkdtemp(path.join(tmpdir(), "pupu-shot-"));
  const file = path.join(directory, "screen.jpg");
  try {
    const result = await run(bin, ["screenshot", file]);
    const jpeg = await readFile(file);
    if (jpeg.byteLength > 3_000_000) throw new Error("截图太大了。");
    return {
      screenWidth: requiredNumber(result, "screenWidth"),
      screenHeight: requiredNumber(result, "screenHeight"),
      width: requiredNumber(result, "width"),
      height: requiredNumber(result, "height"),
      summary: typeof result.summary === "string" ? result.summary : "",
      jpeg
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const number = value[key];
  if (typeof number !== "number" || !Number.isFinite(number)) throw new Error("截图尺寸不对。");
  return number;
}

let prebuilt: string | null = null;

/** 电脑 App 的正式包带着编好、签好名的屏幕助手，用它，不在本机编。 */
export function usePrebuiltHelper(bin: string): void {
  prebuilt = bin;
}

function ensureHelper(): Promise<string> {
  if (prebuilt) return Promise.resolve(prebuilt);
  return ensureSwiftBinary({ source: SOURCE, name: "pupu-computer-use" });
}

function run(bin: string, args: string[], stdin?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      const raw = Buffer.concat(out).toString("utf8").trim();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      if (code !== 0) {
        const message =
          parsed && typeof parsed.error === "string"
            ? parsed.error
            : Buffer.concat(err).toString("utf8").trim() || "屏幕操作失败了。";
        reject(new Error(message));
        return;
      }
      resolve(parsed ?? {});
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
