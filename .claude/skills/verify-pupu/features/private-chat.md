# 私聊

每个成员有一条只有自己和 Pupu 的私聊。「我的 Pupu」就是它（宽屏侧栏第一行，窄屏切换 sheet 第一行）；原来的「大家」成了空间列表第一个的「全员」（见 spaces.md 的 `space.everyone`）。2026-11-14 起没有长按切换。

## Sub-features

- `private.open`：登录后「我的 Pupu」直接是私聊，输入栏「只发给 Pupu」，窗框是 canvas（不是空间，不染色）。`/api/state` 第一次拿到之前只转圈、没有输入栏，免得发到全员。
- `private.isolated`：别人连不上你的私聊，会话 WebSocket 收到 `打不开这条聊天` 后以 1011 关闭。查不到的会话也一样。
- `private.dot`：私聊有 Pupu 的新回复、人不在「我的 Pupu」时，那一行名字加粗、行尾一个墨色圆点（宽屏侧栏、窄屏切换 sheet），窄屏顶栏的切换按钮右上角也有一个墨色小点。全员的新消息在「全员」那行同样标。
- `private.handoff`：私聊里转交前 Pupu 先说内容会公开。报告卡回到这条私聊，别人的 `/api/state` 里没有这张卡，项目里不带无关私事。
- `private.approval`：私聊发起的电脑动作，审批卡和「正在做」只给发起人和电脑主人。第三个人的 `/api/state`、`activity` 帧里都没有。

## How to get to it (user POV)

- 宽屏侧栏第一行「我的 Pupu」；窄屏左上角切换按钮，sheet 第一行。手机 App 还是顶部「Pupu」段（iOS 还没换新导航）。

## Driving it with ego-browser

Preconditions: 要几个成员，`apps/cloud/.dev.vars` 按 `apps/cloud/README.md` 的「本地测 Google 登录」写好，`node apps/cloud/dev/fake-google.mjs` 在跑。没带凭据时没有成员身份，`chats.private` 是 null，聊天这一段退回全员那条（老行为）。

- 登录：不带凭据也算已登录，不显示登录页，直接打开 `/api/auth/google/start?client=browser`，再点 `loc=css:#owner` 或 `loc=css:#family`。
- 第二个成员要单独的 cookie：换一个 host。`localhost` 给创建者，`127.0.0.1` 给成员。vite 只听 `::1`，先在 `127.0.0.1:<端口>` 起一个转发到 `[::1]:<端口>` 的 TCP 小脚本。`GOOGLE_OIDC_DEV_BASE` 和 `isLocal` 这两个 host 都认。
- 邀请：创建者登录后，`curl -X POST /api/pair -d '{"kind":"phone","name":"验证手机"}'` 拿到一张归创建者的手机凭据，再带 `Authorization: Bearer` 调 `POST /api/members`。这张凭据也用来批准审批。
- 第三个成员不用开浏览器：`curl -c jar` 走 `/api/auth/google/start`，给跳转地址加 `&email=stranger@example.com`，再回到 callback。之后用 `curl -b jar localhost:<端口>/api/state` 看。
- 窄屏：`await page.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: false })`。每次 `ego-browser nodejs` 都要重设。
- `private.open`：`await page.waitForSelector('loc=css:textarea[placeholder="只发给 Pupu"]')`。测转圈：拦住 `/api/state`（停掉服务或 `Fetch.enable` 挂起），应只有「正在打开」，没有 textarea。
- `private.isolated`：在成员页面里 `new WebSocket("ws://" + location.host + "/agents/pupu/me?_pk=" + crypto.randomUUID() + "&session=<别人的私聊>")`。`/api/state` 的 `chats.private.session` 是各人的私聊。
- `private.dot`：林夏停在某个空间，阿周在全员发一句。结果：林夏那边侧栏（或切换 sheet）「全员」那行加粗带墨色圆点，窄屏切换按钮右上角有点。

## Gotchas

- 这几项都要模型回复，会扣 DeepSeek 余额，用短句。
- `private.approval` 要真的电脑：`PUPU_DIR=/tmp/... node bridge/main.ts pair`，再 `start`，把电脑改成 `ask_all`（`POST /api/computers/<id>/policy`），命令只用 `echo`。
- 新建私聊的会话 id 不连续，不要写死，从 `chats.private.session` 读。
- 连接器读动作要配 open-connector，本机通常没有，这条靠 `bridge/connectors.test.ts` 证明。
