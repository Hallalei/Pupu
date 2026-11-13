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

export async function writeLocalModel(model: LocalModel | null): Promise<void> {
  const target = localModelPath();
  if (!model) {
    await rm(target, { force: true });
    return;
  }
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("这台电脑上的钥匙串用不了，key 没法加密保存。");
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, await safeStorage.encryptStringAsync(JSON.stringify(model)), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}
