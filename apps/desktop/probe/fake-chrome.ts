/**
 * 造一个假的 Chrome 用户资料目录，测试和本地验证导入用。只用假密码、假 cookie，从不碰真的 Chrome。
 * 用法：node probe/fake-chrome.ts <目录> <密码> [meta 版本]
 */
import { createCipheriv, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromeKey } from "../src/chrome-import.ts";

export type FakeCookie = {
  readonly host: string;
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  /** 秒，Unix 时间。不给就是会话 cookie。 */
  readonly expires?: number;
  readonly sameSite?: -1 | 0 | 1 | 2;
  readonly partition?: string;
  /** 存明文（老版本 Chrome 那样），不加密。 */
  readonly plain?: boolean;
};

export function encrypt(value: string, password: string, host: string, metaVersion: number): Buffer {
  const prefix = metaVersion >= 24 ? createHash("sha256").update(host).digest() : Buffer.alloc(0);
  const cipher = createCipheriv("aes-128-cbc", chromeKey(password), Buffer.alloc(16, " "));
  return Buffer.concat([Buffer.from("v10"), cipher.update(Buffer.concat([prefix, Buffer.from(value)])), cipher.final()]);
}

export async function makeFakeChrome(
  dir: string,
  password: string,
  cookies: readonly FakeCookie[],
  options: { metaVersion?: number; profile?: string; name?: string } = {}
): Promise<void> {
  const profile = options.profile ?? "Default";
  const metaVersion = options.metaVersion ?? 24;
  await mkdir(path.join(dir, profile), { recursive: true });
  await writeFile(
    path.join(dir, "Local State"),
    JSON.stringify({ profile: { info_cache: { [profile]: { name: options.name ?? "测试用户" } } } })
  );
  const db = new DatabaseSync(path.join(dir, profile, "Cookies"));
  db.exec(`CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL,
      value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL,
      priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL);`);
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(metaVersion));
  const insert = db.prepare(
    "INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 2, 443)"
  );
  for (const cookie of cookies) {
    const expires = cookie.expires === undefined ? 0n : (BigInt(cookie.expires) + 11_644_473_600n) * 1_000_000n;
    insert.run(
      13_300_000_000_000_000n,
      cookie.host,
      cookie.partition ?? "",
      cookie.name,
      cookie.plain ? cookie.value : "",
      cookie.plain ? Buffer.alloc(0) : encrypt(cookie.value, password, cookie.host, metaVersion),
      cookie.path ?? "/",
      expires,
      cookie.secure === false ? 0 : 1,
      cookie.httpOnly ? 1 : 0,
      13_300_000_000_000_000n,
      cookie.expires === undefined ? 0 : 1,
      cookie.expires === undefined ? 0 : 1,
      cookie.sameSite ?? -1
    );
  }
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, password, version] = process.argv.slice(2);
  if (!dir || !password) {
    console.error("用法：node probe/fake-chrome.ts <目录> <密码> [meta 版本]");
    process.exit(1);
  }
  const later = Math.floor(Date.now() / 1000) + 30 * 86_400;
  await makeFakeChrome(dir, password, [
    { host: "127.0.0.1", name: "pupu_demo_session", value: "logged-in-as-xiaomao", expires: later, secure: false, httpOnly: true, sameSite: 1 },
    { host: ".example.com", name: "fake_pref", value: "dark", expires: later }
  ], { metaVersion: Number(version ?? 24) });
  console.log(`假的 Chrome 用户资料造好了：${dir}`);
}
