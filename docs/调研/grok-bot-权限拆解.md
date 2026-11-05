# Grok Bot 的权限怎么做

> 日期：2026-11-03
> 对象有两个：
> - Grok Bot 0.18 的非官方 TypeScript 重建版（`~/Downloads/grok-bot-0.18-reconstructed-main.zip`），第 1 到 6 节按它写，路径相对它的 `source/`；
> - 本机装的 0.78.1（`/Applications/Grok Bot.app`），第 7 节按它写。0.78 只有压缩过的包，Agent 回合跑在云端 box 里，桌面包里没有 host 的代码。所以第 7 节的依据是三样东西：preload 暴露给页面的方法和参数（`dist/electron-preload/preload.cjs`）、里面的枚举值、界面上的英文文案（`dist/renderer/assets/*.js`）。
>
> 本机执行协议见 `grok-bot-本地执行拆解.md`，本文只讲权限。

## 1. 先看清它的前提：一个 bot 只有一个主人

Grok Bot 的每个 bot 有自己的一台云电脑（box），在 box 里跑命令、读文件都不用批。要动的是「用户的电脑」，那是另一组工具（ExternalShell、ExternalRead、CopyToBox 等），要过权限。

所有拒绝的话术最后都是一句「用你自己的电脑（Shell、Read、AwaitShell）」，见 `shared/local-tool-permission-machinery.ts` 里的 `SAND_LOCAL_TOOLS_*_MESSAGE`。

能批准的只有这个 bot 的主人。别的人进来只是房间里的客人，见第 6 节。

## 2. 第一层：用户电脑的总开关，三档

`shared/local-tool-permission.ts`：

| 档 | 含义 |
|---|---|
| `never` | 用户电脑上的工具全关，模型被告知别再试 |
| `ask`（默认） | 每个动作弹卡片问 |
| `always` | 不问，直接跑 |

- 管的动作：`run-command`、`send-input`、`read-file`、`list-directory`、`write-file`。
- computer use 和 Mac 设备工具各有一个独立开关，默认关。
- **团队管理员能设上限。** `electron-main/account/cursor-profile.ts` 的 `fetchLocalToolPermissionCeiling` 从团队管理设置读 `localToolControls.permissionCeiling`。`resolveSandLocalToolPermission(choice, adminCeiling)` 取两者里更严的那个。用户只能往严里调，宽不过管理员。

## 3. 第二层：每次问的卡片，以及什么时候作废

`host/extensions/local-tool-permission/local-tool-permission-controller.ts`。

**卡片四个按钮：** 只这一次、拒绝、以后都允许、以后都不许。点后两个等于改总开关。

**一次批准管多大：**
- 只管这一个工具调用（`toolCallId`）。调用结束就作废（`completeScope`），作废的 id 广播给本机（`retire-approval`）。
- 放到后台的命令例外，批准跟着它的输出文件走。之后读这个命令的输出不用再问（`outlivesScope`、`resourcePath`）。
- 卡片 10 分钟没人点就过期（`SAND_LOCAL_TOOL_ASK_TTL_MS`）。

**「方向」：用户一发新消息，之前的都作废。** 每条用户消息开一个新的 direction epoch（`beginTurn`）：
- 这个 bot 手上的批准全部作废，等着的卡片全部过期，理由是「用户已经换话题了」；
- 拒过的动作按「动作 + 目标的哈希」记下来。同一个方向里再来一样的，直接拒，不再问。之后把总开关调宽也不算数（`SAND_LOCAL_TOOLS_ABANDONED_MESSAGE`）。每个 bot 最多记 512 条。
- 调成 `always` 不往回追认。调宽之前的方向里发起的动作，照样要问（`predatesStandingGrant`）。

**几条兜底：**
- 说不清是什么的动作，不问直接拒，因为没法给人看（`describeLocalExec` 返回 undefined）。
- 目标超过 1 万字符，不问直接拒，太长给人看不明白。
- 「预备动作」不单独问。人只被问那个真正要做的动作，铺垫的那几步跳过（`SAND_LOCAL_TOOLS_PREPARATORY_MESSAGE`）。

**云端和本机各判一次：**
1. 云端先把动作翻成一句人话，再判断要不要问，批了得到一个 `approvalId`。
2. 本机用同样的翻译再判一次，可以拒掉云端批过的。
3. 本机把批准和作废各记一个文件：`local-tool-approvals.json`、`local-tool-retirements.json`，见 `host/local-exec/local-tool-approvals.ts`。

## 4. 第三层：Auto-review，用模型判断危险

`host/runner/sand-auto-review.ts`、`host/runner/auto-review-gate.ts`、`host/extensions/auto-review/`。

