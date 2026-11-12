/**
 * 把这台电脑上 Chrome 的登录状态（cookie）导进 Pupu 浏览器。只在人点了「从 Chrome 导入」之后跑，模型调不到。
 *
 * macOS 上 Chrome 的 cookie 存在用户资料目录的 Cookies（SQLite）里，值用钥匙串项「Chrome Safe Storage」里的密码加密：
 * PBKDF2-SHA1（盐 "saltysalt"，1003 次）派生 16 字节的 key，AES-128-CBC，IV 是 16 个空格，密文带 "v10" 前缀；
 * 库的 meta.version >= 24 时，明文前面多 32 字节（域名的 SHA-256），要去掉。
 * 这套做法照 yt-dlp 的 yt_dlp/cookies.py（Unlicense，公有领域）写的：MacChromeCookieDecryptor、
 * _get_mac_keyring_password、_decrypt_aes_cbc_multi，以及它引用的 Chromium os_crypt_mac.mm 和 sqlite_persistent_cookie_store.cc。
 *
 * 读钥匙串时 macOS 会弹窗，要人自己点「允许」；这里不替人点，也不绕过。导出来的 cookie 只写进这台电脑的
 * Pupu 浏览器（partition persist:pupu-browser），不落别的文件、不进日志、不上传。
 */
import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ChromeProfile = { readonly dir: string; readonly name: string };

/** 写进 Electron 的 cookie，形状同 Electron.CookiesSetDetails。 */
export type CookieDetails = {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate?: number;
  readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
};

export type ChromeCookieRow = {
  readonly host_key: string;
  readonly name: string;
  readonly value: string;
  readonly encrypted_value: Uint8Array;
  readonly path: string;
  readonly expires_utc: bigint;
  readonly is_secure: bigint;
  readonly is_httponly: bigint;
  readonly samesite: bigint;
  readonly has_expires: bigint;
  readonly top_frame_site_key: string;
};

/** Chrome 的时间从 1601-01-01 起算，单位微秒。 */
const WINDOWS_EPOCH_OFFSET_S = 11_644_473_600n;
const IV = Buffer.alloc(16, " ");

export function defaultChromeDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
}

export function chromeKey(password: string | Buffer): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/** 解一个 cookie 值。解不开（key 不对、格式不认识）返回 null。 */
export function decryptValue(encrypted: Uint8Array, key: Buffer, metaVersion: number): string | null {
  const data = Buffer.from(encrypted);
  if (data.length === 0) return "";
  if (data.subarray(0, 3).toString("latin1") !== "v10") return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    let plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
    if (metaVersion >= 24) plain = plain.subarray(32);
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}

const SAME_SITE: Record<string, CookieDetails["sameSite"]> = { "0": "no_restriction", "1": "lax", "2": "strict" };

/** 一行 Chrome cookie 换成 Electron 的。过期的、分区的（第三方嵌入时的）不要。 */
export function toCookie(row: ChromeCookieRow, value: string, nowSeconds: number): CookieDetails | null {
  if (row.top_frame_site_key) return null;
  const host = row.host_key.replace(/^\./, "");
  if (!host || !row.name) return null;
  const secure = row.is_secure !== 0n;
  let expirationDate: number | undefined;
  if (row.has_expires !== 0n && row.expires_utc > 0n) {
    expirationDate = Number(row.expires_utc / 1_000_000n - WINDOWS_EPOCH_OFFSET_S);
    if (expirationDate <= nowSeconds) return null;
  }
  const cookiePath = row.path || "/";
  // 以点开头的是整个域都带；不以点开头、以及 __Host- 前缀的，只给这一个主机，不写 domain。
  const hostOnly = !row.host_key.startsWith(".") || row.name.startsWith("__Host-");
  return {
    url: `${secure ? "https" : "http"}://${host}${cookiePath}`,
    name: row.name,
    value,
    ...(hostOnly ? {} : { domain: row.host_key }),
    path: cookiePath,
    secure,
    httpOnly: row.is_httponly !== 0n,
    ...(expirationDate !== undefined ? { expirationDate } : {}),
    sameSite: SAME_SITE[String(row.samesite)] ?? "unspecified"
  };
}

/** Chrome 的用户资料：Local State 里 profile.info_cache 记着目录名和显示名。 */
export async function listProfiles(chromeDir: string): Promise<ChromeProfile[]> {
  let state: unknown;
  try {
    state = JSON.parse(await readFile(path.join(chromeDir, "Local State"), "utf8"));
  } catch {
    return [];
  }
  const cache = (state as { profile?: { info_cache?: Record<string, { name?: unknown }> } }).profile?.info_cache ?? {};
  return Object.entries(cache)
    .filter(([dir]) => /^[\w .-]+$/.test(dir) && dir !== "." && dir !== "..")
    .map(([dir, info]) => ({ dir, name: typeof info?.name === "string" && info.name ? info.name : dir }));
}

/**
 * 读出一个用户资料的 cookie 并解开。先把 Cookies 拷到临时目录再读（Chrome 开着时库是锁着的），读完删掉拷贝。
 * 返回能用的和解不开、过期、分区而跳过的个数。不打印任何 cookie 的名字和值。
 */
export async function readChromeCookies(input: {
  readonly chromeDir: string;
  readonly profile: string;
  readonly password: string | Buffer;
  readonly now?: number;
}): Promise<{ cookies: CookieDetails[]; skipped: number }> {
  const source = path.join(input.chromeDir, input.profile, "Cookies");
  const temp = await mkdtemp(path.join(os.tmpdir(), "pupu-chrome-"));
  const copy = path.join(temp, "Cookies");
  try {
    await copyFile(source, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined;
      const metaVersion = Number(meta?.value ?? 0);
      const columns = new Set(
        (db.prepare("PRAGMA table_info(cookies)").all() as { name: string }[]).map((column) => column.name)
      );
      const pick = (name: string, fallback: string) => (columns.has(name) ? name : `${fallback} AS ${name}`);
      const statement = db.prepare(
        `SELECT host_key, name, value, encrypted_value, path, expires_utc, ${pick("is_secure", "0")}, ${pick("is_httponly", "0")}, ${pick("samesite", "-1")}, ${pick("has_expires", "1")}, ${pick("top_frame_site_key", "''")} FROM cookies`
      );
      statement.setReadBigInts(true);
      const rows = statement.all() as unknown as ChromeCookieRow[];
      const key = chromeKey(input.password);
      const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
      const cookies: CookieDetails[] = [];
      let skipped = 0;
      for (const row of rows) {
        const value = row.value ? row.value : decryptValue(row.encrypted_value, key, metaVersion);
        const cookie = value === null ? null : toCookie(row, value, nowSeconds);
        if (cookie) cookies.push(cookie);
        else skipped += 1;
      }
      return { cookies, skipped };
    } finally {
      db.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * 从钥匙串取 Chrome 的加密密码。macOS 会弹窗问要不要允许，要用户自己点。用的是系统自带的 security 命令，
 * 和 yt-dlp 的 _get_mac_keyring_password 一样。测试时不走这里。
 */
export function keychainPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-a", "Chrome", "-s", "Chrome Safe Storage"],
      { timeout: 120_000 },
      (error, stdout) => {
        if (error) {
          reject(new Error("没拿到 Chrome 的钥匙串密码：可能点了「拒绝」，或者这台电脑没装 Chrome。"));
          return;
        }
        resolve(stdout.replace(/\n$/, ""));
      }
    );
  });
}
