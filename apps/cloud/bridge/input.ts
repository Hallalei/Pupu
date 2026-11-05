import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DesktopInput } from "../src/bridge/desktop.ts";
import { ensureSwiftBinary } from "./swift.ts";

const SOURCE = fileURLToPath(new URL("./input.swift", import.meta.url));

let prebuilt: string | null = null;

/** 电脑 App 的正式包带着编好、签好名的输入助手，用它，不在本机编。 */
export function usePrebuiltInput(bin: string): void {
  prebuilt = bin;
}

/**
 * 常驻的输入助手。没编好或者挂了，`onFail` 报一次，由 remote.ts 把控制收回来：
 * 键鼠失灵时不该让手机上的人以为还在操作（参考 Cindy 的 Input failure releases control）。
 */
export class InputHelper {
  readonly #onFail: (message: string) => void;
  #child: ChildProcessWithoutNullStreams | null = null;
  #starting: Promise<void> | null = null;
  #queue: string[] = [];

  constructor(onFail: (message: string) => void) {
    this.#onFail = onFail;
  }

  send(event: DesktopInput): void {
    const line = `${JSON.stringify(event)}\n`;
    if (this.#child) {
      this.#child.stdin.write(line);
      return;
    }
    this.#queue.push(line);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
  }

  /** 松开按住的键，再结束。 */
  stop(): void {
    this.#queue = [];
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    child.removeAllListeners("close");
    child.stdin.end(`${JSON.stringify({ t: "release" })}\n`);
  }

  async #start(): Promise<void> {
    try {
      const bin = prebuilt ?? (await ensureSwiftBinary({ source: SOURCE, name: "pupu-input" }));
      const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
      child.once("error", (error) => this.#failed(child, error.message));
      child.once("close", () => this.#failed(child, "输入助手退出了。"));
      child.stdin.on("error", () => {});
      let rest = "";
      child.stdout.on("data", (chunk: Buffer) => {
        const lines = (rest + chunk.toString("utf8")).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) this.#onLine(child, line);
      });
      this.#child = child;
      for (const line of this.#queue.splice(0)) child.stdin.write(line);
    } catch (error) {
      this.#queue = [];
      this.#onFail(error instanceof Error ? error.message : String(error));
    }
  }

  #onLine(child: ChildProcessWithoutNullStreams, line: string): void {
    let value: { type?: string; accessibility?: boolean; message?: string };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      return;
    }
    if (value.type === "error") this.#failed(child, value.message ?? "键鼠注入失败了。");
    if (value.type === "permissions" && value.accessibility === false) {
      this.#failed(child, "这台电脑没给 Pupu 辅助功能权限，鼠标键盘不会生效。");
    }
  }

  #failed(child: ChildProcessWithoutNullStreams, message: string): void {
    if (this.#child !== child) return;
    this.#child = null;
    child.removeAllListeners("close");
    child.kill();
    this.#onFail(message);
  }
}
