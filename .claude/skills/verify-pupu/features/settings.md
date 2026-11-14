# 设置

用户打开设置，看到电脑、设备列表和连接新设备的入口。

## Sub-features

- `settings.open`：打开设置面板。
- `settings.devices`：列出已配对的手机、浏览器和电脑 App。
- `settings.pairing-code`：生成配对码。

## How to get to it (user POV)

- 网页宽屏：侧栏最下面自己的头像和名字。
- 网页窄屏：左上角切换按钮，sheet 最下面自己那一行。
- 手机 App：右上角「我」（iOS 还没换新导航）。

## Driving it with ego-browser

Preconditions: 网页路径已打开。

- `settings.open`：宽屏 `await page.click('loc=css:nav button[aria-label="设置"]');`，窄屏先点 `button[aria-label^="切换"]` 再点 sheet 里的 `button[aria-label="设置"]`。 结果：快照出现「电脑」「手机、浏览器和电脑 App」「连接新设备」。
- `settings.pairing-code`：点 `text="生成配对码"`。结果：面板显示 `XXXX-XXXX` 格式的码。

## Gotchas

- 空数据下显示「还没有授权的电脑。」和「还没有配对的手机、浏览器或电脑 App。」，这是正常状态。
- 本机不带凭据访问时，网页自己不算一台设备，所以列表可以是空的。
