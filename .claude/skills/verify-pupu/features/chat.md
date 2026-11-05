# 聊天

用户发一条消息，Pupu 流式回复。模型不可用时，消息下面显示出错原因。

## Sub-features

- `chat.send`：发消息后消息出现在列表。
- `chat.reply`：Pupu 回复。需要 `DEEPSEEK_API_KEY`，会扣真实余额。
- `chat.model-error`：没配模型时显示「模型出错了，这条没回上：Provider is not configured: deepseek」。

## How to get to it (user POV)

- 网页和手机：「聊天」页的「给 Pupu 发消息」。
- 项目页：「在「项目名」里说」。

## Driving it with ego-browser

Preconditions: 网页路径已打开。`chat.reply` 还要 `doctor.mjs` 里 DEEPSEEK 一行是 `ok`。

- `chat.send`：
  ```js
  await page.fill('loc=css:textarea[placeholder="给 Pupu 发消息"]', "你好");
  await page.click('loc=css:button[aria-label="发送"]');
  ```
  结果：快照里出现这条消息，随后出现回复或 `chat.model-error` 的文字。

模拟器发中文：键盘是拼音，改用会话 WebSocket `ws://localhost:5199/agents/pupu/me?_pk=<uuid>&session=1`，发 `{"type":"submit","id":<uuid>,"input":...,"whenBusy":"followUp"}`，App 里会像真发一样流式显示。

## Gotchas

- `chat.reply` 每次都扣真实 DeepSeek 余额，一条短消息够证明。`doctor.mjs` 里 DEEPSEEK 一行是 `NO` 时，报告写「没验证」。
- 没配模型时看到的错误提示证明的是 `chat.model-error`，不是 `chat.reply`。
