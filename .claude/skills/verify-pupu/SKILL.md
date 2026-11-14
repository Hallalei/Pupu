---
name: verify-pupu
description: 驱动真实的 Pupu 证明改动能用：网页走 ego lite，电脑 App 走后台 CDP，iOS 走模拟器。修 bug 复现、改界面或行为后验证、pstack 里要用 control-ui 时都用它。
---

# 验证 Pupu

在隔离实例上走用户的真实路径，留下证据。先读 [features/README.md](features/README.md)，再读要验证的功能文件。

三条路径共用同一个云端，只起要用到的那条：

| 改了哪里 | 路径 |
|---|---|
| `apps/cloud/src` 的服务端和网页 | 网页 |
| `apps/desktop`、`apps/cloud/bridge` | 电脑 App |
| `apps/ios` | iOS |

下面的 `$S` 是 `.claude/skills/verify-pupu/scripts`，`$E` 是 `$PWD/.verify-evidence/<run-id>`，run-id 用 `日期-功能名`。命令都在仓库根目录跑。

## 红线

- 窗口留在后台：电脑 App 只用 `open -g` 和 CDP。原生窗口要看或要点时，用 computer use 的 `app_*` 工具，保持后台控制。
- 只连本机验证实例。线上 `pupu` 和 `pupu-review` 的口令由用户本人输入，要测这两个环境时停下来请用户登录。
- 审批卡片留给用户决定。
- 只关这次启动的东西，按端口或 CDP 关，保留用户自己的 Pupu。

## 启动

起云端：`preview_start {name: "pupu-verify"}`。没有这个工具时在后台跑 `node $S/serve-cloud.mjs`。

它监听 `localhost:5199`，每次从空数据开始，数据在 `/tmp/pupu-verify/state`，用户的开发数据不受影响。日志出现 `ready in` 才算起来。端口被占时跑体检，确认是别的验证在用就等它结束。

然后跑体检：

```bash
node $S/doctor.mjs
```

看到 `NO` 先处理或写进报告。任何时候现象不对都先跑它。

## 驱动

### 网页

用 `ego-browser nodejs` 驱动，整次验证用同一个 TaskSpace。本机没设 `ACCESS_TOKEN`，打开就是已登录状态，不用配对。

```bash
ego-browser nodejs <<'JS'
const task = await taskSpace("verify-pupu <run-id>");
const page = task.page("p1");
await page.goto("http://localhost:5199");
console.log(await page.snapshot());
JS
```

选择器优先用 `loc=css:button[aria-label="新项目"]` 这类 aria-label 和 placeholder。`text="设置"` 用来点侧栏。

### 电脑 App

```bash
(cd apps/desktop && npm run build && open -g -n -a "$PWD/node_modules/electron/dist/Electron.app" \
  --env PUPU_BACKGROUND=1 --env PUPU_URL=http://localhost:5199 \
  --env PUPU_USER_DATA=/tmp/pupu-verify/desktop/userdata --env PUPU_DIR=/tmp/pupu-verify/desktop/pupu \
  --args "$PWD" --remote-debugging-port=9333)
```

`PUPU_BACKGROUND=1` 时窗口一直藏着，不出现在用户屏幕上，CDP 照样能读页面、截图。`node $S/cdp.mjs targets` 能列出「连上 Pupu」窗口就算起来了。测完立刻按端口关掉，不留到下一次。之后用 `cdp.mjs eval '<js>'` 和 `cdp.mjs shot <png>` 操作和截图。

配对：

```bash
CODE=$(curl -s -X POST localhost:5199/api/pairing-codes | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
node $S/cdp.mjs eval "window.pupuPairing.pair({code:'$CODE',adopt:false})"
```

配对成功后窗口跳到 `http://localhost:5199/`，`/api/state` 的 `computers` 里出现这台电脑且 `online` 为 true。

### iOS

```bash
U=<iPhone 的 UDID，从 xcrun simctl list devices available 选>
xcrun simctl boot $U
xcodebuild -project apps/ios/Pupu.xcodeproj -scheme Pupu -sdk iphonesimulator \
  -destination "id=$U" -derivedDataPath /tmp/pupu-verify/ios-dd CODE_SIGNING_ALLOWED=NO build
```

构建要几分钟，放后台跑。用 iOS Simulator 工具的 `launch` 装上 `/tmp/pupu-verify/ios-dd/Build/Products/Debug-iphonesimulator/Pupu.app`，再用配对链接连上：

```bash
CODE=$(curl -s -X POST localhost:5199/api/pairing-codes | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
xcrun simctl openurl $U "pupu://pair?server=http%3A%2F%2Flocalhost%3A5199&code=$CODE"
```

App 弹「连接到 localhost?」，截图找到「连接」再点，点按带 `duration: 0.15`。回到「聊天」页、`/api/state` 的 `devices` 里出现 `phone` 就连上了。

模拟器键盘是拼音，`text` 动作打不出中文。要发中文时走 WebSocket，见 [features/chat.md](features/chat.md)。

## 证据

每项证明放进 `$E`，用功能编号命名。证据目录已被 git 排除，清理时保留。

- 走用户路径，不用内部 setter 或测试接口造结果。`/api/pairing-codes` 只用来拿码，配对动作本身走 App。
- 同时留下动作和结果：操作前后的截图或快照，再加 `curl -s localhost:5199/api/state` 的第二视角。
- 没走到的入口写「没验证」和原因，不算到别的入口头上。

## 清理

按启动的反序做，只做启动过的：

```bash
node $S/cdp.mjs close && rm -rf /tmp/pupu-verify/desktop
BID=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' /tmp/pupu-verify/ios-dd/Build/Products/Debug-iphonesimulator/Pupu.app/Info.plist)
xcrun simctl uninstall $U "$BID" && xcrun simctl shutdown $U
ego-browser nodejs -e 'const task = await taskSpace("verify-pupu <run-id>"); await task.finish({ keep: [] });'
```

模拟器工具再调一次 `detach`，云端用 `preview_stop`。云端退出时自己删掉数据和脚手架配置。

完成标准：`doctor.mjs` 显示 5199 没在跑、CDP 没在跑、没有启动的模拟器、脚手架配置不存在，`$E` 里证据都在。
