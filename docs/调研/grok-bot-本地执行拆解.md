# Grok Bot 的「云端 Agent + 本地执行」拆解

> 日期：2026-10-24
> 对象：本机安装的 Grok Bot 0.75.0（`/Applications/Grok Bot.app`，bundle id `com.anysphere.sand`，由 Anysphere 开发），以及 0.18 的非官方 TypeScript 重建版（`~/Downloads/grok-bot-0.18-reconstructed-main.zip`）。
> 0.18 重建版的整体拆解见 `~/Desktop/Raft 调研/01-产品架构与机制/grok-bot-0.18拆解与Raft对比-2026-08-26.md`。本文只看一件事：云端的 Agent 怎么把本机当执行环境用，以及 Pupu 的电脑端可以借什么。
> 0.75 是压缩打包后的代码，可读源码只有 0.18 的。下文的协议细节按 0.18 源码写。0.75 的 `dist/local-exec-daemon/main.cjs` 里仍然有 `/local-exec/requests`、`/local-exec/responses`、`text/event-stream` 和 `retire-approval`，说明协议没有变。0.75 的 daemon 多了 computer use 和截图。

## 1. 分层

```
云端 box（host）                                  本机
┌────────────────────────────┐                ┌──────────────────────────────────────┐
│ Agent 回合、transcript、    │  SSE 下发请求  │ local-exec daemon（独立 Node 进程）    │
│ 工具图                     │ ─────────────▶ │  SandLocalExecProvider               │
│ SandLocalExecBridge        │                │  执行 shell/读/写/列目录/传文件/截图    │
│  ├ providers：每台电脑一个  │ ◀───────────── │                                      │
│  └ pending：requestId→队列  │  POST 批量回包 │                                      │
└────────────────────────────┘                └──────────────▲───────────────────────┘
                                                             │ 拉起、接管、替换；
                                                             │ 写入连接和凭据文件
                                              ┌──────────────┴───────────────────────┐
                                              │ supervisor（在桌面 App 的 coordinator │
                                              │ 进程里）                              │
                                              └──────────────────────────────────────┘
```

- **Agent 的回合只在云端跑。** 本机不跑模型，也不持有 transcript，只提供底层执行原语。所以电脑断开时 Agent 不会停，只是本地工具报错。
- **本机分两层。** supervisor 管 daemon 的生命周期，daemon 负责连云端、干活。App 退出或升级时，daemon 可以继续活着：如果它还有没做完的请求（`inflightCount > 0`），新的 supervisor 会接管它，而不是杀掉。

## 2. 线上协议（`shared/local-exec-gateway.ts`、`host/local-exec/local-exec-provider.ts`）

**传输：**
- 下行：本机发 `GET /local-exec/requests`（`accept: text/event-stream`），一直挂着。
- 上行：本机发 `POST /local-exec/responses`，body 是 `{providerId, frames: [...]}`，可以批量。
- 认证：`authorization: <scheme> <token>`，token 是给 daemon 单独签发的凭据。

**云端发给本机的帧：**

| kind | 用途 |
|---|---|
| `welcome {providerId}` | 连上后分给这条连接一个 id，之后的回包都带它 |
| `exec {requestId, approvalId?, serverMessage}` | 执行一个动作；`serverMessage` 是 protobuf 的 JSON 形式 |
| `upload / download {requestId, path, …}` | 传文件，base64，单个上限 100 MiB |
| `cancel {requestId}` | 中止，云端的 AbortSignal 会一路传到这里 |
| `retire-approval {approvalId}` | 一次授权用完了，本机作废 |

**本机发给云端的帧：**

| kind | 用途 |
|---|---|
| `hello {computerId, label, localRoot, terminalsFolder, supervised, variant}` | 声明这台电脑是谁、根目录和终端输出目录在哪 |
| `ping {supervised}` | 心跳，每 10 秒一次 |
| `client / control {requestId, message}` | 执行结果，流式返回；`control` 是 `throw` 或 `streamClose` |
| `file / file-error {requestId}` | 文件传输结果 |

**时间参数：**
- 心跳 10 秒；超过 30 秒没心跳就算掉线。
- 云端等第一个回包 10 秒，超时就发 cancel，并报「电脑不可用」。
- 本机的 SSE 35 秒没收到数据就重连，退避 1 到 10 秒。连续失败 3 次后，重新读一遍连接信息再连。
- 回包 POST 失败重试 3 次，还失败就丢掉这批。

**exec 支持的动作**（0.18）：
- `shellStreamArgs`、`backgroundShellSpawnArgs`、`forceBackgroundShellArgs`、`writeShellStdinArgs`：命令，可以放到后台，可以写 stdin；
- `readArgs`、`redactedReadArgs`：读文件；
- `lsArgs`：列目录。

0.75 加了 computer use 和截图。

## 3. 云端怎么管多台电脑（`SandLocalExecBridge`）

- 每条 SSE 连接是一个 provider。`hello` 之后它才有 computerId 和 label。
- `listComputers()`：按 computerId 去重，给出每台电脑在不在线。
- 不指定电脑时，从在线的 provider 里挑分最高的：被 supervisor 管着的加 4 分，正式版加 2 分，lab 版加 1 分；同分挑最近有心跳的。指定电脑时只在那台里挑。
- 拒绝执行时分三种原因上报：`no_providers`（一台都没连）、`computer_unknown`（没有这台）、`stale_heartbeat`（连着但心跳超时）。给模型的错误是人话，比如「你的电脑现在没连上，桌面 App 要开着才能在上面跑命令」，模型可以直接转述给用户。
- 每个请求由 `requestId` 对应一个 FrameQueue，回包按 requestId 塞进去。请求本身是一个 async generator，所以流式输出和取消是天然支持的。

