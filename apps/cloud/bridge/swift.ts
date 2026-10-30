import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pupuDir } from "./config.ts";

const building = new Map<string, Promise<string>>();

/**
 * 在本机把一个 Swift 源文件编译成 ~/.pupu/bin 下的程序。源码没变就用上次编好的。
 * 编译要几秒到几十秒，用异步子进程，不卡住桥的连接和心跳。
 */
export function ensureSwiftBinary(input: {
  readonly source: string;
  readonly name: string;
  readonly flags?: readonly string[];
}): Promise<string> {
  const current = building.get(input.name);
  if (current) return current;
  const work = compile(input).finally(() => building.delete(input.name));
  building.set(input.name, work);
  return work;
}

async function compile(input: {
  readonly source: string;
  readonly name: string;
  readonly flags?: readonly string[];
}): Promise<string> {
  const directory = path.join(pupuDir(), "bin");
  const bin = path.join(directory, input.name);
  const flags = input.flags ?? ["-O"];
  const source = await readFile(input.source);
  // 默认参数只按源码算，和以前编好的对得上，免得白白重编：重编后签名变了，
  // 系统设置里给它开的屏幕录制、辅助功能权限可能要重新开。
  const hasher = createHash("sha256").update(source);
  if (input.flags) hasher.update(flags.join(" "));
  const hash = hasher.digest("hex").slice(0, 16);
  const stampPath = `${bin}.sha`;
  const stamp = await readFile(stampPath, "utf8").catch(() => "");
  if (stamp.trim() === hash) return bin;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // 先编到临时文件再换上去，正在跑的旧程序不受影响。
  const temporary = `${bin}.${process.pid}.tmp`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("swiftc", [...flags, "-o", temporary, input.source], { stdio: ["ignore", "ignore", "pipe"] });
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`这台电脑编译不了 ${input.name}，需要 Xcode 命令行工具里的 swiftc：${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(err).toString("utf8").trim() || `${input.name} 编译失败。`));
    });
  });
  await rename(temporary, bin);
  await writeFile(stampPath, hash);
  return bin;
}
