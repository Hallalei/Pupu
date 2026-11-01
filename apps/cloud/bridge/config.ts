import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type BridgeConfig = {
  readonly url: string;
  readonly computerId: string;
  readonly token: string;
  readonly name: string;
};

/** 桥的数据目录，默认 ~/.pupu。测试时用 PUPU_DIR 换一个，同一台电脑上跑两套互不干扰。 */
export function pupuDir(): string {
  return process.env.PUPU_DIR || path.join(os.homedir(), ".pupu");
}

export function configPath(): string {
  return path.join(pupuDir(), "bridge.json");
}

export function terminalsDir(): string {
  return path.join(pupuDir(), "terminals");
}

export function requestsDir(): string {
  return path.join(pupuDir(), "requests");
}

export async function readConfig(): Promise<BridgeConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch {
    throw new Error("还没有配对。先运行 pair。");
  }
  let value: Partial<BridgeConfig>;
  try {
    value = JSON.parse(raw) as Partial<BridgeConfig>;
  } catch {
    throw new Error("桥的配置读不了，重新 pair 一次。");
  }
  if (!value.url || !value.computerId || !value.token || !value.name) {
    throw new Error("桥的配置不完整，重新 pair 一次。");
  }
  return {
    url: value.url,
    computerId: value.computerId,
    token: value.token,
    name: value.name
  };
}

export async function writeConfig(config: BridgeConfig): Promise<void> {
  const directory = pupuDir();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = configPath();
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}