## 4. 权限：云端和本机各判一次

1. 云端先把 exec 翻译成一句人话，比如「运行命令 xxx」「读文件 xxx」「写入 stdin」，再走 `authorizeLocalToolAction`，需要的话问用户，得到一个 `approvalId`。翻译不出来、又要求审批的动作，直接拒绝。
2. 本机收到后，用同样的翻译再判一次（`isLocalUseBlocked`），可以拒绝云端已经批准的动作，拒绝以 `control throw` 返回。
3. 一次授权用完，云端广播 `retire-approval`，本机作废这个 id。

用户设置里有 `localToolPermission: "always"`，以及 computer use、本机设备工具两个独立开关（`local-computer-use-gate.json`、`mac-device-tools-gate.json`，现在都是关的）。

## 5. 本机 supervisor 的细节（`node-agent-coordinator/local-exec/supervisor.ts`）

**状态机：** `absent → spawn → active`。已经有 daemon 时，看它手上有没有没做完的请求：
- 有，就接管（adopt）；
- 没有，就换掉（replace），杀旧的、起新的。

**怎么判断「它还是那个进程」：**
- daemon 启动后写一个发现文件 `local-exec-daemon.json`，内容是 pid、startedAt、entryRealpath、generationToken、inflightCount；
- supervisor 拿这个文件和系统里的进程比对（pid、启动时间、命令行里带的 generationToken）。

这样不会误杀 pid 被复用的别的进程。如果发现文件里的「代」变了，但旧进程还活着，就把它隔离起来，不再自动拉起新的。

**节奏：**
- 每秒检查一次健康；
- 每 30 秒刷新一次连接信息，写到 `local-exec-daemon-connection.json`，同时写 supervisor 的心跳文件；
- 凭据只发一次，写到 `local-exec-daemon-credential.json`。

两个文件都是加密封装的（`sandSealedFile`）。

**其他：**
- 连续重生超过 10 次就停下，标记失败。
- App 进入暂停态时，主动退掉 daemon、删掉连接文件。
- daemon 用 `ELECTRON_RUN_AS_NODE=1` 起，复用 App 自带的 Node，不依赖系统里装的 Node。

## 6. 值得注意的设计

- **终端输出写成文件。** 后台命令的输出放在 `localRoot/terminals/` 下，Agent 用普通的读文件去追。长任务不用占着连接，断线重连后也不丢输出。
- **路径收在根目录里。** 文件传输经过 `containPath`，只能落在 `localRoot` 下；shell 本身不受这个限制。
- **按电脑路由。** 工具调用可以带 computerId，所以一个 Agent 能同时用好几台电脑。
- **出错信息给模型看。** 错误文案是写给模型、让它转告用户的，不是给开发者看的堆栈。

## 7. 对 Pupu 电脑端的启发

Pupu 和 Grok Bot 是同一种分工：Agent 的回合在云端跑，电脑只是执行环境，人的交互入口只有 Pupu（2026-10-24 确认，见需求说明 4.4）。所以 Grok Bot 这套做法基本可以照搬：

| Grok Bot | Pupu 的做法 |
|---|---|
| 云端 `SandLocalExecBridge`：provider 注册、hello、心跳、按 requestId 流式回包、cancel、回包超时 | 照搬到 PupuDO 里，做一个电脑桥接，帧的种类和语义基本一致 |
| HTTP 网关：SSE 下行加 POST 上行 | DO 原生支持可休眠的 WebSocket，一条连接双向走同样的帧。心跳用 `setWebSocketAutoResponse` 回 pong，不用唤醒 DO |
| 执行原语：前台命令、后台命令、写 stdin、读文件、列目录、传文件；0.75 加了截图和 computer use | 第一批照搬命令和文件，第二批做截图和 computer use |
| 后台命令的输出写成 `terminals/` 下的文件，Agent 去追 | 照搬。长任务不占连接，断线不丢输出 |
| 文件传输限制在 `localRoot` 下，单个文件上限 100 MiB | 照搬 |
| 两次权限判断加 approvalId，一次授权用完就作废 | 对上需求里的分级：云端按级别决定要不要问人，本机按本机开关再判一次 |
| 多台电脑、按 computerId 路由、打分挑默认 | 对上「授权给 Pupu 的任何电脑」 |
| 错误信息写给模型看，让它转告用户 | 照搬：电脑没连上、心跳超时、这台电脑不存在，各有一句人话 |
| supervisor 加 daemon，有活在跑就接管而不是杀掉 | 刘海 App 是 supervisor，桥是 daemon。第一步先不做 supervisor，用 launchd 常驻桥 |
| 每个 daemon 单独签发凭据 | 不复用网页的访问口令，每台电脑一个设备凭据，可以单独吊销 |

Grok Bot 没有、Pupu 要多做的：
- **人离开时接管屏幕，并在刘海显示「Pupu 正在操作」。** 0.75 有 computer use，但没有看到「用户在场还是离开」的判断。
- **手机优先的交互。** Grok Bot 的入口是桌面 App；Pupu 的入口是手机上的聊天和项目，电脑端只有桥和刘海。
