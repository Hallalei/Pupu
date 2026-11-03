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
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents
} from "electron";
import { configPath, readConfig } from "../../cloud/bridge/config.ts";
import { readLocal, writeLocal, type LocalSwitches } from "../../cloud/bridge/local.ts";
import type { MenubarAction, MenubarState } from "../../cloud/bridge/menubar.ts";
import type { DesktopComputer, DesktopSwitch, PrivacyPane } from "../../cloud/src/client/desktop.ts";
import { credentialsPath, readPairing, writePairing, type Credential, type Pairing } from "./credentials.ts";
import { challengeOf, newVerifier, receiveCode } from "./loopback.ts";
import { desktopStatus, googleEnabled, pairComputer, pairDesktop, redeemSignIn } from "./pairing.ts";
import { createPairWindow, type GoogleRequest, type PairingInfo, type PairingRequest } from "./pairing-window.ts";
import { BridgeSupervisor } from "./supervisor.ts";
import { PupuTray } from "./tray.ts";
import type { TrayAction } from "./tray-menu.ts";
import { canOpenExternally, computerName, DEFAULT_URL, isLocalOrigin, originOf, sameOrigin } from "./urls.ts";
import { computerView } from "./view.ts";

/** 和 apps/cloud/src/server.ts 里的 TOKEN_COOKIE 一样：窗口的凭据放进 HttpOnly cookie。 */
const TOKEN_COOKIE = "pupu_token";
const PARTITION = "persist:pupu";
const PRIVACY_PANES: Record<PrivacyPane, string> = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
};

// 开发时可以用 PUPU_URL 连本机的 wrangler dev；正式包只连线上，免得被人用环境变量引到别处去配对。
const origin = originOf((!app.isPackaged && process.env.PUPU_URL) || DEFAULT_URL);
const dataName = app.isPackaged ? "Pupu" : "Pupu Dev";
/**
 * 开发时测试用：PUPU_BACKGROUND=1 时 App 不进程序坞、窗口不抢前台，配合 `open -g` 启动，
 * 用户手上的活不被打断。界面用 CDP（--remote-debugging-port）读 DOM、截图来看。
 */
const background = !app.isPackaged && process.env.PUPU_BACKGROUND === "1";

app.setName("Pupu");
// 开发时可以用 PUPU_USER_DATA 另开一份数据，同时跑两个互不干扰的 App 来测。
app.setPath("userData", (!app.isPackaged && process.env.PUPU_USER_DATA) || path.join(app.getPath("appData"), dataName));
app.setAppLogsPath(path.join(os.homedir(), "Library", "Logs", dataName));

let pairing: Pairing = { desktop: null, computer: null };
let bridgeState: MenubarState | null = null;
let switches: LocalSwitches = { allowCommands: true, allowScreen: true };
let mainWindow: BrowserWindow | null = null;
let pairWindow: BrowserWindow | null = null;
let tray: PupuTray | null = null;
/** 正在等浏览器里的 Google 登录。 */
let signIn: AbortController | null = null;
let mainLog: WriteStream | null = null;
let bridgeLog: WriteStream | null = null;
let quitting = false;

const dist = (name: string) => path.join(__dirname, name);

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
  onCrash(code, delay) {
    log(`桥退出了（${code}），${Math.round(delay / 1000)} 秒后重启。`);
    bridgeState = null;
    render();
  },
  log(line) {
    write(bridgeLog, line);
  }
});