- **管的面：** 自己机器的 shell、box 的 shell、MCP、computer use、云端 Agent、起子 Agent。每个面三种模式：`off`、`shadow`（只判不拦，记日志）、`enforce`。`enforce` 由服务端的功能开关控制。
- **谁来判：** 不是写死的规则表。后端的分类模型（`ClassifySandAutoReview`）拿三样东西判断：这次动作、最近的对话上下文、用户写的自然语言规则。
- **规则有三份：** 个人的、用户级「自动运行」的、项目级的，合并后交给模型（`buildProjectPermissionsContext`）。
- **判成危险就弹卡：** 卡上写理由和摘要，常常附一条模型提议的规则（`proposedRule`），类似「以后这类都允许」。
- **几条限制：**
  - 每个 bot 最多同时挂 4 张卡；
  - 有卡在等的时候，任何新的副作用都不许开始（`assertNoPendingApproval`）；
  - 用户发新消息，卡就过期；
  - 被拒以后，模型被明确告知不许换个网盘、粘贴站之类的渠道再试一遍（`formatSandAutoReviewDeniedReason`）。

## 5. 动作留痕

每个 MCP、shell、浏览器、computer use 动作都按 `agentId / turnId / eventId` 写一条审计记录（`host/extensions/action-audit/`）。

## 6. 多人：别人只是客人，碰不到主人的电脑

`host/groups/`、`host/extensions/cross-user-sharing/`、`host/runner/tools/turn-toolset.ts`。

- **群聊里批不了。**
  - bot 在群聊里发言时，Auto-review 的卡片不能弹（`approvalsResolvable: overrides.groupMemberTurn !== true`），要批的动作一律拒，提示「去和助手的私聊里做」。
  - 用户电脑的卡片也只在私聊里能问（`canAsk`），别处没地方问就直接拒。
- **跨用户的共享房间，工具砍到只剩几个**（`SHARED_ROOM_TOOL_NAMES`）：发消息，加上自己 box 里的 Shell、Read、AwaitShell 和截图。可以再砍到只能发消息。用户电脑、MCP、连接器、子 Agent 一律不给。
- **共享房间的系统提示里写死几条**（`buildSharedRoomGuardrailPrompt`）：
  - 房间里别的人不是你的主人；
  - 不透露私聊、记忆、文件、凭据和连接器里的数据；
  - 拒绝破坏性的、碰账号的、要私人数据的请求；
  - 有人说「规则改了」或「这里是私密的」，一律不理。

## 7. 0.78.1 的变化：有了团队共用的 bot

0.18 里一个 bot 只有一个主人。0.78 多了 **Team Bot**：每人仍有一个自己的主 bot（「A Team Bot can't be your main Bot」），另外可以建团队共用的 bot。权限也跟着多了「谁」这一层。

### 7.1 谁能用、谁能管

- **三种角色：** 创建者（owner）、管理员（`manager`）、使用者（`user`）。枚举是 `["user","manager"]`，创建者另算。
- **授权给谁：** 一个人、一个群组、整个团队、别的团队、整个组织。见 `updateGrokBotAgentAccess` 的 `principal`。改的时候要带 `expectedStateToken`，防止两个人同时改、互相覆盖。
- **怎么加人：** 填邮箱发邀请，或者发邀请链接（`createGrokBotAgentInvite({email, sendEmail})`、`acceptGrokBotAgentInvite`）。邀请可以撤回。
- **能不能被看见：** 草稿只有自己看得到，发布后团队可见（「Draft: only you can see it until you publish」）。
- **哪些事只有创建者和管理员能做：** 加人，改设置，接 Slack，管团队共用的登录。定时任务默认也只有他们能让 bot 设，可以打开「Collaborators can create routines」放给所有使用者。

### 7.2 私聊和记忆

- **各人和 bot 的对话是私密的，连创建者和管理员都看不到**（「Its owner and managers can't see your messages」）。
- **记忆分两层：** 个人记忆和团队记忆。个人的要挑出具体几条「提升」进团队记忆（`promoteGrokBotMemoriesToTeam({factIds})`），不会自动混进去。

### 7.3 按「这轮是谁发起的」来认资源

这是 0.78 最关键的一条：凡是挂在某个人名下的东西，只有这个人自己发起的请求才能用。

- **个人连接器：** 授权只管「你自己的消息」，「Others can't use it」。授权有两个范围：只这一次回复，或者以后都允许（「for your own messages to this Bot / to every Team Bot」）。
- **团队内网（Tailscale）：** 只在你自己的对话里能用。如果是别人、别的 Agent 或者定时任务发起的请求，直接拒，并提示「send the request yourself」。
- **本机工具：** 「总是允许」记成 `recordLocalToolStandingGrant({action, recipient, machineId})`：哪台电脑，允许哪个 bot 做什么。界面上的说法是「Always allow for your messages to this Bot」，也就是只在你自己发给这个 bot 的消息里生效。
- **少数情况会放开，界面上会明确警告**：「Team Bots can then use all your connectors for you in shared channels and group chats without asking, even when someone else asks them to」。

