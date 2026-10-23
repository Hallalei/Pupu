# Pupu 云端（v0）

Pupu 的云端部分：一个 Cloudflare Durable Object，里面跑 pi-durable；还有一个网页，分「主页」「聊天」「项目」三屏，交互参考 Hark，界面用 HeroUI v3。

这一版还不连电脑，所以 Pupu 只能聊天、建项目，碰不到你电脑上的 Claude Code、Codex 等会话。

## 结构

| 文件 | 内容 |
|---|---|
| `src/server.ts` | `Pupu` Durable Object，以及 Worker 的路由、鉴权和 REST API |
| `src/prompt.ts` | 聊天和项目会话的系统提示词。聊天里会附上项目的实时状态 |
| `src/tools.ts` | Pupu 能用的工具：`list_projects`、`create_project`（用户在聊天里答应后才建）、`hand_off_to_project`（把事交给已有项目去做） |
| `src/messages.ts` | 两种特殊的用户消息：聊天转交给项目的消息、引用回复 |
| `src/projects.ts` | 项目等元数据的存储，放在 DO 的 SQLite 里，表名前缀 `pupu_` |
| `src/sockets.ts` `protocol.ts` `view.ts` `transcript.ts` | 把 pi 会话放到 WebSocket 上，并把事件折叠成界面状态。改编自 Cloudflare 官方的 pi 示例 |
| `src/client/` | React 网页 |

会话的组织方式：
- 聊天（主对话）是 pi 的根会话 `"1"`；
- 每个项目通过 `harness.sessions.create()` 单独开一个 pi 会话；
- 这些会话都在同一个 DO 里。

模型用的是 Workers AI 的 `@cf/openai/gpt-oss-120b`。选它的原因：Workers 免费套餐就能用、支持工具调用，而且实测响应最快。要换模型，改 `src/server.ts` 里的 `MODEL_ID`，已有会话会在 DO 重启时自动切过去。

## 本地运行

```bash
npm install
npm run dev
```

然后打开 http://localhost:5173 。

需要先执行 `npx wrangler login`：Workers AI 走的是远程调用，会产生用量。

本地数据存在 `.wrangler/state/`，删掉这个目录就能从头开始。

## 部署

```bash
npx wrangler secret put ACCESS_TOKEN
npm run deploy
```

第一步设一个访问口令，不设的话任何人都能用你的 Pupu。

部署后，第一次访问打开 `https://<你的 workers 域名>/api/login?token=<口令>`。这一步会写入 cookie，之后直接访问首页即可。

## 许可证

`src/sockets.ts`、`protocol.ts`、`view.ts`、`transcript.ts` 和 `src/client/use-pi-session.ts` 改编自 [cloudflare/agents](https://github.com/cloudflare/agents) 的 `examples/next/harnesses/pi`（MIT 协议）。pi 本身也是 MIT 协议。两份许可证原文都在 `licenses/` 下。
