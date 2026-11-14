/**
 * 成员的头像。没换过是 null，各端照旧显示名字的第一个字；换过的有两种：
 *
 * - 预设：Pupu 衍生的像素猫，图是静态文件 `/avatars/<id>.png`，由 design/avatars/export.py 生成；
 * - 上传：客户端先裁成正方形、缩到 `AVATAR_SIDE` 再传上来，这边只验不转码（Worker 里没有图片编解码），
 *   验过的原样存进这个 Pupu 的 SQLite，一张二三十 KB。
 *
 * 成员表的 `avatar` 列存 `preset:<id>` 或 `upload:<换的时间>`。时间进了地址，换了图地址就变，各端缓存不会拿到旧图。
 * 只有本人能换自己的头像：接口不收成员 id，换的永远是发请求的设备的主人。
 */

import { AVATAR_PRESETS, PUPU_AVATAR_PRESETS } from "./avatar-presets.ts";

/** 客户端裁好的边长。 */
export const AVATAR_SIDE = 256;
/** 收的边长范围：正方形，太小糊、太大白占地方。 */
const MIN_SIDE = 64;
const MAX_SIDE = 512;
/** 256 的 PNG 照片最多一百多 KB；webp、jpeg 二三十 KB。 */
export const MAX_AVATAR_BYTES = 256 * 1024;

/** 换谁的：自己的，还是 Pupu 的。 */
export type AvatarTarget = "me" | "pupu";

export type AvatarType = "image/png" | "image/jpeg" | "image/webp";

export type StoredAvatar = { readonly type: AvatarType; readonly bytes: Uint8Array<ArrayBuffer>; readonly updatedAt: number };

/** 成员表 `avatar` 列的值。 */
export type AvatarChoice = { readonly kind: "preset"; readonly id: string } | { readonly kind: "upload"; readonly at: number };

/** 两套都认：成员挑小人、Pupu 挑猫是各端摆出来的；以前成员选过的猫还照常显示。 */
export function isPreset(id: unknown): id is string {
  return typeof id === "string" && [...AVATAR_PRESETS, ...PUPU_AVATAR_PRESETS].some((preset) => preset.id === id);
}

export function parseChoice(value: string | null): AvatarChoice | null {
  if (!value) return null;
  const [kind, rest = ""] = value.split(":", 2);
  if (kind === "preset" && isPreset(rest)) return { kind, id: rest };
  if (kind === "upload" && /^\d+$/.test(rest)) return { kind, at: Number(rest) };
  return null;
}

export function formatChoice(choice: AvatarChoice): string {
  return choice.kind === "preset" ? `preset:${choice.id}` : `upload:${choice.at}`;
}

/** 给各端的地址，相对这个 Pupu 的网址。null 是没换过。 */
export function avatarUrl(memberId: string, value: string | null): string | null {
  const choice = parseChoice(value);
  if (!choice) return null;
  if (choice.kind === "preset") return `/avatars/${choice.id}.png`;
  return `/api/members/${encodeURIComponent(memberId)}/avatar?v=${choice.at}`;
}

/**
 * Pupu 自己的头像也用同一套：选择记在 meta 的 `PUPU_AVATAR_META`，上传的图存在同一张表、键是 `PUPU_AVATAR_KEY`
 * （成员 id 是 UUID，撞不上）。只有创建者能换。null 是没换过，各端用自带的 /pupu-avatar.png。
 */
export const PUPU_AVATAR_META = "pupu.avatar";
export const PUPU_AVATAR_KEY = "pupu";

export function pupuAvatarUrl(value: string | null): string | null {
  const choice = parseChoice(value);
  if (!choice) return null;
  if (choice.kind === "preset") return `/avatars/${choice.id}.png`;
  return `/api/pupu/avatar?v=${choice.at}`;
}

/**
 * 切换列表里别的 Pupu 的头像：预设的猫是公开的图，哪个 Pupu 都能显示；上传的图只有那个 Pupu 自己的地址给，这里是 null，客户端用自带的猫。
 */
export function presetAvatarUrl(value: string | null): string | null {
  const choice = parseChoice(value);
  return choice?.kind === "preset" ? `/avatars/${choice.id}.png` : null;
}

/** 认得的图片：看文件头，不信请求说的类型。 */
export function imageInfo(bytes: Uint8Array): { type: AvatarType; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  // PNG：签名 8 字节，紧跟 IHDR，宽高各 4 字节大端。
  if (bytes.length >= 24 && ascii(1, 3) === "PNG" && bytes[0] === 0x89 && ascii(12, 4) === "IHDR") {
    return { type: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  // WebP：RIFF....WEBP，再看是哪种块。
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { type: "image/webp", width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      const uint24 = (at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
      return { type: "image/webp", width: uint24(24) + 1, height: uint24(27) + 1 };
    }
    return null;
  }
  // JPEG：从 SOI 往后跳段，找 SOF。
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1] ?? 0;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      const length = view.getUint16(at + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return { type: "image/jpeg", width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      at += 2 + length;
    }
  }
  return null;
}

export type UploadCheck = { readonly ok: true; readonly type: AvatarType } | { readonly ok: false; readonly error: string };

/** 上传的头像能不能收：PNG、JPEG、WebP，正方形，边长和大小在范围里。 */
export function checkUpload(bytes: Uint8Array): UploadCheck {
  if (bytes.length === 0) return { ok: false, error: "没收到图片" };
  if (bytes.length > MAX_AVATAR_BYTES) return { ok: false, error: `图片太大，最多 ${MAX_AVATAR_BYTES / 1024} KB` };
  const info = imageInfo(bytes);
  if (!info) return { ok: false, error: "只收 PNG、JPEG、WebP" };
  if (info.width !== info.height) return { ok: false, error: "头像要裁成正方形" };
  if (info.width < MIN_SIDE || info.width > MAX_SIDE) {
    return { ok: false, error: `头像边长要在 ${MIN_SIDE} 到 ${MAX_SIDE} 之间` };
  }
  return { ok: true, type: info.type };
}

type Row = Record<string, SqlStorageValue>;

/** Durable Object 给的 BLOB 是 ArrayBuffer；测试里的 node:sqlite 给 Uint8Array。 */
function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  return new Uint8Array();
}

/** 上传的头像，一人一张，换了就覆盖。 */
export class AvatarStore {
  readonly #sql: SqlStorage;
  #ready = false;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  #db(): SqlStorage {
    if (!this.#ready) {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS pupu_member_avatars (
        member_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        bytes BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      this.#ready = true;
    }
    return this.#sql;
  }

  get(memberId: string): StoredAvatar | undefined {
    const [row] = this.#db().exec("SELECT * FROM pupu_member_avatars WHERE member_id = ?", memberId).toArray() as Row[];
    if (!row) return undefined;
    return { type: String(row.type) as AvatarType, bytes: toBytes(row.bytes), updatedAt: Number(row.updated_at) };
  }

  put(memberId: string, type: AvatarType, bytes: Uint8Array, now: number): void {
    const copy = bytes.slice().buffer;
    this.#db().exec(
      `INSERT INTO pupu_member_avatars (member_id, type, bytes, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET type = excluded.type, bytes = excluded.bytes, updated_at = excluded.updated_at`,
      memberId,
      type,
      copy,
      now
    );
  }

  remove(memberId: string): void {
    this.#db().exec("DELETE FROM pupu_member_avatars WHERE member_id = ?", memberId);
  }
}
