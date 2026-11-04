import type { CaptureCommand, CaptureEvent } from "../../cloud/bridge/remote.ts";
import type { DesktopQuality } from "../../cloud/src/bridge/desktop.ts";
import { evenWidth, PROFILES, withBitrateHints, type VideoProfile } from "./capture-quality.ts";

/**
 * 推流页：截屏，用 WebRTC 发给手机，收手机的输入交回桥。跑在隐藏的沙箱窗口里。
 * 编码设置来自 M0（apps/cloud/bridge/desktop/spike/sender.html），画质档位和「不动时变清晰」来自 Cindy 的 captureHost.ts。
 */
declare const pupuCapture: {
  readonly fake: boolean;
  onCommand(handler: (command: CaptureCommand) => void): void;
  send(event: CaptureEvent): void;
  log(line: string): void;
};
declare class ImageCapture {
  constructor(track: MediaStreamTrack);
  grabFrame(): Promise<ImageBitmap>;
}

const FPS = 30;
/** 兼容模式的一帧：最宽 1280，不超过 180 KB。数值取自 Cindy。 */
const JPEG_MAX_EDGE = 1280;
const JPEG_MAX_BYTES = 180 * 1024;

let session = "";
let peer: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let stream: MediaStream | null = null;
let track: MediaStreamTrack | null = null;
let sender: RTCRtpSender | null = null;
let profile: VideoProfile = PROFILES.auto;
let grabber: ImageCapture | null = null;
let answered = false;
let pendingIce: RTCIceCandidateInit[] = [];
let timers: ReturnType<typeof setInterval>[] = [];
let still = false;
let lastFrames: { frames: number; at: number } | null = null;
let grabbing = false;
let loggedAt = 0;

function fail(message: string): void {
  pupuCapture.send({ type: "failed", session, message });
}

