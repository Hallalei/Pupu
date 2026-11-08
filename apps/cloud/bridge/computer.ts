import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ComputerAction, UpFrame } from "../src/bridge/protocol.ts";
import type { ActionHost } from "./actions.ts";
import { yieldToHuman } from "./remote.ts";

/** `@trycua/cua-driver` 的 ToolResult，只留用到的字段。 */
export type DriverResult = {
  readonly text: string;
  readonly images: readonly { readonly mimeType: string; readonly dataBase64: string }[];
  readonly structuredJson?: string;
  readonly isError: boolean;
};

export type Driver = {
  callTool(name: string, argumentsJson: string): Promise<DriverResult>;
};

type ToolCall = { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
type Window = { readonly pid: number; readonly windowId: number };

/** `list_windows` 的一行，只留用到的字段。 */
type ListedWindow = {
  readonly pid: number;
  readonly window_id: number;
  readonly app_name: string;
  readonly title: string;
  readonly layer: number;
  readonly z_index?: number | null;
  readonly is_on_screen: boolean;
  readonly on_current_space?: boolean | null;
  readonly bounds: { readonly width: number; readonly height: number };
};

const SDK = "@trycua/cua-driver";

/** 用户上次碰键盘鼠标之后这么久，才让窗口切到前面。取自 Cindy 的 USER_INPUT_ACTIVE。 */
export const USER_QUIET_MS = 3_000;

/** 系统的授权和密码窗口。模型读得到也点得到，放开就能给自己开权限，所以只留给用户。 */
const SYSTEM_PROMPTS: ReadonlySet<string> = new Set(["universalAccessAuthWarn", "SecurityAgent", "coreautha"]);

/** 系统自己的窗口，`computer_windows` 里列出来只是噪音。 */
const SYSTEM_WINDOWS: ReadonlySet<string> = new Set(["WindowManager", "Window Server"]);

let directory: string | null = null;
let loading: Promise<Driver> | null = null;
let foregroundAt = 0;

/** 电脑 App 里 SDK 不在桥旁边的 node_modules，告诉它去哪找。 */
export function useDriverFrom(root: string): void {
  directory = root;
}

/**
 * 整个桥共用一个驱动，跑在桥的进程里：权限跟着 Pupu，不用多装一个应用，也没有驱动自己的上报。
 * `embedded` 让它别去连用户自己装的 CuaDriver.app。
 */
function driver(): Promise<Driver> {
  loading ??= (async () => {
    const entry = directory ? pathToFileURL(path.join(directory, "node_modules", SDK, "dist/index.js")).href : SDK;
    const { CuaDriver } = (await import(entry)) as typeof import("@trycua/cua-driver");
    return CuaDriver.create({ embedded: true, claudeCodeCompatibility: false });
  })();
  return loading;
}

/** 这一步对应驱动的哪个工具。模型只碰得到这张表里的，驱动别的工具（跑脚本、剪贴板、杀进程）它够不着。 */
export function toolCall(action: ComputerAction): ToolCall {
  const window = { pid: action.pid, window_id: action.windowId };
  const spot = action.element ? { element_token: action.element } : { x: action.x, y: action.y };
  const delivery = action.foreground ? { delivery_mode: "foreground" } : {};
  switch (action.op) {
    case "open": {
      const app = action.app ?? "";
      return {
        name: "launch_app",
        args: {
          ...(/^[\w-]+(\.[\w-]+){2,}$/.test(app) ? { bundle_id: app } : { name: app }),
          ...(action.path ? { urls: [action.path] } : {})
        }
      };
    }
    case "click": {
      const name = (action.count ?? 1) >= 2 ? "double_click" : action.button === "right" ? "right_click" : "click";
      return {
        name,
        args: { ...window, ...spot, ...delivery, ...(name === "click" && action.button ? { button: action.button } : {}) }
      };
    }
    case "drag":
      return {
        name: "drag",
        args: {
          ...window,
          ...delivery,
          from_x: action.x,
          from_y: action.y,
          to_x: action.x2,
          to_y: action.y2,
          ...(action.button ? { button: action.button } : {})
        }
      };
    case "scroll":
      return {
        name: "scroll",
        args: { ...window, ...spot, ...delivery, direction: action.direction ?? "down", amount: action.amount ?? 3 }
      };
    case "type":
      return { name: "type_text", args: { ...window, ...spot, ...delivery, text: action.text ?? "" } };
    case "set":
      return { name: "set_value", args: { ...window, element_token: action.element, value: action.text ?? "" } };
    case "key": {
      const keys = (action.key ?? "").split("+").map((key) => KEY_NAMES[key.trim().toLowerCase()] ?? key.trim().toLowerCase());
      const target = { ...window, ...(action.element ? { element_token: action.element } : {}), ...delivery };
      return keys.length > 1
        ? { name: "hotkey", args: { ...target, keys } }
        : { name: "press_key", args: { ...target, key: keys[0] } };
    }
    case "menu":
      return { name: "invoke_menu", args: { ...window, path: action.menu ?? [] } };
    default:
      throw new Error(`${action.op} 不是屏幕输入。`);
  }
}

const KEY_NAMES: Readonly<Record<string, string>> = { enter: "return", esc: "escape", command: "cmd", control: "ctrl", opt: "option" };

/**
 * 做一步屏幕动作。`begin` 在真正点下去之前问一句，云端已经取消了就不做，返回 false。
 * 看窗口、查权限没有副作用，不问。
 */
export async function performComputer(
  requestId: string,
  action: ComputerAction,
  host: ActionHost,
  begin: () => boolean = () => true,
  use: Driver | Promise<Driver> = driver()
): Promise<boolean> {
  const cua = await use;
  if (action.op === "permissions") {
    host.send({ type: "data", requestId, ...textFrame(await permissionText(cua)) });
    return true;
  }
  if (action.op === "windows") {
    const listed = await windows(cua, action.app ? { app: action.app } : {});
    host.send({ type: "data", requestId, ...textFrame(windowList(listed)) });
    return true;
  }
  if (action.op === "look") {
    const window = action.pid !== undefined && action.windowId !== undefined ? (action as Window) : await pickWindow(cua, action.pid);
    await sendLook(requestId, host, cua, window, action.query);
    return true;
  }
  await yieldToHuman();
  await refuseSystemPrompt(cua, action.pid);
  if (action.foreground) await refuseWhileUserActive();
  const { name, args } = toolCall(action);
  if (!begin()) return false;
  const result = await checked(cua, name, args);
  if (action.foreground) foregroundAt = Date.now();
  const window = action.op === "open" ? openedWindow(result) : (action as Window);
  if (window) await sendLook(requestId, host, cua, window, undefined, result.text);
  else host.send({ type: "data", requestId, ...textFrame(result.text) });
  return true;
}

/** 被拒绝的动作都带着原因和下一步怎么办，原样交给模型。权限不够时换成用户看得懂、知道去哪开的话。 */
async function checked(cua: Driver, name: string, args: Readonly<Record<string, unknown>>): Promise<DriverResult> {
  const result = await cua.callTool(name, JSON.stringify(args));
  if (!refused(result)) return result;
  const { accessibility } = await permissions(cua);
  if (!accessibility) throw new Error(`没有辅助功能权限。到系统设置 → 隐私与安全性 → 辅助功能，允许「${grantee()}」。允许了还不行，把它退出再打开。`);
  throw new Error(result.text || `${name} 没做成。`);
}

function refused(result: DriverResult): boolean {
  return result.isError || structured(result).effect === "refused" || structured(result).refusal !== undefined;
}

function structured(result: DriverResult): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(result.structuredJson ?? "{}");
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function permissions(cua: Driver): Promise<{ readonly accessibility: boolean; readonly screen: boolean }> {
  const status = structured(await cua.callTool("check_permissions", "{}"));
  return { accessibility: status.accessibility === true, screen: status.screen_recording === true };
}

async function permissionText(cua: Driver): Promise<string> {
  const { accessibility, screen } = await permissions(cua);
  const access = accessibility ? "辅助功能已允许" : "辅助功能还没允许";
  const capture = screen ? "屏幕录制已允许" : "屏幕录制还没允许";
  return `权限记在「${grantee()}」名下：${access}。${capture}。没允许的话，到系统设置 → 隐私与安全性里给它打开，开了还不行就把它退出再打开。`;
}

/** 系统设置里这两项权限记在谁名下：包着这个进程的应用。电脑 App 开发版是 Electron，单独跑的桥是 node。 */
export function grantee(executable: string = process.execPath): string {
  const app = executable.split("/").find((part) => part.endsWith(".app"));
  return app ? app.slice(0, -".app".length) : path.basename(executable);
}

async function windows(cua: Driver, args: Readonly<Record<string, unknown>>): Promise<readonly ListedWindow[]> {
  return (structured(await checked(cua, "list_windows", args)).windows as readonly ListedWindow[] | undefined) ?? [];
}

function windowList(listed: readonly ListedWindow[]): string {
  const lines = listed
    .filter((window) => !SYSTEM_WINDOWS.has(window.app_name) && window.bounds.width * window.bounds.height > 2_500)
    .sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0))
    .map((window) => {
      const away = window.on_current_space === false ? "，在别的桌面空间或者最小化了" : "";
      return `- ${window.app_name}：${window.title || "没有标题"}，pid ${window.pid}，window_id ${window.window_id}${away}`;
    });
  return lines.length > 0 ? lines.join("\n") : "没有找到窗口。";
}

