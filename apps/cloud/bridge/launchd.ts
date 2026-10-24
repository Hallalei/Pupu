import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pupuDir } from "./config.ts";

const LABEL = "com.pupu.bridge";

export function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function renderPlist(node: string, script: string, logFile: string): string {
  const args = [node, script, "start"]
    .map((item) => `    <string>${escapeXml(item)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent(node: string, script: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("launchd 只在 macOS 上安装。其他系统直接运行 start。");
  }
  const logFile = path.join(pupuDir(), "bridge.log");
  const target = plistPath();
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(pupuDir(), { recursive: true, mode: 0o700 });
  await writeFile(target, renderPlist(node, script, logFile));
  const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
  spawnSync("launchctl", ["bootout", domain, target], { stdio: "ignore" });
  const loaded = spawnSync("launchctl", ["bootstrap", domain, target], { encoding: "utf8" });
  if (loaded.status !== 0) {
    throw new Error(loaded.stderr || "launchctl bootstrap 失败");
  }
  return target;
}

export async function uninstallLaunchAgent(): Promise<void> {
  if (process.platform !== "darwin") return;
  const target = plistPath();
  const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
  spawnSync("launchctl", ["bootout", domain, target], { stdio: "ignore" });
  await rm(target, { force: true });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
