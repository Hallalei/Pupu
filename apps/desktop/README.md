# Pupu 电脑 App

Electron 做的电脑端（技术方案 5.3、5.4，第一版是 M2）。它做三件事：

- **托管桥**：主进程用 `utilityProcess` 拉起 `apps/cloud/bridge/` 里的桥，跑在 Electron 自带的 Node 里，挂了就退避重启。不用 `ELECTRON_RUN_AS_NODE`。
- **托盘**：替代 `bridge/menubar.swift`。状态词、收回屏幕、停止命令、两个本机开关，和 Swift 那版一样；另加「打开 Pupu」和退出，还没配对、配对没做完、授权被吊销时换成「配对这台电脑…」「再试一次…」「重新配对…」。关掉窗口不退出，退出 Pupu 这台电脑就下线。
- **窗口**：加载线上网页，开 sandbox 和 contextIsolation，只在 Pupu 自己的域名里跳转，外链交给系统浏览器。preload 只给 `window.pupuDesktop` 这几个接口：这台电脑的状态、本机开关、收回、停命令、打开系统设置的授权页、重新配对（类型在 `apps/cloud/src/client/desktop.ts`）。

## 配对和凭据

第一次打开时弹配对窗口。云端开了 Google 登录时，先给「用 Google 登录」：

1. App 在 `127.0.0.1` 上临时开一个端口（`src/loopback.ts`），生成一个 PKCE verifier，在系统浏览器里打开 Pupu 的登录地址；
2. 在浏览器里登完 Google，Pupu 把一次性的码送回这个端口；
3. App 拿码和 verifier 去换，窗口的 `desktop` 凭据和桥的 `computer` 凭据一次拿齐。窗口凭据和这台电脑都挂在登录的那个人名下：电脑的审批只推到他的手机上，放宽分级也只认他的手机。

Google 不让在 App 内嵌的网页里登录，所以不在配对窗口里登。本机别的程序往那个端口塞假码也没用，没有 verifier 换不出凭据。关掉配对窗口或者点「取消」就不等了，5 分钟没登完也作废。

也能在同一屏填配对码（在已经连上的手机或浏览器的设置里生成）：

1. 码换窗口的 `desktop` 设备凭据；
2. 窗口凭据再要一个码，换桥的 `computer` 凭据。

两份凭据用 `safeStorage` 加密，存在 `~/Library/Application Support/Pupu/credentials.bin`（开发版是 `Pupu Dev`），密钥在钥匙串里。窗口的凭据放进内存里的 HttpOnly cookie，网页脚本拿不到；桥的凭据经 MessagePort 发给桥，不放环境变量（桥跑的命令会继承环境变量）。桥的文件工具碰不到这个文件。

命令行的桥已经给这台电脑配过对（`~/.pupu/bridge.json`，连的是同一个 Pupu）时，配对窗口会问要不要沿用它的授权，这样不会多出一台同名的电脑。沿用以后两边用的是同一台电脑的凭据，命令行的桥还在跑时 App 的桥连不上（云端只认先连上的那个），托盘上显示「没连上 · 另一个 Pupu 已经连着这台电脑，先退出它」，停掉 launchd 里的桥以后 App 的桥 15 秒内接上。

配对半路出错（比如第二步云端回 500）：窗口的凭据已经存下，这台电脑的还没拿到。托盘、配对窗口和设置的「这台电脑」写「没连上 · 配对没做完」，点「再试一次」接着换这台电脑的凭据，不用再填码。这不算吊销。

吊销：

- 窗口被吊销：网页拿到 401，主进程再问一次云端，确认了就清掉窗口凭据、在凭据文件里记下 `desktopRevoked`、关掉主窗口、弹配对窗口。桥不受影响。
- 电脑被吊销：桥被云端拒掉（关闭码 1008），主进程清掉电脑凭据，在凭据文件里记下 `computerRevoked`，托盘显示「授权被吊销」，重启后也是。只有这种才写「授权被吊销」。不会自动重新授权，要人在托盘、配对窗口或设置的「这台电脑」里点「重新配对」。老版本存下的凭据没有这个记号，只少了电脑凭据的当成配对没做完。
- 两份都被吊销（比如成员被移出组织）：两份凭据都没了，但有记号，所以还是「授权被吊销」，不是「还没配对」；配对窗口顶上写这台电脑的授权被吊销了，要填新码。状态看的是发生过什么，不只是手上剩哪份凭据。

