import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * 文件工具只能落在主目录里。已经存在的符号链接按真实路径算，
 * 指到主目录外面的，拒绝。`blocked` 里的绝对路径也不让碰，用来挡住桥自己的凭据。
 */
export async function containPath(
  root: string,
  requested: string,
  blocked: readonly string[] = []
): Promise<string | null> {
  let base: string;
  try {
    base = await realpath(path.resolve(root));
  } catch {
    return null;
  }
  const resolved = await resolveExisting(path.resolve(base, requested || "."));
  if (!resolved || !inside(base, resolved)) return null;
  if (await isBlocked(resolved, blocked)) return null;
  return resolved;
}

/** 凭据文件可能本身是符号链接，字面路径和真实路径都要比。 */
async function isBlocked(resolved: string, blocked: readonly string[]): Promise<boolean> {
  for (const item of blocked) {
    const absolute = path.resolve(item);
    if (absolute === resolved) return true;
    try {
      if ((await realpath(absolute)) === resolved) return true;
    } catch {
      // 这个路径还不存在，字面比较已经算过。
    }
  }
  return false;
}

function inside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** 顺着还存在的祖先做 realpath，缺的那几截再接回去。 */
async function resolveExisting(raw: string): Promise<string | null> {
  const missing: string[] = [];
  let cursor = raw;
  for (let hop = 0; hop < 64; hop += 1) {
    try {
      const real = await realpath(cursor);
      return missing.length === 0 ? real : path.resolve(real, ...missing.reverse());
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
  return null;
}
