import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { AVATAR_PRESETS } from "../src/avatar-presets.ts";
import { AvatarStore, avatarUrl, pupuAvatarUrl, checkUpload, formatChoice, imageInfo, isPreset, MAX_AVATAR_BYTES, parseChoice } from "../src/avatars.ts";
import { MemberStore, memberView } from "../src/members.ts";
import { sqlStorage } from "./sql-memory.ts";

const NOW = 1_800_000_000_000;

function png(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(33 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** SOI，一个 APP0 段，再是 SOF0。 */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0),
    0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...new Array(9).fill(0)
  ]);
  return bytes;
}

function webpLossless(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  bytes[20] = 0x2f;
  new DataView(bytes.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return bytes;
}

function webpExtended(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  const put24 = (at: number, value: number) => bytes.set([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff], at);
  put24(24, width - 1);
  put24(27, height - 1);
  return bytes;
}

describe("认图片", () => {
  test("看文件头认出类型和宽高", () => {
    assert.deepEqual(imageInfo(png(256, 128)), { type: "image/png", width: 256, height: 128 });
    assert.deepEqual(imageInfo(jpeg(300, 200)), { type: "image/jpeg", width: 300, height: 200 });
    assert.deepEqual(imageInfo(webpLossless(256, 256)), { type: "image/webp", width: 256, height: 256 });
    assert.deepEqual(imageInfo(webpExtended(512, 512)), { type: "image/webp", width: 512, height: 512 });
  });

  test("不认的：SVG、GIF、乱码", () => {
    assert.equal(imageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    assert.equal(imageInfo(new TextEncoder().encode("GIF89a................")), null);
    assert.equal(imageInfo(new Uint8Array(40)), null);
  });
});

describe("收不收上传", () => {
  test("正方形、边长 64 到 512、不超过上限才收", () => {
    assert.deepEqual(checkUpload(png(256, 256)), { ok: true, type: "image/png" });
    assert.deepEqual(checkUpload(jpeg(256, 256)), { ok: true, type: "image/jpeg" });
    assert.equal(checkUpload(png(256, 200)).ok, false, "不是正方形");
    assert.equal(checkUpload(png(32, 32)).ok, false, "太小");
    assert.equal(checkUpload(png(1024, 1024)).ok, false, "太大");
    assert.equal(checkUpload(png(256, 256, MAX_AVATAR_BYTES)).ok, false, "字节超了");
    assert.equal(checkUpload(new Uint8Array()).ok, false, "空的");
    assert.equal(checkUpload(new TextEncoder().encode("<svg/>".padEnd(64))).ok, false, "SVG 不收");
  });
});

describe("头像的值和地址", () => {
  test("预设只认清单里的 id", () => {
    assert.ok(AVATAR_PRESETS.length >= 8 && AVATAR_PRESETS.length <= 24);
    assert.equal(isPreset(AVATAR_PRESETS[0]?.id), true);
    assert.equal(isPreset("../../etc/passwd"), false);
    assert.equal(parseChoice("preset:nope"), null);
  });

  test("存的值来回一样，地址里带着换的时间", () => {
    const preset = parseChoice(formatChoice({ kind: "preset", id: "black" }));
    assert.deepEqual(preset, { kind: "preset", id: "black" });
    assert.equal(avatarUrl("m1", "preset:black"), "/avatars/black.png");
    assert.equal(avatarUrl("m1", formatChoice({ kind: "upload", at: NOW })), `/api/members/m1/avatar?v=${NOW}`);
    assert.equal(avatarUrl("m1", null), null);
    assert.equal(avatarUrl("m1", "upload:abc"), null);
    // Pupu 自己的：空字符串（换回原来的）和 null 一样，都是用自带的。
    assert.equal(pupuAvatarUrl("preset:black"), "/avatars/black.png");
    assert.equal(pupuAvatarUrl(formatChoice({ kind: "upload", at: NOW })), `/api/pupu/avatar?v=${NOW}`);
    assert.equal(pupuAvatarUrl(""), null);
    assert.equal(pupuAvatarUrl(null), null);
  });
});

describe("存头像", () => {
  test("成员表记下选了什么，没换过是 null", () => {
    const members = new MemberStore(sqlStorage());
    const creator = members.addCreator("owner@example.com", NOW);
    assert.ok(creator);
    assert.equal(memberView(creator, null).avatar, null);
    members.setAvatar(creator.id, "preset:gray");
    const row = members.byId(creator.id);
    assert.ok(row);
    assert.equal(memberView(row, creator.id).avatar, "/avatars/gray.png");
    members.setAvatar(creator.id, null);
    assert.equal(members.byId(creator.id)?.avatar, null);
  });

  test("上传的图一人一张，换了覆盖，删了就没了", () => {
    const store = new AvatarStore(sqlStorage());
    assert.equal(store.get("m1"), undefined);
    store.put("m1", "image/png", png(256, 256), NOW);
    store.put("m1", "image/jpeg", jpeg(256, 256), NOW + 1);
    const stored = store.get("m1");
    assert.equal(stored?.type, "image/jpeg");
    assert.equal(stored?.updatedAt, NOW + 1);
    assert.deepEqual(stored?.bytes, new Uint8Array(jpeg(256, 256)));
    store.remove("m1");
    assert.equal(store.get("m1"), undefined);
  });
});
