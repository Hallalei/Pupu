# 手机连接

用户打开配对链接，确认后手机连上 Pupu，停在「我的 Pupu」。

## Sub-features

- `ios.pair-link`：`pupu://pair` 链接连上。
- `ios.sections`：连上后停在「我的 Pupu」：顶栏左边是切换按钮，中间是 Pupu 头像和「我的 Pupu」，空间和设置都从切换按钮进。

## How to get to it (user POV)

- 打开配对链接或扫二维码。
- 登录页填配对码，或者「用访问口令」。

## Driving it with iOS Simulator

Preconditions: 按 `SKILL.md` 构建并 `launch`，App 停在登录页。

- `ios.pair-link`：按 `SKILL.md` 的 `openurl` 命令，截图后点「连接」。结果：`/api/state` 的 `devices` 有 `phone`。
- `ios.sections`：截图。结果：顶栏的切换按钮和「我的 Pupu」可见；有成员身份的手机输入栏写「给 Pupu 发消息」，没有的写「在「全员」里说」。

## Gotchas

- 对话框是 App 自己的「连接到 localhost?」，iPhone 17 Pro 上「连接」约在 (278, 499)，以截图为准。
- 零时长点按选不中集合视图的行，`duration` 用 0.15。
- 菜单有动画，点菜单项前再截一次图。