## 开发

```bash
npm install
npm run dev                           # 连线上
PUPU_URL=http://localhost:5173 npm run dev   # 连本机的 wrangler dev（先在 apps/cloud 里 npm run dev）
npm test
npm run typecheck
```

`npm run dev` 先用 esbuild 把主进程、两个 preload 和桥打进 `dist/`，再起 Electron。桥打成 ESM（`dist/bridge.mjs`），旁边放一份 `input.swift`，输入助手照旧编到 `~/.pupu/bin/`。操作窗口用 Cua 驱动，开发版从 `apps/cloud/node_modules` 加载。

日志在 `~/Library/Logs/Pupu Dev/`：`main.log` 是主进程，`bridge.log` 是桥。

### 后台测试，不抢前台

测试时别把 App 拉到前台、打断手上在用电脑的人。用 `open -g` 在后台启动，再加 `PUPU_BACKGROUND=1`：App 不进程序坞，窗口只用 `showInactive()` 显示，不激活、不抢焦点。界面用 CDP 读 DOM、截窗口的图来看：

```bash
npm run build
open -g -n -a "$PWD/node_modules/electron/dist/Electron.app" \
  --env PUPU_BACKGROUND=1 --env PUPU_URL=http://localhost:5173 \
  --env PUPU_USER_DATA=/tmp/pupu-test/userdata --env PUPU_DIR=/tmp/pupu-test/pupu \
  --args "$PWD" --remote-debugging-port=9333
curl -s http://127.0.0.1:9333/json   # 找到页面，用它的 webSocketDebuggerUrl 发 Runtime.evaluate、Page.captureScreenshot
```

`PUPU_BACKGROUND=1` 时点「用 Google 登录」不开系统浏览器（它会跑到前台），登录地址写进 `~/Library/Logs/Pupu Dev/main.log`（「后台测试，不开浏览器：…」那一行），用 curl 带着 cookie 走完它就行，配合 `apps/cloud/dev/fake-google.mjs`。

`PUPU_USER_DATA` 换一份 App 数据（凭据、cookie），`PUPU_DIR` 换一份桥的数据（代替 `~/.pupu`），这样能同时跑两套，也不碰正在用的配对。这几个环境变量只在开发版里认：正式包启动时把 `PUPU_` 开头的环境变量全删掉，桥也跟着不认。配对、吊销、桥重启、开关、退出这些主进程的事，尽量用 CDP 调 `window.pupuPairing` / `window.pupuDesktop`，或者对本机 wrangler dev 发请求来验，不开窗口给人看。

### 系统授权

屏幕录制和辅助功能按「谁把程序拉起来的」算。实测（2026-11-01，`responsibility_get_pid_responsible_for_pid`）：

| 怎么启动 | 桥（utility 进程）和它跑的命令算在谁头上 |
|---|---|
| `open` / 双击 / 托盘常驻（系统拉起 App） | Electron 主进程，也就是 App 自己 |
| 从终端里 `npm run dev` | 那个终端 |

所以正式包里授权会记在 Pupu.app 名下。开发版要在系统设置里给「Electron」开这两项，用 `open` 启动才算数：

```bash
open -n -a "$PWD/node_modules/electron/dist/Electron.app" --args "$PWD"
```

开发版 Electron 是临时签名，换 Electron 版本后授权要重开。正式包见下面「打包和发布」；自动更新、开机自启还没做。

## 打包和发布

`npm run dist` 跑 `package.mjs`，出能发给别人装的正式包，产物在 `release/`：`mac-arm64/Pupu.app`、`Pupu-<版本>-arm64.dmg` 和自动更新用的 `Pupu-<版本>-arm64.zip`。只出 Apple 芯片版本。

