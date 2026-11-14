import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, safeStorage } from "electron";
import { parseLocalModel, type LocalModel } from "../../cloud/bridge/model.ts";

/**
 * 这台电脑上的模型（docs/自带模型方案.md）：地址和 key 用 safeStorage 加密，密钥在钥匙串里，只有 Pupu 自己能取。
 * 桥跑的命令读到这个文件也解不开；解开的只交给桥的进程，不放环境变量。
 */
export function localModelPath(): string {
  return path.join(app.getPath("userData"), "model.bin");
}

export async function readLocalModel(): Promise<LocalModel | null> {
  let raw: Buffer;
  try {
    raw = await readFile(localModelPath());
  } catch {
    return null;
  }
  try {
    const { result } = await safeStorage.decryptStringAsync(raw);
    const parsed = parseLocalModel(JSON.parse(result));
    return typeof parsed === "string" ? null : parsed;
  } catch {
    return null;
  }
}

/** 钥匙串用不了，key 没法加密：页面上写这一句（规范 ModelSettings「出错」），系统的原话在 cause 里，只进日志。 */
export class KeychainUnavailable extends Error {
  constructor(cause: unknown) {
    super("这台电脑上的钥匙串用不了，key 没法加密保存。", { cause });
  }
}

export async function writeLocalModel(model: LocalModel | null): Promise<void> {
  const target = localModelPath();
  if (!model) {
    await rm(target, { force: true });
    return;
  }
  // 钥匙串锁着、点了拒绝，可能在问能不能用的时候就说不行，也可能到加密时才出错，两处都算钥匙串用不了。
  let sealed: Buffer;
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("safeStorage 用不了");
    sealed = await safeStorage.encryptStringAsync(JSON.stringify(model));
  } catch (cause) {
    throw new KeychainUnavailable(cause);
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, sealed, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
