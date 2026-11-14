import {
  onActivity,
  reconcileRequests,
  reportFinishedTo,
  runningCommands,
  screenActivity,
  stopAllJobs,
  stopCommands
} from "./actions.ts";
import { userPresent } from "./computer.ts";
import type { DesktopInput } from "../src/bridge/desktop.ts";
import type { BrowserFrame } from "../src/bridge/protocol.ts";
import { requestsDir, type BridgeConfig } from "./config.ts";
import { readLocal, writeLocal } from "./local.ts";
import { menubarState, type Menubar, type MenubarAction, type MenubarProblem } from "./menubar.ts";
import { InputHelper } from "./input.ts";
import { discoverMagpie, type Magpie } from "./magpie.ts";
import { infoOf, ModelRelayClient, type LocalModel } from "./model.ts";
import { RemoteAgent, type CaptureCommand, type CaptureEvent } from "./remote.ts";
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
  /** 远程桌面的推流窗口。命令行的桥没有，手机上会说要用电脑 App。 */
  readonly capture?: (command: CaptureCommand) => void;
  /** 开发测试时换掉输入助手，不动真鼠标。 */
  readonly inputSink?: { send(event: DesktopInput): void; stop(): void };
  /** 这台电脑上设的模型，每次连之前读一次。没有就不转发。 */
  readonly model?: () => Promise<LocalModel | null>;
  /** 找这台电脑上的 Magpie。测试时换掉。 */
  readonly magpie?: () => Promise<Magpie | null>;
};

export type RunningBridge = {
  readonly done: Promise<void>;
  /** 推流窗口发来的。 */
  fromCapture(event: CaptureEvent): void;
  /** Pupu 浏览器的一帧画面，转给云端。没连上就丢掉，不攒。 */
  browserFrame(frame: Omit<BrowserFrame, "type">): void;
  /** 电脑前的人接手完浏览器、收起了放大视图。 */
  browserHandback(): void;
  /** 本机的模型设置改了：换掉，连着就告诉云端。 */
  setModel(model: LocalModel | null): void;
  /** 停掉正在跑的命令，断开连接，`done` 随后结束。 */
  stop(): void;
};

/** 连着时多久看一次 Magpie 开没开、模型变没变。只问本机，很便宜。 */
const MAGPIE_POLL_MS = 30_000;

/** 连着时多久看一次有没有人在用电脑。 */
const PRESENCE_POLL_MS = 20_000;

/** 版本对不上时多久再试一次：云端回滚了，或者装了新版的桥，就能连上。 */
const OUTDATED_RETRY_MS = 5 * 60_000;

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
  let localModel: LocalModel | null = null;
  const findMagpie = options.magpie ?? (() => discoverMagpie());
  let magpie: Magpie | null = null;
  // 连续几次没找到。一次超时不算关了，免得对话中途报「Magpie 没开」。
  let magpieMisses = 0;
  // 这条连接上最后报过的清单。换连接时清掉，重报一次。
  let magpieSent: string | null = null;
  const lookMagpie = async (): Promise<void> => {
    const found = await findMagpie().catch(() => null);
    if (found || ++magpieMisses >= 2) {
      magpie = found;
      if (found) magpieMisses = 0;
    }
  };
  const reportMagpie = (session: BridgeConnection | null): void => {
    const key = JSON.stringify(magpie?.models ?? null);
    if (key !== magpieSent && session?.send({ type: "model", message: { kind: "magpie", models: magpie?.models ?? null } })) {
      magpieSent = key;
    }
  };
  const checkMagpie = async (): Promise<Magpie | null> => {
    await lookMagpie();
    reportMagpie(current);
    return magpie;
  };
  const relay = new ModelRelayClient({
    send: (message) => current?.send({ type: "model", message }) ?? false,
    current: () => localModel,
    // 刚打开 Magpie 还没轮到检查时，现问一次。
    magpie: async () => magpie ?? (await checkMagpie())
  });
  const reportModel = () => current?.send({ type: "model", message: { kind: "info", model: infoOf(localModel) } });

  const input = options.inputSink ?? new InputHelper((message) => remote.inputFailed(message));
  const remote: RemoteAgent = new RemoteAgent({
    send: (session, message) => current?.send({ type: "desktop", session, message }),
    capture: options.capture ?? null,
    allowScreen: () => switches.allowScreen,
    input,
    onChange: () => refresh()
  });

  const takeback = () => {
    remote.stop("takeback");
    cloud = { ...cloud, screen: false };
    takebackQueued = !current?.send({ type: "takeback" });
  };
  const onMenu = async (action: MenubarAction) => {
    if (action.action === "takeback") {
      takeback();
    } else if (action.action === "stopJobs") {
      stopCommands();
    } else if (action.action === "stopRemote") {
      remote.stop("takeback");
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
        name: config?.name ?? "",
        remote: remote.status
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
    // 上次桥退出时做到一半的请求先对上账，云端再送来时照实说。
    await reconcileRequests(requestsDir());
    refresh();
    let failures = 0;
    while (!stopped) {
      config = await options.config();
      if (stopped) break;
      if (options.model) localModel = await options.model();
      // 连上之前先找好，ready 时和 info 一起报：晚报的那几秒里云端会当这台电脑的 Pupu 太旧。
      await lookMagpie();
      refresh();
      // 有没有人在用：连上时报一次，之后变了才报。
      let present: boolean | null = null;
      let presenceTimer: ReturnType<typeof setInterval> | undefined;
      let magpieTimer: ReturnType<typeof setInterval> | undefined;
      const checkPresence = async () => {
        const now = await userPresent();
        if (now === null || now === present) return;
        if (session.send({ type: "presence", active: now })) present = now;
      };
      const session = openBridge(
        config,
        {
          onReady() {
            connected = true;
            problem = null;
            if (takebackQueued) takebackQueued = !session.send({ type: "takeback" });
            session.send({ type: "model", message: { kind: "info", model: infoOf(localModel) } });
            magpieSent = null;
            reportMagpie(session);
            magpieTimer ??= setInterval(() => void checkMagpie(), MAGPIE_POLL_MS);
            magpieTimer.unref?.();
            reportFinishedTo((frame) => session.send(frame));
            present = null;
            void checkPresence();
            presenceTimer ??= setInterval(() => void checkPresence(), PRESENCE_POLL_MS);
            presenceTimer.unref?.();
            refresh();
          },
          onStatus(status) {
            cloud = { pending: status.pending, screen: status.screen };
            refresh();
          },
          onDesktop(frame) {
            remote.handle(frame.session, frame.message);
          },
          onModel(frame) {
            relay.receive(frame.message);
          },
          onClosed() {
            reportFinishedTo(null);
            clearInterval(presenceTimer);
            presenceTimer = undefined;
            clearInterval(magpieTimer);
            magpieTimer = undefined;
            connected = false;
            cloud = { pending: [], screen: false };
            // 云端的租约跟着这条连接结束了，点对点的画面和输入不能还开着。
            remote.stop("offline");
            relay.stopAll();
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
      if (end === "outdated") {
        problem = "outdated";
        refresh();
        console.error("这台电脑上的 Pupu 和云端对不上，要更新。过一会儿再试。");
        await pause(OUTDATED_RETRY_MS);
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
    fromCapture: (event) => remote.fromCapture(event),
    browserFrame: (frame) => {
      current?.send({ type: "browser-frame", ...frame });
    },
    browserHandback: () => {
      current?.send({ type: "browser-handback" });
    },
    setModel(model) {
      localModel = model;
      reportModel();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      remote.stop("offline");
      stopAllJobs();
      current?.close();
      wake?.();
    }
  };
}
