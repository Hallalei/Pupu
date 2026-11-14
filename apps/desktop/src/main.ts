/**
 * Pupu 电脑 App 的主进程（技术方案 5.3、5.4）：
 * - 托盘常驻，关掉窗口不退出；从托盘或 ⌘Q 退出，这台电脑就下线；
 * - 用 utilityProcess 托管桥，挂了就重启；
 * - 窗口加载线上网页，开 sandbox 和 contextIsolation，只能在 Pupu 自己的域名里跳转；
 * - 第一次打开时用 Google 登录（在系统浏览器里登）或配对码，窗口和桥各拿一份凭据，用 safeStorage 加密存放。
 */
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents
} from "electron";
import { BROWSER_PARTITION, BrowserHost } from "./browser-host.ts";
import { defaultChromeDir, keychainPassword, listProfiles, readChromeCookies } from "./chrome-import.ts";
import { CaptureHost } from "./capture.ts";
import { configPath, readConfig } from "../../cloud/bridge/config.ts";
import { readLocal, writeLocal, type LocalSwitches } from "../../cloud/bridge/local.ts";
import type { MenubarAction, MenubarState } from "../../cloud/bridge/menubar.ts";
import type { DesktopComputer, DesktopSwitch, LocalModelView, PrivacyPane } from "../../cloud/src/client/desktop.ts";
import { modelPath, parseLocalModel, type LocalModel } from "../../cloud/bridge/model.ts";
import { probeModel } from "../../cloud/src/model/probe.ts";
import { localModelPath, readLocalModel, writeLocalModel } from "./local-model.ts";
import { credentialsPath, readPairing, writePairing, type Credential, type Pairing } from "./credentials.ts";
import { debugSwitches, devVariables } from "./env.ts";
import { challengeOf, newVerifier, receiveCode } from "./loopback.ts";
import { desktopStatus, googleEnabled, pairComputer, pairDesktop, redeemSignIn } from "./pairing.ts";
import {
  computerAuth,
  PairingRun,
  reasonOf,
  rejectComputer,
  rejectDesktop,
  withComputer,
  withDesktop,
  type PairingStatus
} from "./pairing-state.ts";
import { createPairWindow, type GoogleRequest, type PairingInfo, type PairingRequest } from "./pairing-window.ts";
import { BridgeSupervisor } from "./supervisor.ts";
import { PupuTray } from "./tray.ts";
import type { TrayAction, TrayView } from "./tray-menu.ts";
import { startUpdates } from "./updates.ts";
import { readWithLegacy } from "./legacy-pairing.ts";
import { canOpenExternally, computerName, DEFAULT_URL, isLocalOrigin, LEGACY_URLS, originOf, sameOrigin } from "./urls.ts";
import { computerView } from "./view.ts";
import { windowChrome } from "./window-chrome.ts";

/** 和 apps/cloud/src/server.ts 里的 TOKEN_COOKIE 一样：窗口的凭据放进 HttpOnly cookie。 */
const TOKEN_COOKIE = "pupu_token";
const PARTITION = "persist:pupu";
const PRIVACY_PANES: Record<PrivacyPane, string> = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
};

/** 正式包带着调试开关启动就直接退出（技术方案 5.5）。 */
const refused = app.isPackaged ? debugSwitches(process.argv) : [];
if (app.isPackaged) {
  // 正式包不认开发用的环境变量。桥继承主进程的环境变量，PUPU_DIR 这些一并去掉。
  for (const key of devVariables()) delete process.env[key];
}

// 开发时可以用 PUPU_URL 连本机的 wrangler dev；正式包只连线上，免得被人用环境变量引到别处去配对。
const origin = originOf((!app.isPackaged && process.env.PUPU_URL) || DEFAULT_URL);
const dataName = app.isPackaged ? "Pupu" : "Pupu Dev";
/**
 * 开发时测试用：PUPU_BACKGROUND=1 时 App 不进程序坞、窗口不抢前台，配合 `open -g` 启动，
 * 用户手上的活不被打断。界面用 CDP（--remote-debugging-port）读 DOM、截图来看。
 */
const background = !app.isPackaged && process.env.PUPU_BACKGROUND === "1";
/** 带 --tray 启动（本机换新版后重开时用）：已经配对就只进菜单栏，不开窗口，免得打断用户。 */
const trayStart = process.argv.includes("--tray");

app.setName("Pupu");
// 开发时可以用 PUPU_USER_DATA 另开一份数据，同时跑两个互不干扰的 App 来测。
app.setPath("userData", (!app.isPackaged && process.env.PUPU_USER_DATA) || path.join(app.getPath("appData"), dataName));
app.setAppLogsPath(path.join(os.homedir(), "Library", "Logs", dataName));

