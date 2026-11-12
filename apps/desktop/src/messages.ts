import type { BrowserReply, BrowserRequest } from "../../cloud/bridge/browser.ts";
import type { BrowserFrame } from "../../cloud/src/bridge/protocol.ts";
import type { BridgeConfig } from "../../cloud/bridge/config.ts";
import type { MenubarAction, MenubarState } from "../../cloud/bridge/menubar.ts";
import type { CaptureCommand, CaptureEvent } from "../../cloud/bridge/remote.ts";

/**
 * 主进程和托管的桥之间的消息，走 utilityProcess 的 MessagePort。
 * 凭据只走这里，不放环境变量：桥跑的命令会继承它的环境变量。
 */
export type ToBridge =
  | {
      readonly type: "config";
      readonly config: BridgeConfig;
      /** 文件工具不让碰的路径：App 的凭据文件，还有命令行桥的 bridge.json。 */
      readonly blocked: readonly string[];
      /** 正式包里放屏幕助手和输入助手的目录，都预先编好、签好名。开发版是 null，桥自己编。 */
      readonly helpers: string | null;
    }
  | { readonly type: "action"; readonly action: MenubarAction }
  /** 推流窗口发来的 offer、候选、输入。 */
  | { readonly type: "capture"; readonly event: CaptureEvent }
  /** Pupu 浏览器做完一步。 */
  | BrowserReply
  /** Pupu 浏览器的一帧画面（敏感格子已经涂掉），桥转给云端。 */
  | { readonly type: "browser-frame"; readonly frame: Omit<BrowserFrame, "type"> }
  | { readonly type: "stop" };

export type FromBridge =
  | { readonly type: "state"; readonly state: MenubarState }
  /** 让推流窗口做事。 */
  | { readonly type: "capture"; readonly command: CaptureCommand }
  /** 让 Pupu 浏览器做一步。 */
  | BrowserRequest
  /** 云端拒了这份凭据：这台电脑被吊销了。桥停下来等新凭据。 */
  | { readonly type: "rejected" };
