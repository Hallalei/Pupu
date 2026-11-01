import type { BridgeConfig } from "../../cloud/bridge/config.ts";
import type { MenubarAction, MenubarState } from "../../cloud/bridge/menubar.ts";

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
    }
  | { readonly type: "action"; readonly action: MenubarAction }
  | { readonly type: "stop" };

export type FromBridge =
  | { readonly type: "state"; readonly state: MenubarState }
  /** 云端拒了这份凭据：这台电脑被吊销了。桥停下来等新凭据。 */
  | { readonly type: "rejected" };