function startBridge(): void {
  const computer = pairing.computer;
  if (!computer) return;
  supervisor.start(
    { url: origin, computerId: computer.id, token: computer.token, name: computer.name },
    // App 的凭据文件，还有命令行桥的 bridge.json，文件工具都不让碰。
    [credentialsPath(), configPath()]
  );
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

/** 云端拒了桥的凭据：这台电脑被吊销了。不自动重新授权，等人在配对窗口里点。 */
async function computerRejected(): Promise<void> {
  if (!pairing.computer) return;
  log(`云端拒了「${pairing.computer.name}」的凭据，多半是被吊销了。`);
  pairing = { ...pairing, computer: null };
  bridgeState = null;
  await savePairing().catch((error: unknown) => log(`凭据没存上：${message(error)}`));
  render();
}

// ── 凭据和配对 ────────────────────────────────────────────────────────

async function loadPairing(): Promise<Pairing> {
  try {
    return await readPairing(origin);
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

async function pairingInfo(): Promise<PairingInfo> {
  const reason = !pairing.desktop ? (pairing.computer ? "desktop" : "first") : "computer";
  // 只在第一次配对时给：被吊销过的那份可能就是它，再沿用还是会被拒。
  const adoptable = reason === "first" ? ((await cliComputer())?.name ?? null) : null;
  const google = reason !== "computer" && (await googleEnabled(origin));
  return { host: new URL(origin).host, codeOptional: isLocalOrigin(origin), reason, adoptable, google };
}

/** 成功返回 null，失败返回给人看的原因。 */
async function pair(request: PairingRequest): Promise<string | null> {
  let desktop = pairing.desktop;
  let computer = pairing.computer;
  const renewed = !desktop;
  try {
    if (!desktop) {
      const code = request.code.trim();
      if (!code && !isLocalOrigin(origin)) return "先填配对码。";
      desktop = await pairDesktop(origin, code, computerName());
      pairing = { ...pairing, desktop };
      await savePairing();
    }
    if (!computer) {
      computer =
        (request.adopt ? await cliComputer() : null) ?? (await pairComputer(origin, desktop.token, computerName()));
      pairing = { ...pairing, computer };
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
async function pairWithGoogle(request: GoogleRequest): Promise<string | null> {
  if (pairing.desktop) return pair({ code: "", adopt: request.adopt });
  signIn?.abort();
  const controller = new AbortController();
  signIn = controller;
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
      { signal: controller.signal }
    );
    const adopted = !computer && request.adopt ? await cliComputer() : null;
    const result = await redeemSignIn(origin, { code, verifier, name: computerName(), computer: !computer && !adopted });
    desktop = result.desktop;
    pairing = { ...pairing, desktop };
    await savePairing();
    if (!computer) {
      computer = adopted ?? result.computer ?? (await pairComputer(origin, desktop.token, computerName()));
      pairing = { ...pairing, computer };
      await savePairing();
    }
  } catch (error) {
    log(`Google 登录没成：${message(error)}`);
    return message(error);
  } finally {
    if (signIn === controller) signIn = null;
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
    pairing = { ...pairing, desktop: null };
    await savePairing();
    await windowSession().cookies.remove(`${origin}/`, TOKEN_COOKIE);
    mainWindow?.close();
    openPairWindow();
    render();
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
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !allowed(event.url)) event.preventDefault();
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

/** 显示窗口并拿到前台；后台测试时只显示，不激活 App、不抢焦点。 */
function reveal(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (background) {
    window.showInactive();
    return;
  }
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
    backgroundColor: "#6f8fb3",
    show: false,
    webPreferences: {
      preload: dist("preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
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
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    updateDock();
  });
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 是被新的导航顶掉了，不算失败。
    if (!isMainFrame || code === -3 || !sameOrigin(url, origin)) return;
    log(`页面没加载出来：${code} ${description}`);
    void window.loadFile(dist("offline.html"), { query: { url: `${origin}/`, host: new URL(origin).host } });
  });
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
    signIn?.abort();
    updateDock();
  });
}

// ── 状态 ──────────────────────────────────────────────────────────────

function currentComputer(): DesktopComputer {
  return computerView({
    computer: pairing.computer,
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

function render(): void {
  tray?.render({ state: bridgeState, needsPairing: !pairing.desktop || !pairing.computer });
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
    signIn?.abort();
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
  tray = new PupuTray(onTray);
  switches = await readLocal();
  pairing = await loadPairing();
  startBridge();
  render();
  if (pairing.desktop) await openMain();
  else openPairWindow();
}

if (!app.requestSingleInstanceLock()) {
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
