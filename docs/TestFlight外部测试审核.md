# TestFlight 外部测试审核

目标：让「朋友」组有一条公开链接，谁打开都能装 Pupu。

## 审核员怎么进

单独部署一个审核用的 Pupu：Worker 名 `pupu-review`，地址 `https://pupu-review.cobuilder-team.workers.dev`。

- 代码和线上相同，数据完全分开，审核员看不到真实聊天。
- 不用改 App：连接页本来就能填地址和访问口令。
- 只设 `ACCESS_TOKEN` 和 `DEEPSEEK_API_KEY`。不开 Google 登录、连接器和推送。

## 提交前要完成

- [x] 部署 `pupu-review`（2026-11-04，版本 f4e3bc85）。
- [ ] 设好 `ACCESS_TOKEN` 和 `DEEPSEEK_API_KEY`，在一台设备上走通登录和聊天。
- [x] 隐私说明补上连接账号和远程桌面，已部署到线上和审核两个 Worker（分支 `claude/privacy-connectors`，未合并进 main）。
- [ ] 隐私说明加公开邮箱，再部署一次。
- [ ] 填审核资料：联系人姓名、电话、邮箱，反馈邮箱。
- [ ] 在 App Store Connect 填隐私政策网址：`https://pupu.cobuilder-team.workers.dev/privacy`。
- [ ] 把 `202611041222` 或更新的构建放进「朋友」组并提交审核。
- [ ] 通过后打开「朋友」组的公开链接。

## 要填的内容

### Beta 版 App 描述

Pupu 是一个团体共用的 AI 助手。成员在手机上和它对话、管理项目，它在云端工作，也可以在成员批准后操作成员自己的电脑。

### 测试内容

请测试连接、聊天、项目切换和设置。

### Sign-in information / Notes（填给审核员，用英文）

Username: not required.

Password: `<审核口令>`（在 App Store Connect 里填，不要写进这个文件）

```text
Pupu is an AI assistant shared by a small group. Each group runs its own Pupu server, so the app asks for a server address first.

To sign in:
1. Open the app. On the "连接 Pupu" screen, tap "用配对码或访问口令".
2. Tap "手边没有连上的设备？用访问口令".
3. Address: https://pupu-review.cobuilder-team.workers.dev
4. Access code: the value in the Password field above.
5. Tap "连接".

This is a demo server with no real user data. Google sign-in is turned off on it.

What to try: send a message in the chat, create a project, and open Settings.

Some features need a user's own Mac or accounts, so they are not available on the demo server: remote desktop, running tasks on a computer, and connecting Gmail, Google Calendar, Google Drive or GitHub.

The camera usage string exists because the WebRTC library references camera APIs. Pupu does not use the camera. Conversations are sent to DeepSeek to generate replies, as described in the privacy policy.
```
