import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, safeStorage } from "electron";

/** 一份设备凭据：配对时云端给的 id、名字和明文凭据。 */
export type Credential = {
  readonly id: string;
  readonly name: string;
  readonly token: string;
};

/**
 * 这台电脑在一个 Pupu 上的两份凭据：窗口用 `desktop`，桥用 `computer`。
 * 两份各自能被吊销，所以都可能是 null。
 */
export type Pairing = {
  readonly desktop: Credential | null;
  readonly computer: Credential | null;
  /**
   * 云端拒了桥的凭据（被吊销了），还没重新配好。`computer` 是 null 不一定是被吊销：配对半路出错时，
   * 窗口的凭据已经存下，这台电脑的还没拿到。老版本存的没有这一项。
   */
  readonly computerRevoked?: boolean;
};

type Stored = { readonly version: 1; readonly servers: Readonly<Record<string, Pairing>> };

const EMPTY: Pairing = { desktop: null, computer: null };

/**
 * 加密后的凭据文件。密钥由 safeStorage 放在钥匙串里，只有 Pupu 自己能取，
 * 别的程序读到这个文件也解不开。桥的文件工具也碰不到它。
 */
export function credentialsPath(): string {
  return path.join(app.getPath("userData"), "credentials.bin");
}

async function readAll(): Promise<Stored> {
  let raw: Buffer;
  try {
    raw = await readFile(credentialsPath());
  } catch {
    return { version: 1, servers: {} };
  }
  // 钥匙串里的密钥没了、或者不让取（换了签名身份），就当没配对过。
  const { result } = await safeStorage.decryptStringAsync(raw);
  const value = JSON.parse(result) as Partial<Stored>;
  return { version: 1, servers: value.servers ?? {} };
}

export async function readPairing(origin: string): Promise<Pairing> {
  const all = await readAll();
  return all.servers[origin] ?? EMPTY;
}

/** 上一次写凭据文件。读改写一次只做一份：两份交错，后写的会把先写的改动盖掉，还会争同一个临时文件。 */
let writing: Promise<void> = Promise.resolve();

/** 改一个 Pupu 的凭据，其余的原样留着。`next` 为 null 就删掉这个 Pupu 的。排在之前的写入后面做。 */
export function writePairing(origin: string, next: Pairing | null): Promise<void> {
  const write = writing.then(() => rewrite(origin, next));
  writing = write.catch(() => {});
  return write;
}

async function rewrite(origin: string, next: Pairing | null): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("这台电脑上的钥匙串用不了，凭据没法加密保存。");
  }
  let all: Stored;
  try {
    all = await readAll();
  } catch {
    all = { version: 1, servers: {} };
  }
  const servers = { ...all.servers };
  if (next && (next.desktop || next.computer)) servers[origin] = next;
  else delete servers[origin];
  const target = credentialsPath();
  if (Object.keys(servers).length === 0) {
    await rm(target, { force: true });
    return;
  }
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  const stored: Stored = { version: 1, servers };
  await writeFile(temporary, await safeStorage.encryptStringAsync(JSON.stringify(stored)), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}
