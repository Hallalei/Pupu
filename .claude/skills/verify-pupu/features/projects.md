# 项目

用户建一个空间（原来叫项目），它出现在空间列表里，打开后有自己的输入栏。导航照设计规范：宽屏左边侧栏，窄屏左上角切换按钮打开切换 sheet。

## Sub-features

- `project.create`：填名字和目标后建立。
- `project.empty-name`：不填名字时提示「先给项目起个名字」。
- `project.open`：建好后进入项目页。
- `project.list`：窄屏左上角切换按钮（`button[aria-label^="切换"]`）从底部弹出切换 sheet：「我的 Pupu」和「资料」一组；「空间」组标题右边「新空间」；每个空间一行（标记方块、名字、成员头像或楼），当前的加粗打勾，下面挂着正在做和等你批准的子会话；最下面是自己（进设置）。点一行切过去，sheet 收起，窗框换成那个空间的颜色。宽屏这份列表常驻在左侧栏。
- `project.header`：窄屏顶栏画在窗框上：中间标记方块加空间名，右边成员头像胶囊（点开空间设置）。宽屏是主卡片的头一行：标记、名字、成员头像、「邀请」（只有主人有）。

## How to get to it (user POV)

- 网页宽屏：侧栏「空间」右边的「+」（`button[aria-label="新空间"]`，见 spaces.md）。
- 网页窄屏：左上角切换按钮，sheet 里「新空间」。
- 手机 App：iOS 还没换新导航，照旧顶部两段的「项目」。
- 聊天里让 Pupu 建项目（需要模型）。

## Driving it with ego-browser

Preconditions: 网页路径已打开，`page` 是 TaskSpace 的 `p1`。

- `project.create`：
  ```js
  await page.click('loc=css:button[aria-label="新空间"]');
  await page.fill('loc=css:input[aria-label="项目名"]', "验证项目");
  await page.fill('loc=css:textarea[aria-label="目标"]', "证明建项目能走通");
  await page.click('text="建立"');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  ```
  结果：地址变成 `#/projects/<id>`，出现 `textarea[placeholder="在「验证项目」里说"]`，`/api/state` 的 `projects` 有这一项。

## Gotchas

- `waitForSelector` 不支持 `>>` 接 `text=`，用 `page.snapshot()` 或 `waitForFunction` 判断。
- 窄屏下侧栏隐藏，先点 `button[aria-label^="切换"]`，再点 sheet 里的「新空间」。
- 宽屏没有切换按钮和顶栏，列表在侧栏，空间名在主卡片头一行。
- 只差 hash 的地址（`#/` 换 `#/docs`）不会重新加载页面，React 状态还在；要从头开始先打开 `about:blank`。
