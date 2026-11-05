# 聊天

用户发一条消息，Pupu 流式回复。模型不可用时，消息下面显示出错原因。

## Sub-features

- `chat.send`：发消息后消息出现在列表。
- `chat.reply`：Pupu 回复。需要 `DEEPSEEK_API_KEY`，会扣真实余额。
- `chat.model-error`：没配模型时显示「模型出错了，这条没回上：Provider is not configured: deepseek」。
- `chat.sender`：多个成员时，别人的消息靠左、带头像和名字，自己的靠右；只有一个成员时不显示名字；Pupu 答得出是谁说的。

## How to get to it (user POV)

- 网页和手机：「聊天」页的「发给大家和 Pupu」。私聊是「只发给 Pupu」，见 [private-chat.md](./private-chat.md)。
- 项目页：「在「项目名」里说」。

## Driving it with ego-browser

Preconditions: 网页路径已打开。`chat.reply` 还要 `doctor.mjs` 里 DEEPSEEK 一行是 `ok`。

- `chat.send`：
  ```js
  await page.fill('loc=css:textarea[placeholder="发给大家和 Pupu"]', "你好");
  await page.click('loc=css:button[aria-label="发送"]');
  ```
  结果：快照里出现这条消息，随后出现回复或 `chat.model-error` 的文字。

模拟器发中文：键盘是拼音，改用会话 WebSocket `ws://localhost:5199/agents/pupu/me?_pk=<uuid>&session=1`，发 `{"type":"submit","id":<uuid>,"input":...,"whenBusy":"followUp"}`，App 里会像真发一样流式显示。

`chat.sender` 要两个人：

1. `apps/cloud/.dev.vars` 按云端 README「本地测 Google 登录」配好，`node apps/cloud/dev/fake-google.mjs` 跑在后台，再起云端。
2. `curl -X POST localhost:5199/api/members -H 'content-type: application/json' -d '{"email":"family@example.com"}'` 邀请阿周。
3. 两个人要两份 cookie：ego-browser 和内置浏览器各开 `http://localhost:5199/api/auth/google/start?client=browser`，分别选 owner 和 family。`127.0.0.1` 连不上，验证实例只听 localhost。
4. 一边发消息，另一边看名字，再问「这是谁定的」。

结果：`/agents/pupu/me` 快照里成员发的消息 kind 是 `pupu.sent`，`data.sender` 是服务端查的，客户端带 `sender` 字段不算数。

## Gotchas

- `chat.reply` 每次都扣真实 DeepSeek 余额，一条短消息够证明。`doctor.mjs` 里 DEEPSEEK 一行是 `NO` 时，报告写「没验证」。
- 没配模型时看到的错误提示证明的是 `chat.model-error`，不是 `chat.reply`。
