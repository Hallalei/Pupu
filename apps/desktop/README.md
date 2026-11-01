# Pupu 电脑 App

Electron 做的电脑端（技术方案 5.3、5.4，第一版是 M2）。它做三件事：

- **托管桥**：主进程用 `utilityProcess` 拉起 `apps/cloud/bridge/` 里的桥，跑在 Electron 自带的 Node 里，挂了就退避重启。不用 `ELECTRON_RUN_AS_NODE`。
- **托盘**：替代 `bridge/menubar.swift`。五种状态、收回屏幕控制、停命令、两个本机开关，和 Swift 那版一样；另加「打开 Pupu」和退出。关掉窗口不退出，退出 Pupu 这台电脑就下线。
- **窗口**：加载线上网页，开 sandbox 和 contextIsolation，只在 Pupu 自己的域名里跳转，外链交给系统浏览器。preload 只给 `window.pupuDesktop` 这几个接口：这台电脑的状态、本机开关、收回、停命令、打开系统设置的授权页、重新配对（类型在 `apps/cloud/src/client/desktop.ts`）。

## 配对和凭据

第一次打开时弹配对窗口，填一个配对码（在已经连上的手机或浏览器的设置里生成）：

1. 码换窗口的 `desktop` 设备凭据；
2. 窗口凭据再要一个码，换桥的 `computer` 凭据。

两份凭据用 `safeStorage` 加密，存在 `~/Library/Application Support/Pupu/credentials.bin`（开发版是 `Pupu Dev`），密钥在钥匙串里。窗口的凭据放进内存里的 HttpOnly cookie，网页脚本拿不到；桥的凭据经 MessagePort 发给桥，不放环境变量（桥跑的命令会继承环境变量）。桥的文件工具碰不到这个文件。

命令行的桥已经给这台电脑配过对（`~/.pupu/bridge.json`，连的是同一个 Pupu）时，配对窗口会问要不要沿用它的授权，这样不会多出一台同名的电脑。沿用以后两边用的是同一台电脑的凭据，命令行的桥还在跑时 App 的桥连不上（云端只认先连上的那个），托盘上显示「这台电脑已经有别的桥连着」，停掉 launchd 里的桥以后 App 的桥 15 秒内接上。

吊销：

- 窗口被吊销：网页拿到 401，主进程再问一次云端，确认了就清掉窗口凭据、关掉主窗口、弹配对窗口。桥不受影响。
- 电脑被吊销：桥被云端拒掉，主进程清掉电脑凭据，托盘显示没配对。不会自动重新授权，要人在配对窗口或设置里点「重新授权」。

## 开发

```bash
npm install
npm run dev                           # 连线上
PUPU_URL=http://localhost:5173 npm run dev   # 连本机的 wrangler dev（先在 apps/cloud 里 npm run dev）
npm test
npm run typecheck
```

`npm run dev` 先用 esbuild 把主进程、两个 preload 和桥打进 `dist/`，再起 Electron。桥打成 ESM（`dist/bridge.mjs`），旁边放一份 `computer.swift`，屏幕助手照旧编到 `~/.pupu/bin/`。

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

`PUPU_USER_DATA` 换一份 App 数据（凭据、cookie），`PUPU_DIR` 换一份桥的数据（代替 `~/.pupu`），这样能同时跑两套，也不碰正在用的配对。这几个环境变量只在开发版里认，正式包不认 `PUPU_BACKGROUND`、`PUPU_URL`、`PUPU_USER_DATA`。配对、吊销、桥重启、开关、退出这些主进程的事，尽量用 CDP 调 `window.pupuPairing` / `window.pupuDesktop`，或者对本机 wrangler dev 发请求来验，不开窗口给人看。

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

开发版 Electron 是临时签名，换 Electron 版本后授权要重开。签名、公证、收紧入口（Fuses）、自动更新、开机自启在 M4。

## 参考

- Cindy `apps/desktop`（Apache-2.0）：`utilityProcess` 托管 Node 的活、`safeStorage` 存凭据、正式包关 RunAsNode。
- Paseo `packages/desktop`（Apache-2.0）：sandbox 里的 preload 只能 `require("electron")`，要打成单个文件；窗口的跳转拦截。
- deepchat `src/main`（Apache-2.0）：`utilityProcess` 宿主的拉起、消息和退出重启（`scheduler/schedulerProcessManager.ts`），托盘模板图。

都是看思路自己写的，没搬代码。
