# 项目

用户建一个项目，它出现在项目列表里，打开后有自己的输入栏。

## Sub-features

- `project.create`：填名字和目标后建立。
- `project.empty-name`：不填名字时提示「先给项目起个名字」。
- `project.open`：建好后进入项目页。

## How to get to it (user POV)

- 网页宽屏：侧栏「项目」右边的「新项目」按钮。
- 手机：顶部三段的「项目」。
- 聊天里让 Pupu 建项目（需要模型）。

## Driving it with ego-browser

Preconditions: 网页路径已打开，`page` 是 TaskSpace 的 `p1`。

- `project.create`：
  ```js
  await page.click('loc=css:button[aria-label="新项目"]');
  await page.fill('loc=css:input[aria-label="项目名"]', "验证项目");
  await page.fill('loc=css:textarea[aria-label="目标"]', "证明建项目能走通");
  await page.click('text="建立"');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  ```
  结果：地址变成 `#/projects/<id>`，出现 `textarea[placeholder="在「验证项目」里说"]`，`/api/state` 的 `projects` 有这一项。

## Gotchas

- `waitForSelector` 不支持 `>>` 接 `text=`，用 `page.snapshot()` 或 `waitForFunction` 判断。
- 窄屏下侧栏隐藏，「新项目」按钮不可见。
