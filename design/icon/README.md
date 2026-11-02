# Pupu 图标

像素风金渐层小猫扒在对话气泡上，气泡里是「正在输入」的三个点，墨色底（2026-11-02 定的方向 C「探头」）。

## 改图

图都在 `pixels.py` 里，一个字符一格，字母查 `PALETTE` 换颜色，`.` 是背景：

- `MAIN`：24×24 主图，iOS、macOS、apple-touch-icon 从它放大；
- `SMALL`：16×16 简化版，favicon 用（24 格缩到 16px 会糊，所以另画）；
- `TRAY`：16×16 菜单栏剪影，`#` 不透明；
- `DARK`、`TINTED`：iOS 深色、着色外观要换的几种颜色。

改完跑：

```bash
python3 design/icon/export.py
```

要 Pillow（系统自带的 python3 已经装了）。macOS 26 的 `Assets.car` 要 Xcode 26 的 actool，没有就跳过这一步，其余照出。

## 出了哪些文件

| 端 | 文件 | 说明 |
|---|---|---|
| 源图 | `design/icon/out/pupu-icon.svg`、`pupu-icon-16.svg` | 矢量版，放多大都不糊 |
| 源图 | `design/icon/out/pupu-icon-1024*.png` | 浅色、深色、着色三张 1024 |
| iOS | `apps/ios/Pupu/Assets.xcassets/AppIcon.appiconset/` | 单尺寸 1024，浅色、深色（透明底，系统垫底色）、着色（灰度、黑底） |
| 网页 | `apps/cloud/public/favicon.ico`、`favicon.svg`、`apple-touch-icon.png` | ico 里有 16、32 两张；`index.html` 里引用 |
| 电脑 App | `apps/desktop/icons/icon.icns` | 老式图标，macOS 26 以前和 DMG 用 |
| 电脑 App | `apps/desktop/icons/AppIcon.icon/`、`Assets.car` | macOS 26 的图标：Icon Composer 格式，编好的 `Assets.car` |
| 电脑 App | `apps/desktop/static/icons/tray-*.png`、`dock.png` | 菜单栏四种状态（各 1x、2x），开发版程序坞图标 |

工程里 `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon` 写在项目级的构建设置里。电脑 App 打包时怎么放图标，见 `apps/desktop/README.md` 的「图标」。

## 参考了谁

- iOS 三种外观的 `Contents.json`：[LoopFollow](https://github.com/loopandlearn/LoopFollow) 的 `AppIcon.appiconset`。
- `.icon` 编成 `Assets.car` 的 actool 参数：[kinopio-client](https://github.com/kinopio-club/kinopio-client) 的 `src-tauri/compile-icon.js`。
- 打包时同时放 icns 和 `Assets.car`（`CFBundleIconFile` + `CFBundleIconName`）：[comm](https://github.com/CommE2E/comm) 的 `desktop/forge.config.cjs`。
- 菜单栏模板图 1x、2x 各加一份：[emdash](https://github.com/generalaction/emdash) 的 `apps/emdash-desktop/src/main/host/tray.ts`。
