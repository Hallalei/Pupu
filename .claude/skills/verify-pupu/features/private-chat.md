# 私聊

每个成员有一条只有自己和 Pupu 的私聊。中间一段长按或右键，在大家和私聊之间切换。

## Sub-features

- `private.switch`：长按或右键中间一段弹两行菜单，当前项打勾。选私聊后天空变夜空，输入栏写「只发给 Pupu」。
- `private.isolated`：别人连不上你的私聊，会话 WebSocket 收到 `打不开这条聊天` 后以 1011 关闭。查不到的会话也一样。
- `private.dot`：没在显示的那条有 Pupu 的新回复时，头像右上角亮红点；切过去就消失。
- `private.home`：私聊状态下，主页输入栏发的话进私聊。
- `private.handoff`：私聊里转交前 Pupu 先说内容会公开。报告卡回到这条私聊，别人的 `/api/state` 里没有这张卡，项目里不带无关私事。
- `private.approval`：私聊发起的电脑动作，审批卡和「正在做」只给发起人和电脑主人。第三个人的 `/api/state`、`activity` 帧里都没有。

## How to get to it (user POV)

- 手机宽度：长按顶部中间一段。电脑浏览器窄窗口：右键。
- 宽屏：左侧栏「大家」「私聊」。

## Driving it with ego-browser

Preconditions: 要几个成员，`apps/cloud/.dev.vars` 按 `apps/cloud/README.md` 的「本地测 Google 登录」写好，`node apps/cloud/dev/fake-google.mjs` 在跑。没带凭据时没有成员身份，`chats.private` 是 null，不弹菜单。

- 登录：不带凭据也算已登录，不显示登录页，直接打开 `/api/auth/google/start?client=browser`，再点 `loc=css:#owner` 或 `loc=css:#family`。
- 第二个成员要单独的 cookie：换一个 host。`localhost` 给创建者，`127.0.0.1` 给成员。vite 只听 `::1`，先在 `127.0.0.1:<端口>` 起一个转发到 `[::1]:<端口>` 的 TCP 小脚本。`GOOGLE_OIDC_DEV_BASE` 和 `isLocal` 这两个 host 都认。
- 邀请：创建者登录后，`curl -X POST /api/pair -d '{"kind":"phone","name":"验证手机"}'` 拿到一张归创建者的手机凭据，再带 `Authorization: Bearer` 调 `POST /api/members`。这张凭据也用来批准审批。
- 第三个成员不用开浏览器：`curl -c jar` 走 `/api/auth/google/start`，给跳转地址加 `&email=stranger@example.com`，再回到 callback。之后用 `curl -b jar localhost:<端口>/api/state` 看。
- 窄屏：`await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: false })`。每次 `ego-browser nodejs` 都要重设。
- `private.switch`（右键）：
  ```js
  const box = await page.evaluate(() => {
    const r = document.querySelector("[role=tab][aria-label]").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y, { button: "right" });
  await page.click('text="私聊"');
  await page.waitForSelector('loc=css:textarea[placeholder="只发给 Pupu"]');
  ```
- `private.switch`（长按）：`Emulation.setTouchEmulationEnabled`，然后 `Input.dispatchTouchEvent` 的 `touchStart`，等 650 毫秒，再 `touchEnd`。
- `private.isolated`：在成员页面里 `new WebSocket("ws://" + location.host + "/agents/pupu/me?_pk=" + crypto.randomUUID() + "&session=<别人的私聊>")`。`/api/state` 的 `chats.private.session` 是各人的私聊。
- `private.dot`：林夏停在私聊，阿周在大家发一句。结果：林夏那边中间一段的 `aria-label` 变成「私聊，大家有新消息」。

## Gotchas

- 这几项都要模型回复，会扣 DeepSeek 余额，用短句。
- `private.approval` 要真的电脑：`PUPU_DIR=/tmp/... node bridge/main.ts pair`，再 `start`，把电脑改成 `ask_all`（`POST /api/computers/<id>/policy`），命令只用 `echo`。
- 新建私聊的会话 id 不连续，不要写死，从 `chats.private.session` 读。
- 连接器读动作要配 open-connector，本机通常没有，这条靠 `bridge/connectors.test.ts` 证明。