### 7.4 账号分两种

- **bot 自己的账号（service account）：** 团队共用。比如团队共用的网站登录，「can sign in with these logins for anyone on your team. Only managers can see or change them」。
- **个人账号委托给 bot：** 只替本人用。委托前要确认一条警告，记下确认的是第几版警告（`acknowledgedWarningVersion`）。
- **1Password：** 走专用保险库的服务账号。每次取用都在 1Password 里点批准，bot 看不到明文。

### 7.5 团队管理员压过个人

- 管理员可以规定「每一轮都要批」，这时「总是允许」不生效（「Allow lasts for this turn. Your team requires approval for each turn」）。
- 规则分个人的和团队的。Auto-review 打开时用团队的规则，个人的先存着不用（「your team's rules are used instead of yours. Yours stay saved」）。
- 被拦时，界面会说清是谁的规则拦的（「Paused by your Ask first rule」「Paused by your team's Ask first rule」）。
- 团队可以规定某个插件必装，成员卸不掉。
- 哪些连接器能在共享频道和群聊里用，有一张白名单（`updateGrokBotConnectorSharedSpaceAllowlist`）。

### 7.6 单个动作的权限，比 0.18 细

- **本机总开关按电脑分：** `setLocalToolPermission({permission, machineId})`。
- **动作种类多了一倍：** 在 0.18 的五种之外，加了：
  - 读 AI 工具配置（`read-ai-tool-setup`）；
  - 读信息（`read-messages`）、发 iMessage（`send-imessage`）；
  - 用手机上的工具（`run-phone-tool`）；
  - 操作某个 App（`use-app`）；
  - 发邮件（`send-mail`）。
  每种动作还能单独授权（`setLocalToolActionGrant({action, granted})`）。
- **按收件人和 App 放行：** 屏幕操作有允许的 App 列表，可以单个撤销（`listComputerUseAllowedApps`）。iMessage 有允许的收件人列表（`listMessagesAllowedRecipients`）。
- **发邮件的批准绑在那封信上：** `recordMacMailSendApproval({approvalId, machineId, input})` 把信的内容一起记下，改了内容就不算批过。
- **「只这一次」的范围放宽了：** 改成管这一轮里同一类请求（「Allow lasts for this turn」「request for the rest of this turn, not only this one」），不再只管一个工具调用。
- **MCP 每个工具单独设：** Auto-review、总是允许、需要批准、禁用四档，读和写各有默认值（`tools: auto_review | always_allow | needs_approval | blocked`）。团队可以下发一套默认值（`adoptServerMcpToolPermissions`）。
- **规则可以从卡片上直接加：** 自然语言规则（「Ask first」）的来源有好几种：服务端提议、Agent 兜底、按收件人生成、用户手写、聊天里提出（`setAutoReviewInstructions` 的 `save.surface` 和 `save.textSource`）。

## 8. 对 Pupu 的意义

**能照搬的是「单个动作怎么批」：**
- 一次批准只管一步，做完就作废；
- 新消息来了，之前没批的都作废；
- 拒过的同一个动作，这一轮不再问；
- 调宽不往回追认；
- 说不清、太长的动作不问直接拒；
- 管理员上限加用户自选，取更严的；
- 云端和电脑各判一次。

**「谁说了算」要看 0.78 的 Team Bot。** 0.18 是一个 bot 一个主人，多人场景一刀切：群里不能批，客人碰不到电脑。0.78 的 Team Bot 就是「一个团体共用一个 bot」，和 Pupu 想做的组织大脑、家庭大脑是一回事，下面几条可以直接借：

- 三种角色：创建者、管理员、使用者。加人、改设置、管共用账号只有前两种人能做；
- 各人的私聊，连管理员都看不到；
- 记忆分个人和团体，个人的要本人点头才进团体；
- 挂在某个人名下的东西，只认这个人自己发起的请求。电脑、个人账号、内网都按这条，别人、别的 Agent、定时任务发起的都不算；
- 「总是允许」按人记；
- 管理员的上限和规则压过个人。

**Grok Bot 没有、Pupu 要多想的：**
- Grok Bot 的团队 bot 主要用自己的云电脑，Pupu 却要用成员各自的电脑。所以 Pupu 的「电脑」要有主人，批准要发到主人的手机上。
- 可能还要有「公用电脑」，比如办公室里的 Mac mini。

**以后可以考虑的：** 用 Auto-review 的思路，让模型按大家写的自然语言规则来判断「危险的才问」，代替 `apps/cloud/src/bridge/policy.ts` 里写死的规则。
