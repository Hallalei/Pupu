import { onActivity, runningCommands, screenActivity, stopAllJobs } from "./actions.ts";
import type { BridgeConfig } from "./config.ts";
import { readLocal, writeLocal } from "./local.ts";
import { menubarState, type Menubar, type MenubarAction, type MenubarProblem } from "./menubar.ts";
import { openBridge, type BridgeConnection } from "./session.ts";

/**
 * 桥常驻时的那一圈：连云端、断了重连，把状态交给界面，处理界面上点的收回、停命令和本机开关。
 * 命令行的 `start` 和电脑 App 托管的桥都走这里，只是凭据从哪来、界面是什么不一样。
 */
export type RunOptions = {
  /** 每次连之前读一次凭据。 */
  readonly config: () => Promise<BridgeConfig>;
  /** 凭据被云端拒了。等它返回再重读凭据。 */
  readonly rejected: () => Promise<void>;
  /** 显示状态的界面：命令行用 Swift 菜单栏，电脑 App 用托盘。 */
  readonly ui: (onAction: (action: MenubarAction) => void) => Menubar;
  /** 文件工具不让碰的路径，挡住凭据文件。 */
  readonly blocked: readonly string[];
};

export type RunningBridge = {
  readonly done: Promise<void>;
  /** 停掉正在跑的命令，断开连接，`done` 随后结束。 */
  stop(): void;
};

export function runBridge(options: RunOptions): RunningBridge {
  let current: BridgeConnection | null = null;
  let stopped = false;
  let config: BridgeConfig | null = null;
  let switches = { allowCommands: true, allowScreen: true };
  let connected = false;
  let problem: MenubarProblem | null = null;
  let cloud: { pending: readonly string[]; screen: boolean } = { pending: [], screen: false };
  // 没连上时点了收回，连上后补发。
  let takebackQueued = false;
  let wake: (() => void) | null = null;

  const takeback = () => {
    cloud = { ...cloud, screen: false };
    takebackQueued = !current?.send({ type: "takeback" });
  };
  const onMenu = async (action: MenubarAction) => {
    if (action.action === "takeback") {
      takeback();
    } else if (action.action === "stopJobs") {
      stopAllJobs();
    } else if (action.action === "setAllowCommands") {
      switches = { ...switches, allowCommands: action.value };
      await writeLocal(switches);
    } else {
      switches = { ...switches, allowScreen: action.value };
      await writeLocal(switches);
      // 关掉屏幕操作，云端的屏幕授权也一起收回。
      if (!action.value) takeback();
    }
    refresh();
  };
  const ui = options.ui((action) => {
    void onMenu(action).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
    });
  });
  const refresh = () => {
    ui.update(
      menubarState({
        connected,
        problem,
        pending: connected ? cloud.pending : [],
        screenGrant: connected && cloud.screen,
        screenActive: screenActivity().active,
        commands: runningCommands().map((job) => job.command),
        allowCommands: switches.allowCommands,
        allowScreen: switches.allowScreen,
        url: config?.url ?? "",
        name: config?.name ?? ""
      })
    );
  };
  const unsubscribe = onActivity(refresh);

  /** 等一会儿再重连；stop() 会提前叫醒。 */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const loop = async () => {
    switches = await readLocal();
    refresh();
    let failures = 0;
    while (!stopped) {
      config = await options.config();
      if (stopped) break;
      refresh();
      const session = openBridge(
        config,
        {
          onReady() {
            connected = true;
            problem = null;
            if (takebackQueued) takebackQueued = !session.send({ type: "takeback" });
            refresh();
          },
          onStatus(status) {
            cloud = { pending: status.pending, screen: status.screen };
            refresh();
          },
          onClosed() {
            connected = false;
            cloud = { pending: [], screen: false };
            refresh();
          }
        },
        options.blocked
      );
      current = session;
      const end = await session.done;
      current = null;
      if (stopped) break;
      if (end === "rejected") {
        problem = "rejected";
        refresh();
        await options.rejected();
        continue;
      }
      if (end === "busy") {
        problem = "busy";
        refresh();
        console.error("这台电脑已经有桥连着。15 秒后再试。");
        await pause(15_000);
        continue;
      }
      failures = session.welcomed() ? 0 : failures + 1;
      const delay = Math.min(10_000, 1000 * 2 ** Math.min(failures, 3));
      console.error("连接断了，正在重连。");
      await pause(delay);
    }
  };

  const done = loop().finally(() => {
    unsubscribe();
    ui.stop();
  });

  return {
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      stopAllJobs();
      current?.close();
      wake?.();
    }
  };
}