let pairing: Pairing = { desktop: null, computer: null };
let bridgeState: MenubarState | null = null;
let switches: LocalSwitches = { allowCommands: true, allowScreen: true };
/** 这台电脑上设的模型，解密后的，只在主进程和桥里。 */
let localModel: LocalModel | null = null;
let mainWindow: BrowserWindow | null = null;
let pairWindow: BrowserWindow | null = null;
let tray: PupuTray | null = null;
let capture: CaptureHost | null = null;
let browser: BrowserHost | null = null;
let mainLog: WriteStream | null = null;
let bridgeLog: WriteStream | null = null;
let quitting = false;
/** 下好了、等重启的新版本。 */
let update: string | null = null;

const LOAD_TIMEOUT_MS = 15_000;

const dist = (name: string) => path.join(__dirname, name);
/** 正式包里带着编好、签好名的屏幕助手和输入助手；开发版是 null，桥照旧在本机编到 ~/.pupu/bin。 */
const helpers = app.isPackaged ? path.join(process.resourcesPath, "helpers") : null;

// ── 日志 ──────────────────────────────────────────────────────────────

function openLog(name: string): WriteStream {
  const directory = app.getPath("logs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, name);
  try {
    if (statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.old`);
  } catch {
    // 还没有这个文件。
  }
  return createWriteStream(file, { flags: "a", mode: 0o600 });
}

function write(stream: WriteStream | null, line: string): void {
  const text = `${new Date().toISOString()} ${line}\n`;
  stream?.write(text);
  if (!app.isPackaged) process.stdout.write(text);
}

function log(line: string): void {
  write(mainLog, line);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 桥 ────────────────────────────────────────────────────────────────

const supervisor = new BridgeSupervisor(dist("bridge.mjs"), {
  onState(state) {
    bridgeState = state;
    switches = { allowCommands: state.allowCommands, allowScreen: state.allowScreen };
    render();
  },
  onRejected() {
    void computerRejected();
  },
  onCapture(command) {
    capture?.command(command);
  },
  onBrowser(request) {
    browser ??= newBrowser();
    void browser.run(request.op).then((result) => supervisor.browserReply({ type: "browser-result", id: request.id, result }));
  },
  onCrash(code, delay) {
    log(`桥退出了（${code}），${Math.round(delay / 1000)} 秒后重启。`);
    bridgeState = null;
    capture?.stop();
    render();
  },
  log(line) {
    write(bridgeLog, line);
  }
});

function newBrowser(): BrowserHost {
  return new BrowserHost({ log, takeover: openTakeover, onFrame: (frame) => supervisor.browserFrame(frame) });
}

/**
 * 人来接手：主窗口里盖住对话区的放大视图，里面是真实页面（WebContentsView 挂在主窗口里），不弹单独的窗口。
 * 主进程记着要不要开：主窗口刚打开时页面还没加载，一次性的消息会丢，页面加载好后自己来问（`pupu:browser-takeover-state`）。
 * 页面量好占位框再调 `pupu:browser-attach` 把真实页面挂上去；关掉时调 `pupu:browser-detach`，页面回到后台。
 */
let takeoverOpen = false;

async function openTakeover(): Promise<{ ok: boolean; text: string }> {
  if (!pairing.desktop) return { ok: false, text: "这台电脑上的 Pupu 还没登录，打不开接手的界面。" };
  takeoverOpen = true;
  await openMain();
  if (!mainWindow || mainWindow.isDestroyed()) {
    takeoverOpen = false;
    return { ok: false, text: "这台电脑上的 Pupu 主窗口没打开。" };
  }
  sendTakeover();
  log("要人接手：在主窗口里打开浏览器页面。");
  return {
    ok: true,
    text: "已经在这台电脑的 Pupu 主窗口里打开了浏览器页面，电脑前的人可以直接在里面操作。等他说好了再继续。"
  };
}

function sendTakeover(): void {
  const contents = mainWindow?.webContents;
  if (contents && sameOrigin(contents.getURL(), origin)) contents.send("pupu:browser-takeover", takeoverOpen);
}

/**
 * 收起接手的界面：页面回到后台，任务接着做。主窗口关了、刷新了、渲染进程没了，都走这里，免得页面盖在对话上下不来。
 * `handback` 是人接手完了点的「收起」：告诉云端，等着的对话自己接着做，人不用再回来说一声；点「取消任务」收起的不算。
 */
function closeTakeover(reason: string, handback = false): void {
  if (!takeoverOpen && !browser?.attachedTo()) return;
  takeoverOpen = false;
  browser?.detach();
  if (handback) {
    browser?.handedBack();
    supervisor.browserHandback();
  }
  log(`收起接手的界面：${reason}`);
  sendTakeover();
}

function visibleWindows(): string {
  const shown = BrowserWindow.getAllWindows().filter((window) => window.isVisible());
  return shown.map((window) => `「${window.getTitle()}」${window === mainWindow ? "（主窗口）" : ""}`).join("、") || "没有";
}

/** 页面给的占位框，换成主窗口内容区里的整数坐标，超出的部分裁掉。 */
function takeoverBounds(window: BrowserWindow, value: unknown): Electron.Rectangle | null {
  const rect = (value ?? {}) as Record<string, unknown>;
  const [x, y, width, height] = [rect.x, rect.y, rect.width, rect.height].map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : NaN));
  if ([x, y, width, height].some((n) => Number.isNaN(n))) return null;
  const [contentWidth, contentHeight] = window.getContentSize();
  const left = Math.max(0, Math.min(x!, contentWidth!));
  const top = Math.max(0, Math.min(y!, contentHeight!));
  const right = Math.max(left, Math.min(x! + width!, contentWidth!));
  const bottom = Math.max(top, Math.min(y! + height!, contentHeight!));
  if (right - left < 40 || bottom - top < 40) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 开发版可以换成假的 Chrome 用户资料目录和假密码来测导入，不碰真的 Chrome、不弹钥匙串。正式包不认这两个变量。
 */
const fakeChrome =
  !app.isPackaged && process.env.PUPU_CHROME_DIR && process.env.PUPU_CHROME_TEST_PASSWORD
    ? { dir: process.env.PUPU_CHROME_DIR, password: process.env.PUPU_CHROME_TEST_PASSWORD }
    : null;

function chromeDir(): string {
  return fakeChrome?.dir ?? defaultChromeDir();
}

/** 人在「这台电脑」页上点了从 Chrome 导入。只回个数，不回也不记 cookie 的名字和值。 */
async function importChrome(profile: string): Promise<{ ok: true; imported: number; skipped: number } | { ok: false; error: string }> {
  const profiles = await listProfiles(chromeDir());
  if (!profiles.some((item) => item.dir === profile)) return { ok: false, error: "没找到这个 Chrome 用户资料。" };
  let password: string;
  if (fakeChrome) {
    password = fakeChrome.password;
  } else {
    const options = {
      type: "info" as const,
      buttons: ["继续", "取消"],
      defaultId: 0,
      cancelId: 1,
      message: "从 Chrome 导入登录状态",
      detail:
        "接下来 macOS 会问 Pupu 能不能使用钥匙串里的「Chrome Safe Storage」，点「允许」才能导入。\n\n导入的登录状态只存在这台电脑的 Pupu 浏览器里，不会上传到云端。"
    };
    const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    if (response !== 0) return { ok: false, error: "取消了。" };
    try {
      password = await keychainPassword();
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }
  const { cookies, skipped } = await readChromeCookies({ chromeDir: chromeDir(), profile, password });
  const jar = session.fromPartition(BROWSER_PARTITION).cookies;
  let imported = 0;
  let failed = 0;
  for (const cookie of cookies) {
    try {
      await jar.set(cookie);
      imported += 1;
    } catch {
      failed += 1;
    }
  }
  await jar.flushStore();
  log(`从 Chrome 导入登录状态：导进 ${imported} 个，跳过 ${skipped + failed} 个。`);
  if (cookies.length > 0 && imported === 0) return { ok: false, error: "一个也没导进去：可能钥匙串密码不对，或者 Chrome 的格式变了。" };
  return { ok: true, imported, skipped: skipped + failed };
}

function startBridge(): void {
  const computer = pairing.computer;
  if (!computer) return;
  supervisor.start(
    { url: origin, computerId: computer.id, token: computer.token, name: computer.name },
    // App 的凭据和模型文件，还有命令行桥的 bridge.json、model.json，文件工具都不让碰。
    [credentialsPath(), configPath(), localModelPath(), modelPath()],
    helpers,
    localModel
  );
}

/** 这台电脑上设的模型。key 不给页面，只说有没有。 */
function localModelView(): LocalModelView | null {
  if (!localModel) return null;
  const { apiKey, ...rest } = localModel;
  return { ...rest, hasKey: apiKey.length > 0 };
}

/** 存这台电脑上的模型：先试能不能调工具，过了才存，交给桥，桥告诉云端。key 留空是沿用旧的。 */
async function setLocalModel(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input === null) {
    await writeLocalModel(null);
    localModel = null;
    supervisor.model(null);
    return { ok: true };
  }
  const parsed = parseLocalModel(input);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  const kept = !parsed.apiKey && localModel?.baseUrl === parsed.baseUrl ? localModel.apiKey : parsed.apiKey;
  const next: LocalModel = { ...parsed, apiKey: kept };
  const probe = await probeModel(next);
  if (!probe.ok) return { ok: false, error: probe.error };
  await writeLocalModel(next);
  localModel = next;
  supervisor.model(next);
  return { ok: true };
}

/** 托盘和窗口上点的收回、停命令、本机开关。桥没在跑时，开关直接写本机文件。 */
async function bridgeAction(action: MenubarAction): Promise<void> {
  if (supervisor.pid !== undefined) {
    supervisor.action(action);
    return;
  }
  if (action.action === "setAllowCommands" || action.action === "setAllowScreen") {
    switches =
      action.action === "setAllowCommands"
        ? { ...switches, allowCommands: action.value }
        : { ...switches, allowScreen: action.value };
    await writeLocal(switches);
    render();
  }
}

/**
 * 云端拒了桥的凭据：这台电脑被吊销了。记下来（重启后还是「授权被吊销」，不当成配对没做完），
 * 不自动重新授权，等人在配对窗口里点。
 */
async function computerRejected(): Promise<void> {
  if (!pairing.computer) return;
  log(`云端拒了「${pairing.computer.name}」的凭据，多半是被吊销了。`);
  pairing = rejectComputer(pairing);
  bridgeState = null;
  await savePairing().catch((error: unknown) => log(`凭据没存上：${message(error)}`));
  render();
  sendPairingStatus();
}

// ── 凭据和配对 ────────────────────────────────────────────────────────

async function loadPairing(): Promise<Pairing> {
  try {
    const { pairing: found, from } = await readWithLegacy(origin, DEFAULT_URL, LEGACY_URLS, readPairing, writePairing);
    if (from) log(`凭据从 ${from} 复制到 ${origin}`);
    return found;
  } catch (error) {
    log(`凭据解不开，当成没配对：${message(error)}`);
    return { desktop: null, computer: null };
  }
}

async function savePairing(): Promise<void> {
  await writePairing(origin, pairing);
}

/** 命令行桥给这台电脑配过对，而且连的是同一个 Pupu：返回它的凭据。 */
async function cliComputer(): Promise<Credential | null> {
  try {
    const config = await readConfig();
    if (!sameOrigin(config.url, origin)) return null;
    return { id: config.computerId, name: config.name, token: config.token };
  } catch {
    return null;
  }
}

/**
 * 配对一次只做一件，配对窗口和托盘跟着它变。半路失败时凭据也可能变了（窗口的存下了、这台电脑的没拿到），
 * 所以做完不管成没成都刷新一次。
 */
const pairingRun = new PairingRun(() => {
  render();
  sendPairingStatus();
});

function pairingStatus(): PairingStatus {
  return { reason: reasonOf(pairing), busy: pairingRun.busy };
}

/** 配对开始、做完，或者凭据变了：窗口上的标题、按钮和要不要填码都跟着换。 */
function sendPairingStatus(): void {
  if (pairWindow && !pairWindow.isDestroyed()) pairWindow.webContents.send("pairing:status", pairingStatus());
}

async function pairingInfo(): Promise<PairingInfo> {
  const reason = reasonOf(pairing);
  // 只在第一次配对时给：被吊销过的那份可能就是它，再沿用还是会被拒。
  const adoptable = reason === "first" ? ((await cliComputer())?.name ?? null) : null;
  // Google 登录换的是窗口的凭据：窗口的还在（被吊销、配对没做完）时不用。
  const google = !pairing.desktop && (await googleEnabled(origin));
  // 上面在等网络，状态放在最后取。
  return { host: new URL(origin).host, codeOptional: isLocalOrigin(origin), adoptable, google, status: pairingStatus() };
}

/** 成功返回 null，失败返回给人看的原因。 */
function pair(request: PairingRequest): Promise<string | null> {
  return pairingRun.run("code", () => pairWithCode(request));
}

async function pairWithCode(request: PairingRequest): Promise<string | null> {
  let desktop = pairing.desktop;
  let computer = pairing.computer;
  const renewed = !desktop;
  try {
    if (!desktop) {
      const code = request.code.trim();
      if (!code && !isLocalOrigin(origin)) return "先填配对码。";
      desktop = await pairDesktop(origin, code, computerName());
      pairing = withDesktop(pairing, desktop);
      await savePairing();
    }
    if (!computer) {
      computer =
        (request.adopt ? await cliComputer() : null) ?? (await pairComputer(origin, desktop.token, computerName()));
      pairing = withComputer(pairing, computer);
      await savePairing();
    }
  } catch (error) {
    log(`配对没成：${message(error)}`);
    return message(error);
  }
  await paired(desktop, computer, renewed);
  return null;
}

/**
 * 用 Google 登录：开一个本机回环端口，在系统浏览器里打开 Pupu 的登录地址，登完 Pupu 把一次性的码送回这个端口，
 * 再拿码和这里留着的 verifier 换凭据。Google 不让在 App 的网页里登录，所以不在配对窗口里登。
 * 窗口和桥的凭据一次就拿齐；选了沿用命令行桥的授权，就只要窗口的。
 */
function pairWithGoogle(request: GoogleRequest): Promise<string | null> {
  if (pairing.desktop) return pair({ code: "", adopt: request.adopt });
  return pairingRun.run("google", (signal) => signInWithGoogle(request, signal));
}

async function signInWithGoogle(request: GoogleRequest, signal: AbortSignal): Promise<string | null> {
  const verifier = newVerifier();
  let desktop: Credential;
  let computer = pairing.computer;
  try {
    const code = await receiveCode(
      (port) => {
        const start = new URL("/api/auth/google/start", origin);
        start.search = new URLSearchParams({
          client: "desktop",
          port: String(port),
          challenge: challengeOf(verifier)
        }).toString();
        log(`在浏览器里用 Google 登录，回调端口 ${port}。`);
        // 后台测试时不打开系统浏览器（它会跑到前台），登录地址写进日志，由测试脚本去走。
        if (background) {
          log(`后台测试，不开浏览器：${start.toString()}`);
          return Promise.resolve();
        }
        return shell.openExternal(start.toString());
      },
      { signal }
    );
    const adopted = !computer && request.adopt ? await cliComputer() : null;
    const result = await redeemSignIn(origin, { code, verifier, name: computerName(), computer: !computer && !adopted });
    desktop = result.desktop;
    pairing = withDesktop(pairing, desktop);
    await savePairing();
    if (!computer) {
      computer = adopted ?? result.computer ?? (await pairComputer(origin, desktop.token, computerName()));
      pairing = withComputer(pairing, computer);
      await savePairing();
    }
  } catch (error) {
    log(`Google 登录没成：${message(error)}`);
    return message(error);
  }
  // 人还在浏览器里，把 Pupu 叫回前台。后台测试时不抢。
  if (!background) app.focus({ steal: true });
  // 走到这里说明窗口原来没有凭据，算重新配对。
  await paired(desktop, computer, true);
  return null;
}

/** 两份凭据都齐了：启动桥，关掉配对窗口，打开（或者刷新）主窗口。 */
async function paired(desktop: Credential, computer: Credential, renewed: boolean): Promise<void> {
  log(`配对好了：窗口「${desktop.name}」（${desktop.id}），电脑「${computer.name}」（${computer.id}）。`);
  startBridge();
  render();
  pairWindow?.close();
  if (renewed) await clearOrgCookies();
  if (renewed && mainWindow) {
    await setCookie(desktop.token);
    mainWindow.reload();
  } else {
    await openMain();
  }
}

/** 网页拿到 401：用凭据再问一次云端，确实被吊销了才清掉，换成配对窗口。 */
let checking = false;
async function checkDesktop(): Promise<void> {
  const desktop = pairing.desktop;
  if (checking || !desktop) return;
  checking = true;
  try {
    if ((await desktopStatus(origin, desktop.token)) !== "revoked") return;
    log(`窗口的凭据「${desktop.name}」被吊销了。`);
    pairing = rejectDesktop(pairing);
    await savePairing();
    await windowSession().cookies.remove(`${origin}/`, TOKEN_COOKIE);
    await clearOrgCookies();
    mainWindow?.close();
    openPairWindow();
    render();
    sendPairingStatus();
  } catch (error) {
    log(`检查窗口凭据时出错：${message(error)}`);
  } finally {
    checking = false;
  }
}

// ── 窗口 ──────────────────────────────────────────────────────────────

function windowSession(): Session {
  return session.fromPartition(PARTITION);
}

/**
 * 窗口切到别的 Pupu 时，云端把那边的凭据种在 `pupu_org_<id>`，`pupu_active` 记着选中哪个（见云端 server.ts 的
 * `cookieCandidates`）。重新配对或者凭据被吊销时一起清掉，免得换了账号还用着上一个人的。
 */
async function clearOrgCookies(): Promise<void> {
  const cookies = await windowSession().cookies.get({ url: `${origin}/` });
  for (const cookie of cookies) {
    if (cookie.name === "pupu_active" || cookie.name.startsWith("pupu_org_")) {
      await windowSession().cookies.remove(`${origin}/`, cookie.name);
    }
  }
}

/** 不带过期时间：只在内存里，不写进磁盘上的 cookie 库。凭据本身在 safeStorage 里。 */
async function setCookie(token: string): Promise<void> {
  await windowSession().cookies.set({
    url: `${origin}/`,
    name: TOKEN_COOKIE,
    value: token,
    path: "/",
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "lax"
  });
}

function setupWindowSession(): void {
  const ses = windowSession();
  // 网页里的复制按钮要用剪贴板，别的权限（摄像头、麦克风、定位、通知……）一律不给。
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === "clipboard-sanitized-write");
  });
  ses.setPermissionCheckHandler((_contents, permission) => permission === "clipboard-sanitized-write");
  // 窗口里的网页不能自己配对成「浏览器」：配对只走 App 的配对窗口。
  ses.webRequest.onBeforeRequest({ urls: [`${origin}/api/pair`] }, (_details, callback) => {
    callback({ cancel: true });
  });
  ses.webRequest.onCompleted({ urls: [`${origin}/api/state`] }, (details) => {
    if (details.statusCode === 401) void checkDesktop();
  });
}

function openExternal(url: string): void {
  if (canOpenExternally(url)) void shell.openExternal(url);
}

/** 主窗口只在 Pupu 的域名里跳转，外链交给系统浏览器；配对窗口哪儿也不去。 */
function guard(contents: WebContents, allowPupu: boolean): void {
  const allowed = (url: string) => allowPupu && sameOrigin(url, origin);
  contents.on("will-navigate", (event, url) => {
    if (allowed(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  // Artifacts 的页面是 srcdoc 的沙箱 iframe（不透明源，preload 只进主框架），要放它载进来；页面里再往外跳一律不让。
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !allowed(event.url) && !(allowPupu && event.url === "about:srcdoc")) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

/** 有窗口时在程序坞里，没窗口时只留托盘。后台测试时一直不进程序坞。 */
function updateDock(): void {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy(!background && (mainWindow || pairWindow) ? "regular" : "accessory");
}

/** 显示窗口并拿到前台。后台测试时窗口一直藏着，不出现在用户屏幕上；CDP 照样能读页面、截图。 */
function reveal(window: BrowserWindow): void {
  if (window.isDestroyed() || background) return;
  window.show();
  window.focus();
}

async function openMain(): Promise<void> {
  if (!pairing.desktop) {
    openPairWindow();
    return;
  }
  if (mainWindow) {
    reveal(mainWindow);
    return;
  }
  await setCookie(pairing.desktop.token);
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 380,
    minHeight: 520,
    title: "Pupu",
    ...windowChrome(),
    show: false,
    webPreferences: {
      preload: dist("preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      partition: PARTITION,
      additionalArguments: [`--pupu-origin=${origin}`]
    }
  });
  mainWindow = window;
  updateDock();
  guard(window.webContents, true);
  const show = () => {
    if (!window.isDestroyed() && !window.isVisible()) reveal(window);
  };
  window.once("ready-to-show", show);
  // 第一次加载就失败时可能等不到 ready-to-show。
  setTimeout(show, 3000);
  // 关窗口前先把挂着的浏览器页面挪回后台：窗口销毁后再摘就晚了，页面会没地方挂、截不到画面。
  window.on("close", () => {
    if (browser?.attachedTo() === window) browser.detach();
  });
  window.on("closed", () => {
    if (browser?.attachedTo() === window) browser.detach();
    if (mainWindow === window) mainWindow = null;
    takeoverOpen = false;
    updateDock();
  });
  // 主窗口的页面换了、刷新了、崩了：挂在上面的浏览器页面先摘下来，不然它盖在对话上，关闭按钮却没了。
  // 要不要接手（takeoverOpen）不变：新页面加载好会来问，再挂回去；主窗口第一次加载也走这里。
  const unhook = (reason: string) => {
    if (browser?.attachedTo() !== window) return;
    browser.detach();
    log(`先把浏览器页面摘下来：${reason}`);
  };
  window.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) unhook("主窗口的页面换了");
  });
  window.webContents.on("render-process-gone", () => unhook("主窗口的页面崩了"));
  // 换成离线页也是主框架导航，上面 did-start-navigation 会把接手的界面收起来。
  const showOffline = () =>
    void window.loadFile(dist("offline.html"), { query: { url: `${origin}/`, host: new URL(origin).host } });
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 是被新的导航顶掉了，不算失败。
    if (!isMainFrame || code === -3 || !sameOrigin(url, origin)) return;
    log(`页面没加载出来：${code} ${description}`);
    showOffline();
  });
  // 网络半通时请求既不成功也不报错，等不到 did-fail-load，窗口就一直空着。
  let loadTimer: NodeJS.Timeout | null = null;
  const clearLoadTimer = () => {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = null;
  };
  window.webContents.on("did-start-loading", () => {
    clearLoadTimer();
    loadTimer = setTimeout(() => {
      if (window.isDestroyed() || !window.webContents.isLoadingMainFrame()) return;
      log(`页面 ${LOAD_TIMEOUT_MS / 1000} 秒没加载出来，换成离线页。`);
      showOffline();
    }, LOAD_TIMEOUT_MS);
  });
  window.webContents.on("did-stop-loading", clearLoadTimer);
  window.once("closed", clearLoadTimer);
  window.webContents.on("did-finish-load", () => sendComputer());
  // 从系统设置开完授权回来，授权状态跟着刷新。
  window.on("focus", () => sendComputer());
  try {
    await window.loadURL(`${origin}/`);
  } catch {
    // did-fail-load 已经换成本地页面了。
  }
}

function openPairWindow(): void {
  if (pairWindow) {
    reveal(pairWindow);
    return;
  }
  const window = createPairWindow(dist("pair-preload.cjs"), dist("pair.html"), {}, reveal);
  pairWindow = window;
  updateDock();
  guard(window.webContents, false);
  window.on("closed", () => {
    if (pairWindow === window) pairWindow = null;
    // 关了配对窗口就不等浏览器了。
    pairingRun.cancel();
    updateDock();
  });
}

// ── 状态 ──────────────────────────────────────────────────────────────

function currentComputer(): DesktopComputer {
  return computerView({
    pairing,
    state: bridgeState,
    switches,
    fallbackName: computerName(),
    permissions: {
      screen: systemPreferences.getMediaAccessStatus("screen") === "granted",
      accessibility: systemPreferences.isTrustedAccessibilityClient(false)
    }
  });
}

function sendComputer(): void {
  const contents = mainWindow?.webContents;
  if (contents && sameOrigin(contents.getURL(), origin)) contents.send("pupu:computer", currentComputer());
}

/** 托盘那一份：电脑名先用凭据里的，没有这台电脑的凭据（被吊销、还没配对、配对没做完）时用这台电脑自己的名字。 */
function trayView(): TrayView {
  return { state: bridgeState, name: pairing.computer?.name ?? computerName(), pairing: computerAuth(pairing), update };
}

function render(): void {
  tray?.render(trayView());
  sendComputer();
}

// ── 进程间调用 ────────────────────────────────────────────────────────

/** 只认主窗口里 Pupu 自己的页面。 */
function fromMain(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (event.sender !== mainWindow?.webContents || !sameOrigin(url, origin)) {
    throw new Error("这个页面不能调这个接口。");
  }
}

function fromPairing(event: IpcMainInvokeEvent): void {
  if (event.sender !== pairWindow?.webContents) throw new Error("这个页面不能调这个接口。");
}

function registerIpc(): void {
  ipcMain.handle("pairing:info", (event) => {
    fromPairing(event);
    return pairingInfo();
  });
  ipcMain.handle("pairing:pair", (event, request: unknown) => {
    fromPairing(event);
    const value = (request ?? {}) as Partial<PairingRequest>;
    return pair({ code: typeof value.code === "string" ? value.code : "", adopt: value.adopt === true });
  });
  ipcMain.handle("pairing:google", (event, request: unknown) => {
    fromPairing(event);
    return pairWithGoogle({ adopt: (request as Partial<GoogleRequest> | null)?.adopt === true });
  });
  ipcMain.handle("pairing:cancel", (event) => {
    fromPairing(event);
    pairingRun.cancel();
  });
  ipcMain.handle("pupu:computer", (event) => {
    fromMain(event);
    return currentComputer();
  });
  ipcMain.handle("pupu:set-switch", async (event, name: unknown, value: unknown) => {
    fromMain(event);
    if (typeof value !== "boolean") throw new Error("开关的值不对。");
    const which = name as DesktopSwitch;
    if (which === "allowCommands") await bridgeAction({ action: "setAllowCommands", value });
    else if (which === "allowScreen") await bridgeAction({ action: "setAllowScreen", value });
    else throw new Error("没有这个开关。");
  });
  ipcMain.handle("pupu:takeback", async (event) => {
    fromMain(event);
    await bridgeAction({ action: "takeback" });
  });
  ipcMain.handle("pupu:stop-jobs", async (event) => {
    fromMain(event);
    await bridgeAction({ action: "stopJobs" });
  });
  ipcMain.handle("pupu:open-privacy", async (event, pane: unknown) => {
    fromMain(event);
    const url = PRIVACY_PANES[pane as PrivacyPane];
    if (!url) throw new Error("没有这个设置页。");
    await shell.openExternal(url);
  });
  // 「在电脑上接手」：和模型的 browser_show 走同一条路，在主窗口里打开放大视图。
  ipcMain.handle("pupu:show-browser", async (event) => {
    fromMain(event);
    browser ??= newBrowser();
    await openTakeover();
  });
  ipcMain.handle("pupu:browser-takeover-state", (event) => {
    fromMain(event);
    return takeoverOpen;
  });
  ipcMain.handle("pupu:browser-attach", (event, rect: unknown) => {
    fromMain(event);
    const window = mainWindow;
    if (!window || !takeoverOpen) return false;
    const bounds = takeoverBounds(window, rect);
    if (!bounds) throw new Error("放浏览器页面的位置不对。");
    browser ??= newBrowser();
    const first = browser.attachedTo() !== window;
    browser.attach(window, bounds);
    // 排查用：挂上时屏幕上有哪些窗口。只该有 Pupu 主窗口，Pupu 浏览器不该单独出现。
    if (first) log(`屏幕上的窗口：${visibleWindows()}`);
    return true;
  });
  ipcMain.handle("pupu:browser-detach", (event, handback: unknown) => {
    fromMain(event);
    if (handback === true) closeTakeover("人接手完了，叫 Pupu 接着做", true);
    else closeTakeover("人关掉了");
  });
  ipcMain.handle("pupu:chrome-profiles", async (event) => {
    fromMain(event);
    return listProfiles(chromeDir());
  });
  ipcMain.handle("pupu:import-chrome", async (event, profile: unknown) => {
    fromMain(event);
    if (typeof profile !== "string") throw new Error("要给用户资料目录名。");
    return importChrome(profile);
  });
  ipcMain.handle("pupu:local-model", (event) => {
    fromMain(event);
    return localModelView();
  });
  ipcMain.handle("pupu:set-local-model", async (event, input: unknown) => {
    fromMain(event);
    return setLocalModel(input);
  });
  ipcMain.handle("pupu:repair", async (event) => {
    fromMain(event);
    await checkDesktop();
    if (!pairing.desktop || !pairing.computer) openPairWindow();
  });
}

// ── 菜单和生命周期 ────────────────────────────────────────────────────

function onTray(action: TrayAction): void {
  if (action.action === "open") void openMain();
  else if (action.action === "pair") openPairWindow();
  else if (action.action === "update") autoUpdater.quitAndInstall();
  else if (action.action === "quit") app.quit();
  else void bridgeAction(action).catch((error: unknown) => log(message(error)));
}

function setupMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Pupu",
        submenu: [
          { role: "about", label: "关于 Pupu" },
          { type: "separator" },
          { role: "hide", label: "隐藏 Pupu" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { label: "退出 Pupu", accelerator: "Command+Q", click: () => app.quit() }
        ]
      },
      { role: "editMenu" },
      app.isPackaged
        ? { label: "显示", submenu: [{ role: "reload" }, { role: "togglefullscreen" }] }
        : { role: "viewMenu" },
      { role: "windowMenu" }
    ])
  );
}

async function boot(): Promise<void> {
  if (background) updateDock();
  // 开发版跑的是 Electron.app，程序坞里换成 Pupu 的图标；打包后用 App 包里的 icns 和 Assets.car。
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(dist("icons/dock.png"));
  mainLog = openLog("main.log");
  bridgeLog = openLog("bridge.log");
  log(`Pupu ${app.getVersion()} 启动，连 ${origin}，数据在 ${app.getPath("userData")}`);
  setupMenu();
  setupWindowSession();
  registerIpc();
  // 凭据还没读出来：先当刚启动，「没连上 · 正在连接…」，读完马上 render()。
  tray = new PupuTray(onTray, { state: null, name: computerName(), pairing: "ok", update: null });
  capture = new CaptureHost({
    preload: dist("capture-preload.cjs"),
    page: dist("capture.html"),
    onEvent: (event) => supervisor.capture(event),
    log,
    fake: !app.isPackaged && process.env.PUPU_FAKE_SCREEN === "1"
  });
  switches = await readLocal();
  localModel = await readLocalModel();
  pairing = await loadPairing();
  startBridge();
  render();
  startUpdates((version) => {
    update = version;
    render();
  }, log);
  if (pairing.desktop) {
    if (!trayStart) await openMain();
  } else openPairWindow();
}

if (refused.length > 0) {
  process.stderr.write(`Pupu 不认这些启动参数，退出：${refused.join(" ")}\n`);
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => void openMain());
  app.on("activate", () => void openMain());
  // 关掉窗口不退出：托盘和桥留着。
  app.on("window-all-closed", () => {});
  // 先停桥（停命令、断连接）再退出。停完直接 exit：拦过一次 before-quit 后再 quit，收到 SIGTERM 时会卡住。
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    log("退出：先停桥。");
    capture?.stop();
    browser?.stop();
    void supervisor.stop().finally(() => {
      tray?.destroy();
      log("已退出。");
      app.exit(0);
    });
  });
  void app.whenReady().then(boot).catch((error: unknown) => {
    log(`启动失败：${message(error)}`);
    app.exit(1);
  });
}