### 第一次打包前

1. **Developer ID 证书**：Xcode → Settings → Accounts → 选团队 → Manage Certificates → 左下角 + → Developer ID Application。
2. **公证凭据**：在 account.apple.com → 登录与安全 → App 专用密码 里新建一个，再在终端里存进钥匙串（第二行会提示粘贴密码）：

   ```bash
   TEAM=$(security find-identity -v -p codesigning | sed -nE 's/.*Developer ID Application: .*\(([A-Z0-9]{10})\).*/\1/p' | head -1)
   xcrun notarytool store-credentials pupu-notary --apple-id <Apple ID 邮箱> --team-id "$TEAM"
   ```

   凭据名默认 `pupu-notary`，用别的名字时设 `PUPU_NOTARY_PROFILE`。第一次签名时系统会问 codesign 能不能用钥匙串里的私钥，点「始终允许」。

### 打包

```bash
npm install
npm run dist
```

依次做这几件事，哪一步不过就停下：

1. 找钥匙串里的 Developer ID Application 证书，确认 notarytool 的凭据在；
2. `build.mjs` 打出 `dist/`；
3. 把桥的 `input.swift` 编成输入助手 `out/pupu-input`（`-target arm64-apple-macos14.0`），用同一个证书签名，开 hardened runtime，不带 entitlements；把 Cua 驱动的 npm 包摆到 `out/cua-driver`，原生库裁成 arm64，由 electron-builder 用同一个证书重签；
4. electron-builder 按 `electron-builder.yml` 打 Pupu.app：写 Fuses、签名（hardened runtime，entitlements 在 `build/`）、提交公证、staple，再打 DMG；
5. DMG 签名、公证、staple；
6. 验收：`codesign --verify --deep --strict`、`spctl --assess`（App 和 DMG 都要显示 `source=Notarized Developer ID`）、`xcrun stapler validate`，再打出 Fuses 的状态。

公证每次要几分钟。`npm run dist -- --local` 是本机试打包：临时签名、不开 hardened runtime、不公证，只用来看打包本身对不对，别拿去装，也别给它开系统授权（会记在临时签名名下，正式包用不上）。

### 正式包和开发版的区别

| | 开发版 | 正式包 |
|---|---|---|
| 程序 | `node_modules/electron/dist/Electron.app` 跑 `apps/desktop` | `Pupu.app`，bundle id `com.leizi.pupu.desktop` |
| 签名 | Electron 自带的临时签名 | Developer ID，hardened runtime，公证过 |
| 连哪个 Pupu | 线上，或者 `PUPU_URL` | 只连线上 |
| 数据 | `~/Library/Application Support/Pupu Dev`，日志在 `~/Library/Logs/Pupu Dev/` | `~/Library/Application Support/Pupu`，日志在 `~/Library/Logs/Pupu/` |
| 输入助手 | 桥在本机编到 `~/.pupu/bin/pupu-input` | 包里编好、签好的 `Contents/Resources/helpers/pupu-input`，主进程经 MessagePort 把目录告诉桥 |
| Cua 驱动 | `apps/cloud/node_modules/@trycua/cua-driver` | `Contents/Resources/helpers/cua-driver`，跑在桥的进程里，权限记在 Pupu 名下。驱动是 MIT，运行时 `@ubjs/*` 是 MPL-2.0，两者都没改过；可选的 `cua-perception` 是 AGPL，不要带上 |
| 调试 | 认 `PUPU_*` 环境变量，能开 DevTools、`--remote-debugging-port` | 删掉 `PUPU_*`，关 DevTools；带 `--remote-debugging-port`、`--inspect`、`--js-flags` 这类参数启动就直接退出 |

收紧入口照 Cindy 正式包的 Fuses：关 RunAsNode、`NODE_OPTIONS`、`--inspect`，开 asar 完整性校验、只从 asar 加载、cookie 加密，关 file:// 的额外权限。桥走 `utilityProcess`，不受 RunAsNode 影响。

