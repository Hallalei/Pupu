# 电脑配对

用户在电脑 App 里填配对码，App 拿到窗口和桥两份凭据，这台电脑上线。

## Sub-features

- `desktop.pair`：配对码连上。
- `desktop.online`：电脑在云端显示在线，设置里「这台电脑」一页显示它的状态。

## How to get to it (user POV)

- 第一次打开电脑 App 的配对窗口。

## Driving it with CDP

Preconditions: 按 `SKILL.md` 用 `open -g` 起了电脑 App，`cdp.mjs targets` 显示 `Pupu file://…/pair.html`。

- `desktop.pair`：按 `SKILL.md` 的配对命令。结果：`cdp.mjs targets` 显示 `Pupu http://localhost:5199/`。
- `desktop.online`：`curl -s localhost:5199/api/state`。结果：`devices` 有 `desktop`，`computers` 有这台电脑且 `online` 为 true。

## Gotchas

- 配对成功时窗口会跳转，`cdp.mjs eval` 返回 `null`，以 `targets` 和 `/api/state` 为准。
- 2026-11-04 第一次配对在 `/api/pair` 或 `/api/pairing-codes` 上返回过 500，云端日志是 `Internal server error: fetch failed`，换新码重试成功，根因未查。此时 `desktop` 设备已建出来，`computers` 还是空的。
- 操作屏幕要系统授权，开发版没开屏幕录制和辅助功能时，屏幕相关功能测不了。授权由用户本人开。
