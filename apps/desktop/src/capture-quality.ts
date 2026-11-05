import type { DesktopQuality } from "../../cloud/src/bridge/desktop.ts";

export type VideoProfile = {
  readonly maxBitrate: number;
  readonly minBitrateKbps: number;
  readonly startBitrateKbps: number;
  /** 不动的时候换成保清晰。 */
  readonly sharpWhenStill: boolean;
  readonly degradation: RTCDegradationPreference;
  readonly contentHint: "" | "text";
  readonly maxWidth: number;
};

// 三档的数值取自 Cindy 的 apps/desktop/src/shared/remoteDesktopQuality.ts（Apache-2.0）。最宽 1920 是 M0 量过的。
export const PROFILES: Record<DesktopQuality, VideoProfile> = {
  auto: {
    maxBitrate: 20_000_000,
    minBitrateKbps: 1_000,
    startBitrateKbps: 4_000,
    sharpWhenStill: true,
    degradation: "maintain-framerate",
    contentHint: "",
    maxWidth: 1920
  },
  saver: {
    maxBitrate: 2_000_000,
    minBitrateKbps: 500,
    startBitrateKbps: 1_500,
    sharpWhenStill: true,
    degradation: "maintain-framerate",
    contentHint: "",
    maxWidth: 1280
  },
  hd: {
    maxBitrate: 20_000_000,
    minBitrateKbps: 1_000,
    startBitrateKbps: 4_000,
    sharpWhenStill: false,
    degradation: "maintain-resolution",
    contentHint: "text",
    maxWidth: 2560
  }
};

/**
 * 给手机的 answer 里的视频编码加上码率提示，否则 libwebrtc 从 300 kbps 慢慢爬，开头一段全是糊的。
 * 思路同 Cindy 的 withDesktopBitrateHints（Apache-2.0）。
 */
export function withBitrateHints(sdp: string, profile: VideoProfile): string {
  const hints =
    `x-google-start-bitrate=${profile.startBitrateKbps};` +
    `x-google-min-bitrate=${profile.minBitrateKbps};` +
    `x-google-max-bitrate=${Math.round(profile.maxBitrate / 1000)}`;
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const sections: string[][] = [[]];
  for (const line of sdp.split(eol)) {
    if (line.startsWith("m=")) sections.push([]);
    sections[sections.length - 1]!.push(line);
  }
  return sections
    .flatMap((section) => {
      if (!section[0]?.startsWith("m=video")) return section;
      const media = new Set(
        section.flatMap((line) => {
          const match = /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1|H265)\//i.exec(line);
          return match ? [match[1]!] : [];
        })
      );
      const seen = new Set<string>();
      const lines = section.map((line) => {
        const match = /^a=fmtp:(\d+) /.exec(line);
        if (!match || !media.has(match[1]!)) return line;
        seen.add(match[1]!);
        return `${line};${hints}`;
      });
      const missing = [...media].filter((id) => !seen.has(id)).map((id) => `a=fmtp:${id} ${hints}`);
      if (missing.length === 0) return lines;
      // 留在段尾的空行之前。
      const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
      return [...lines.slice(0, end), ...missing, ...lines.slice(end)];
    })
    .join(eol);
}

/** 缩完的宽高要是偶数：3024×1964 缩到 1920 宽是 1920×1247，VideoToolbox 不收奇数边，会退回软件编码（M0 测出来的）。 */
export function evenWidth(width: number, height: number, maxWidth: number): number {
  const target = Math.min(width, maxWidth);
  for (let candidate = target; candidate >= target / 2; candidate -= 2) {
    const scaled = (height * candidate) / width;
    if (Number.isInteger(scaled) && scaled % 2 === 0) return candidate;
  }
  return target;
}