entitlements 只给要用的：主程序 `allow-jit` 和 `automation.apple-events`（桥跑的 osascript 之类控制别的 App 时算在 Pupu 头上），几个 Pupu Helper 只有 `allow-jit`，输入助手什么也不带。没开 `disable-library-validation`，别的库进不了 Pupu 的进程。

### 发新版

1. 改 `package.json` 的 `version`。
2. `npm run dist`。
3. `npm run release`，把 zip、DMG 和清单 `mac-arm64.json` 传到 R2 的 `pupu-downloads` 桶，公开域名是 `dl.getpupu.com`。

已装的 App 启动时和每 4 小时查一次清单，有新版本就在后台下好，托盘里多一项「重启并更新到 x.x.x」。第一次安装用 `https://dl.getpupu.com/Pupu-arm64.dmg`。

### 第一次装正式包

1. 打开 DMG，把 Pupu 拖进「应用程序」，从那里打开。
2. 系统会问 Pupu 能不能用钥匙串里的「Pupu Safe Storage」（开发版建的，存凭据的密钥），点「始终允许」。
3. 弹配对窗口：在手机或浏览器的设置里生成一个配对码填进去。这台电脑用命令行或开发版配过对时，配对窗口会问要不要沿用 `~/.pupu/bridge.json` 的授权，沿用就还是同一台电脑，不会多出一台。
4. 让 Pupu 截一次屏、点一次，按提示在系统设置里给「Pupu」开屏幕录制和辅助功能。

正式包和开发版不能同时连着：云端只认先连上的那个桥，后连的那个托盘上显示「没连上 · 另一个 Pupu 已经连着这台电脑，先退出它」。换着用时先退出另一个。

## 图标

全部由 `design/icon/export.py` 生成，别手改。

- **菜单栏**：`static/icons/tray-*.png`，单色模板图。在线没事做时气泡是空的；在做事和在用屏幕时气泡里有输入点；等你批准时右上角多一个圆点；没连上、没配对和授权被吊销时变淡。
- **程序坞**：开发版跑的是 Electron.app，启动时用 `static/icons/dock.png` 换掉 Electron 的图标。
- **正式包**：`icons/` 里两份都放进 App 包（`electron-builder.yml`）。
  - `icon.icns` 由 `mac.icon` 放进 `Contents/Resources`，Info.plist 里是 `CFBundleIconFile = icon.icns`，给 macOS 26 以前的系统和 DMG 用。
  - `Assets.car` 由 `extraResources` 放进 `Contents/Resources`，`mac.extendInfo` 写 `CFBundleIconName = AppIcon`，macOS 26 用它，深色、着色模式由系统接管。
  - 实测（macOS 26.3）：只放 icns 也不会被套灰底，因为图案本身是标准圆角方块。

## 参考

- Cindy `apps/desktop`（Apache-2.0）：`utilityProcess` 托管 Node 的活、`safeStorage` 存凭据、正式包关 RunAsNode。
- Paseo `packages/desktop`（Apache-2.0）：sandbox 里的 preload 只能 `require("electron")`，要打成单个文件；窗口的跳转拦截。
- VS Code `extensions/github-authentication`（MIT）：在系统浏览器里登录、回调送到本机回环端口（`listen(0, "127.0.0.1")`）再跳一个本地结果页的写法（RFC 8252）。
- deepchat `src/main`（Apache-2.0）：`utilityProcess` 宿主的拉起、消息和退出重启（`scheduler/schedulerProcessManager.ts`），托盘模板图。
- Paseo `packages/desktop/electron-builder.yml`、emdash `apps/emdash-desktop/electron-builder.config.ts`：electron-builder 的签名、hardened runtime、entitlements 和 `electronFuses` 写法。
- Cindy `apps/desktop/forge.config.ts`、`scripts/ci/lib.mjs`：正式包的 Fuses 取值，Swift 助手先签再签整个 App，DMG 单独签名、公证。deepchat `scripts/notarize-dmg.js` 和 `mac.signIgnore`：自带的 Computer Use 助手自己签、electron-builder 跳过它，DMG 另外公证。

都是看思路自己写的，没搬代码。
