# 手机连接

用户打开配对链接，确认后手机连上 Pupu，看到聊天和项目。

## Sub-features

- `ios.pair-link`：`pupu://pair` 链接连上。
- `ios.home`：连上后显示主页、聊天、项目三段。

## How to get to it (user POV)

- 打开配对链接或扫二维码。
- 连接页的「用配对码或访问口令」。

## Driving it with iOS Simulator

Preconditions: 按 `SKILL.md` 构建并 `launch`，App 停在「连接 Pupu」。

- `ios.pair-link`：按 `SKILL.md` 的 `openurl` 命令，截图后点「连接」。结果：`/api/state` 的 `devices` 有 `phone`。
- `ios.home`：截图。结果：顶部三段和「给 Pupu 发消息」输入栏可见。

## Gotchas

- 对话框是 App 自己的「连接到 localhost?」，iPhone 17 Pro 上「连接」约在 (278, 499)，以截图为准。
- 零时长点按选不中集合视图的行，`duration` 用 0.15。
- 菜单有动画，点菜单项前再截一次图。
