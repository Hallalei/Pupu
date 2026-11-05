import assert from "node:assert/strict";
import test from "node:test";
import { evenWidth, PROFILES, withBitrateHints } from "./capture-quality.ts";

const SDP = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98",
  "a=rtpmap:96 H264/90000",
  "a=fmtp:96 packetization-mode=1",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
  "a=rtpmap:98 VP8/90000",
  ""
].join("\r\n");

test("码率提示只加在视频编码上，没有 fmtp 的补一行", () => {
  const lines = withBitrateHints(SDP, PROFILES.saver).split("\r\n");
  const hints = "x-google-start-bitrate=1500;x-google-min-bitrate=500;x-google-max-bitrate=2000";
  assert.ok(lines.includes(`a=fmtp:96 packetization-mode=1;${hints}`));
  assert.ok(lines.includes(`a=fmtp:98 ${hints}`));
  assert.ok(lines.includes("a=fmtp:97 apt=96"));
  assert.ok(lines.includes("a=fmtp:111 minptime=10"));
  assert.equal(lines.at(-1), "");
});

test("缩放后的宽高都是偶数，VideoToolbox 才收", () => {
  const width = evenWidth(3024, 1964, 1920);
  assert.ok(width <= 1920 && width % 2 === 0);
  const height = (1964 * width) / 3024;
  assert.ok(Number.isInteger(height) && height % 2 === 0);
  assert.equal(evenWidth(1280, 800, 1920), 1280);
});