/** 开发时的假画面：一块会动的彩条，不碰真屏幕。 */
function fakeStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  const context = canvas.getContext("2d")!;
  let step = 0;
  timers.push(
    setInterval(() => {
      step += 1;
      context.fillStyle = `hsl(${step % 360} 60% 45%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#fff";
      context.font = "64px sans-serif";
      context.fillText(`Pupu ${new Date().toLocaleTimeString()}`, 80, 160);
      context.fillRect((step * 8) % canvas.width, 400, 80, 80);
    }, 1000 / FPS)
  );
  return canvas.captureStream(FPS);
}

function preferH264(transceiver: RTCRtpTransceiver): void {
  const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
  const rank = (codec: RTCRtpCodec) => {
    const fmtp = codec.sdpFmtpLine ?? "";
    return Number(/packetization-mode=1/.test(fmtp)) * 2 + Number(/profile-level-id=64/.test(fmtp));
  };
  // High 排前面：手机答 Constrained Baseline 时这台 Mac 退回软件的 OpenH264（M0 测到的）。
  // 手机那边的解码器也要声明这个 High，见 DesktopDecoderFactory。
  const picked = codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/h264").sort((a, b) => rank(b) - rank(a));
  if (picked.length === 0) return;
  const extras = codecs.filter((codec) => /\/(rtx|red|ulpfec)$/i.test(codec.mimeType));
  transceiver.setCodecPreferences([...picked, ...extras]);
}

/** 把现在的档位和动静写到编码器上。 */
async function applyEncoder(): Promise<void> {
  if (!sender || !track) return;
  const sharp = profile.sharpWhenStill && still;
  track.contentHint = sharp ? "text" : profile.contentHint;
  const parameters = sender.getParameters();
  (parameters as RTCRtpSendParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference =
    sharp ? "maintain-resolution" : profile.degradation;
  const settings = track.getSettings();
  const width = settings.width ?? profile.maxWidth;
  const height = settings.height ?? 0;
  for (const encoding of parameters.encodings) {
    encoding.maxBitrate = profile.maxBitrate;
    encoding.maxFramerate = FPS;
    if (height > 0) encoding.scaleResolutionDownBy = Math.max(1, width / evenWidth(width, height, profile.maxWidth));
  }
  await sender.setParameters(parameters).catch((error: unknown) => pupuCapture.log(`设不了编码参数：${String(error)}`));
}

/** 屏幕不动时截屏不出新帧，看发出去的帧数就知道动没动。 */
async function watch(): Promise<void> {
  if (!peer || !sender) return;
  const report = await sender.getStats();
  report.forEach((entry: RTCStats & { framesEncoded?: number; encoderImplementation?: string; frameWidth?: number; frameHeight?: number; framesPerSecond?: number }) => {
    if (entry.type !== "outbound-rtp" || entry.framesEncoded === undefined) return;
    const now = performance.now();
    if (now - loggedAt > 10_000) {
      loggedAt = now;
      pupuCapture.log(`编码：${entry.encoderImplementation ?? "?"}，${entry.frameWidth ?? 0}×${entry.frameHeight ?? 0}，${entry.framesPerSecond ?? 0} 帧`);
    }
    if (lastFrames) {
      const seconds = (now - lastFrames.at) / 1000;
      const moving = (entry.framesEncoded - lastFrames.frames) / seconds >= 2;
      if (moving === still) {
        still = !moving;
        void applyEncoder();
      }
    }
    lastFrames = { frames: entry.framesEncoded, at: now };
  });
}

async function start(command: Extract<CaptureCommand, { type: "start" }>): Promise<void> {
  session = command.session;
  profile = PROFILES[command.quality];
  try {
    stream = pupuCapture.fake
      ? fakeStream()
      : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: FPS, max: FPS } }, audio: false });
  } catch (error) {
    fail(`截不了屏：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  track = stream.getVideoTracks()[0] ?? null;
  if (!track) {
    fail("截屏没有画面。");
    return;
  }
  track.addEventListener("ended", () => fail("截屏停了。"));
  grabber = new ImageCapture(track);
  const connection = new RTCPeerConnection({ iceServers: command.iceServers as RTCIceServer[] });
  peer = connection;
  const transceiver = connection.addTransceiver(track, { direction: "sendonly", streams: [stream] });
  sender = transceiver.sender;
  preferH264(transceiver);
  channel = connection.createDataChannel("input-v1", { ordered: true });
  channel.onmessage = (event) => {
    let value: unknown;
    try {
      value = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const message = value as { t?: string; c?: number };
    if (message.t === "ping") {
      channel?.send(JSON.stringify({ t: "pong", c: message.c }));
      return;
    }
    pupuCapture.send({ type: "input", session, event: value as never });
  };
  connection.onicecandidate = (event) => {
    if (!event.candidate) return;
    pupuCapture.send({
      type: "ice",
      session,
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex
    });
  };
  connection.onconnectionstatechange = () => pupuCapture.log(`连接：${connection.connectionState}`);
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await applyEncoder();
  timers.push(setInterval(() => void watch(), 1000));
  pupuCapture.send({ type: "offer", session, sdp: offer.sdp ?? "" });
}

async function setAnswer(sdp: string): Promise<void> {
  await peer?.setRemoteDescription({ type: "answer", sdp: withBitrateHints(sdp, profile) });
  answered = true;
  for (const candidate of pendingIce.splice(0)) await peer?.addIceCandidate(candidate).catch(() => {});
}

function setQuality(quality: DesktopQuality): void {
  profile = PROFILES[quality];
  void applyEncoder();
}

/** 视频连不上时手机来要的一帧。一次只出一帧。 */
async function grabJpeg(): Promise<void> {
  if (!grabber || grabbing) return;
  grabbing = true;
  try {
    const bitmap = await grabber.grabFrame();
    let scale = Math.min(1, JPEG_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    // 先降质量，再缩小，和 Cindy 的 encodeCaptureSurface 一个顺序。
    for (const quality of [0.7, 0.5, 0.35, 0.25, 0.25, 0.25]) {
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= JPEG_MAX_BYTES) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        pupuCapture.send({ type: "frame", session, data: btoa(binary), width: canvas.width, height: canvas.height });
        break;
      }
      if (quality === 0.25) scale *= 0.75;
    }
    bitmap.close();
  } catch (error) {
    pupuCapture.log(`这一帧没截到：${String(error)}`);
  } finally {
    grabbing = false;
  }
}

pupuCapture.onCommand((command) => {
  const run = async () => {
    switch (command.type) {
      case "start":
        await start(command);
        break;
      case "answer":
        await setAnswer(command.sdp);
        break;
      case "ice": {
        const { candidate, sdpMid, sdpMLineIndex } = command;
        const init: RTCIceCandidateInit = { candidate, sdpMid, sdpMLineIndex };
        if (answered) await peer?.addIceCandidate(init);
        else pendingIce.push(init);
        break;
      }
      case "quality":
        setQuality(command.quality);
        break;
      case "jpeg":
        await grabJpeg();
        break;
      case "stop":
        break;
    }
  };
  run().catch((error: unknown) => pupuCapture.log(`${command.type} 出错：${String(error)}`));
});