function highest(listed: readonly ListedWindow[], score: (window: ListedWindow) => number): ListedWindow | null {
  return listed.reduce<ListedWindow | null>((top, window) => (top === null || score(window) > score(top) ? window : top), null);
}

/** 没说看哪个窗口时：给了进程就看它最大的可见窗口，什么都没给就看最前面的普通窗口。 */
async function pickWindow(cua: Driver, pid: number | undefined): Promise<Window> {
  const picked =
    pid === undefined
      ? highest((await windows(cua, { on_screen_only: true })).filter((window) => window.layer === 0), (window) => window.z_index ?? 0)
      : highest(await windows(cua, { pid }), (window) => window.bounds.width * window.bounds.height + (window.is_on_screen ? 1e9 : 0));
  if (!picked) throw new Error("没有找到窗口。用 computer_windows 看看开着哪些。");
  return { pid: picked.pid, windowId: picked.window_id };
}

async function refuseSystemPrompt(cua: Driver, pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  const [owner] = await windows(cua, { pid });
  if (owner && SYSTEM_PROMPTS.has(owner.app_name)) {
    throw new Error("这是系统的授权窗口，只能用户自己处理。告诉用户到电脑上看一下。");
  }
}

function openedWindow(result: DriverResult): Window | null {
  const { pid, windows } = structured(result) as { pid?: number; windows?: readonly { window_id: number }[] };
  const first = windows?.[0];
  return typeof pid === "number" && first ? { pid, windowId: first.window_id } : null;
}

async function sendLook(
  requestId: string,
  host: ActionHost,
  cua: Driver,
  window: Window,
  query?: string,
  done?: string
): Promise<void> {
  const result = await checked(cua, "get_window_state", {
    pid: window.pid,
    window_id: window.windowId,
    screenshot_format: "jpeg",
    screenshot_quality: 60,
    max_image_dimension: 1280,
    ...(query ? { query } : {})
  });
  const tree = [done, `pid=${window.pid} window_id=${window.windowId}`, result.text].filter(Boolean).join("\n");
  const image = result.images[0];
  if (!image) {
    const { screen } = await permissions(cua);
    const hint = screen ? "" : `\n没有屏幕录制权限，看不到图，控件还能用。要看图，到系统设置 → 隐私与安全性 → 屏幕录制，允许「${grantee()}」。`;
    host.send({ type: "data", requestId, ...textFrame(`${tree}${hint}`) });
    return;
  }
  const { screenshot_width: width, screenshot_height: height } = structured(result);
  const frame: UpFrame = {
    type: "picture",
    requestId,
    mime: "image/jpeg",
    width: typeof width === "number" ? width : 0,
    height: typeof height === "number" ? height : 0,
    data: image.dataBase64,
    summary: tree
  };
  host.send(frame);
}

function textFrame(text: string): { readonly bytes: number; readonly text: string } {
  return { bytes: Buffer.byteLength(text), text };
}

/**
 * 切到前面会打断正在用电脑的人，所以先看键盘鼠标。Pupu 自己的前台动作也算系统输入，
 * 只有比它更新的才算用户的。
 */
export async function refuseWhileUserActive(idleMs: () => Promise<number> = hidIdleMs, now: () => number = Date.now): Promise<void> {
  const idle = await idleMs();
  if (idle < USER_QUIET_MS && idle < now() - foregroundAt) {
    throw new Error("用户正在用这台电脑，切到前面会打断他们。等一会儿再试，或者请用户让一下。");
  }
}

function hidIdleMs(): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { maxBuffer: 4_000_000 }, (error, stdout) => {
      const nanoseconds = stdout.match(/"HIDIdleTime" = (\d+)/)?.[1];
      if (error || !nanoseconds) reject(new Error("看不出用户是不是在用电脑，先不切到前面。"));
      else resolve(Number(nanoseconds) / 1_000_000);
    });
  });
}
