# Pupu 云端（v0）

Pupu 的云端部分：一个 Cloudflare Durable Object，里面跑 pi-durable；还有一个网页，分「聊天」「项目」两屏，交互参考 Hark，界面用 HeroUI v3。

电脑桥让 Pupu 在你授权的电脑上跑命令、读写主目录里的文件。电脑主动连出云端，本机不听端口。一台电脑一份设备凭据，和网页访问口令分开，可以单独吊销。

## 结构

| 文件 | 内容 |
|---|---|
| `src/server.ts` | `Pupu` Durable Object，以及 Worker 的路由、鉴权和 REST API |
| `src/prompt.ts` | 聊天和项目会话的系统提示词。聊天里会附上项目的实时状态 |
| `src/tools.ts` | Pupu 能用的项目工具：`list_projects`、`create_project`（用户在聊天里答应后才建）、`hand_off_to_project`（把事交给已有项目去做） |
| `src/auth/` | 用 Google 登录：OIDC 授权码流程和 ID token 校验（`oidc.ts`）、Worker 上的登录接口（`routes.ts`）、App 换凭据和新手机等批（`sign-ins.ts`） |
| `src/members.ts` `src/devices.ts` | 创建者和成员，手机、浏览器和电脑 App 的设备凭据（每台属于一个人），配对码，以及谁能批、谁能放宽、谁能邀请和吊销的几条规则 |
| `src/bridge/` | 电脑桥的协议、在线状态、设备凭据、给模型的工具，以及风险判定（`policy.ts`）和审批（`gate.ts`） |
| `bridge/` | 跑在电脑上的桥。电脑 App（`apps/desktop/`）托管它；也能单独跑，由 launchd 拉起，菜单栏图标（`menubar.swift`）是它的子进程。常驻那一圈在 `run.ts`，两边共用 |
| `src/messages.ts` | 两种特殊的用户消息：聊天转交给项目的消息、引用回复 |
| `src/projects.ts` | 项目等元数据的存储，放在 DO 的 SQLite 里，表名前缀 `pupu_` |
| `src/sockets.ts` `protocol.ts` `view.ts` `transcript.ts` | 把 pi 会话放到 WebSocket 上，并把事件折叠成界面状态。改编自 Cloudflare 官方的 pi 示例 |
| `src/client/` | React 网页 |

会话的组织方式：
- 聊天（主对话）是 pi 的根会话 `"1"`；
- 每个项目通过 `harness.sessions.create()` 单独开一个 pi 会话；
- 这些会话都在同一个 DO 里。

模型用的是 DeepSeek 官方接口的 `deepseek-flash`（V4.1 Flash）：支持工具调用，也能看电脑桥的截图。费用从 DeepSeek 开放平台的充值余额里扣。要换模型，改 `src/server.ts` 里的 `MODEL`，已有会话会在 DO 重启时自动切过去。

## 本地运行

```bash
npm install
npm run dev
```

然后打开 http://localhost:5173 。

需要先在 `apps/cloud/.dev.vars` 里写一行 `DEEPSEEK_API_KEY=<你的 key>`，本地发消息也会从 DeepSeek 余额里扣钱。这个文件不进 git。

本地数据存在 `.wrangler/state/`，删掉这个目录就能从头开始。

### 本地测 Google 登录

不用真去 Google 建客户端：`dev/fake-google.mjs` 是一个假的 Google，在 `localhost:9999` 上给一个选账号的页面。`.dev.vars` 里加上：

```
GOOGLE_CLIENT_ID=fake-client.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=fake-secret
CREATOR_EMAIL=owner@example.com
GOOGLE_OIDC_DEV_BASE=http://localhost:9999
```

然后 `node dev/fake-google.mjs`，再 `npm run dev`。选账号页上 owner（林夏）是创建者，family（阿周）要创建者在手机 App 里邀请了才能登录，stranger 不在名单上。`GOOGLE_OIDC_DEV_BASE` 只在本机的请求上认，线上设了也不用。

## 电脑桥

在要授权的电脑上配对，然后让桥常驻：

```bash
npm run bridge -- pair --url https://<你的 Pupu> --code <配对码>
npm run bridge -- start
```

配对码在网页或 App 的设置里生成（「连接新设备」），10 分钟内有效，用一次就作废。连本机的开发服务器（`http://localhost:5173`）可以不带配对码；手边一台连上的设备都没有时，用 `--token <访问口令>` 代替。名字默认是主机名，`--name` 可以改。设备凭据写在 `~/.pupu/bridge.json`，明文只在配对时出现一次。

开机自启是 `npm run bridge -- install`，卸下是 `uninstall`。`revoke` 拿这台电脑自己的凭据吊销它，配置文件还在。`status` 看当前配对。

点右上角「我」打开设置，「电脑」里列出授权的电脑和在线状态，可以看这台电脑能做什么，也可以吊销它。桥没开时 Pupu 照常聊天，并说明电脑没连上。

这一版能跑命令、读写主目录里的文件、列目录，也能截主屏幕并用图上的坐标点、拖、滚动和打字。还没有推送和远程桌面。

### 审批

每台电脑在设置里选一个分级：「高风险的才问」（默认）、「每一步都问」、「都放行」。要问的动作会在网页每一屏的顶部弹出卡片，点允许或拒绝；10 分钟没人处理就作废。

- 「允许」只认这台电脑主人的手机 App，推送和灵动岛也只发到主人的手机上；拒绝哪儿都能点。电脑 App 和浏览器的窗口就开在 Pupu 能操作的电脑上，它能自己点，所以不认。规则在 `src/devices.ts` 的 `mayDecide`。
- 分级往宽里改（比如改成「都放行」）也只认这台电脑主人的手机 App，别处那几项是灰的，接口回 403；往严里改哪儿都行。规则在 `mayChangePolicy`。
- 还没主人的电脑（还没有创建者时连上的）谁的手机都能批、能放宽，和以前一个人用的时候一样。
- 高风险怎么算，在 `src/bridge/policy.ts`：删除、提权、`git push`、发布、部署、改系统设置、碰凭据之类。规则参考了 Cindy 的 auto-review（Apache-2.0）。
- 屏幕按电脑批一次授权，15 分钟没有屏幕操作就失效。会发消息、付款、提交的那一步，模型标上 `sensitive`，单独再问。
- 等批准挂在 pi 的 `beforeTool` 上，请示存在 `pupu_approvals` 表里，按工具调用 id 唯一。DO 被回收后 pi 重跑这次调用，会接着等同一条。

### 菜单栏图标

桥启动后在菜单栏放一个图标，显示没连上、空闲、在跑命令、操作屏幕、等批准五种状态。菜单里能收回屏幕控制、停掉在跑的命令，还有两个本机开关：「允许跑命令和写文件」「允许操作屏幕」，存在 `~/.pupu/local.json`。

本机开关关掉的，云端批准了也不做。高风险动作和屏幕操作，桥只认云端说批过的（exec 帧里的 `approved`）。

图标第一次启动时用 `swiftc` 在本机编译，需要 Xcode 命令行工具。不想要图标，启动桥时设 `PUPU_MENUBAR=0`。

## 部署

```bash
npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put CREATOR_EMAIL
npm run deploy
```

访问口令不设的话，没开 Google 登录时谁都连不上（本机开发除外）。DeepSeek 开放平台的 API key 没有，Pupu 回不了话。后面三个开 Google 登录，见下一节；不设就只能用访问口令和配对码。

### 用 Google 登录

一个团体（一家人、一个组织）共用一个 Pupu，每人用自己的 Google 账号登录。手机 App、电脑 App 和浏览器的登录页上都是「用 Google 登录」：

- 浏览器：跳到 Google，登完回来就连上了，凭据放在 HttpOnly cookie 里。
- 手机 App：用系统的登录页（`ASWebAuthenticationSession`），登完跳回 `pupu://auth`。
- 电脑 App：在系统浏览器里登，Pupu 把一次性的码送回 App 临时开的 `127.0.0.1` 端口；窗口和这台电脑的凭据一次拿齐。

Google 不让在 App 内嵌的网页里登录，所以 App 都不在自己的网页里登。App 那一段另带 PKCE：码被别的 App 截走也换不出凭据。

角色只有两种（需求说明 4.7）：

- 创建者：`CREATOR_EMAIL` 里的那个人。他第一次登录时成为创建者，之前连上的设备和电脑（配对码、访问口令连的）都归他。之后改这个 secret 不会换创建者。
- 成员：创建者在手机 App 的设置 →「成员」里邀请，填对方的 Google 邮箱，对方用这个账号登录就放行。邀请只能在创建者的手机上做：加一个人等于放宽权限，理由和「允许只认手机」一样。移除哪儿都能做，被移除的人名下的设备和电脑马上断开。

登录换来的设备凭据挂在那个人下面；用谁的账号登录电脑 App，那台电脑就是谁的。设置里的设备和电脑都写着是谁的。自己名下的自己能吊销，创建者能吊销所有人的。

新手机：这个 Pupu 连过手机（吊销了也算）以后，用 Google 登录的新手机要一台已经连上的手机点「允许」才发凭据，锁屏通知和 App 顶上的卡片都能点，10 分钟没点就作废。这条按整个 Pupu 算，不按人算：不然一个还没有手机的成员，他电脑上的浏览器 Pupu 拿得到，能替他配一台「手机」再批准自己。所以新成员的第一台手机，也要随便哪台已经连上的手机点一下。

Google Cloud 那边：建一个「Web 应用」类型的 OAuth 客户端，「已获授权的重定向 URI」填 `https://<你的 Pupu>/api/auth/google/callback`，范围只要 `openid` 和 `email`。客户端 ID 和密钥用上面的 `wrangler secret put` 写进去。应用要「发布」成正式版，不然只有 Google 那边列出的测试用户能登录；发布前品牌页要填首页和隐私权政策网址，隐私页是 `public/privacy.html`（网址 `/privacy`）。只要这两个范围、不传徽标，发布不用 Google 审核，拦人靠 Pupu 自己的成员名单。

配对码和访问口令还在，当后备：在已经连上的设备上打开设置 →「连接新设备」，手机用相机扫二维码，或者在 App 的连接页填码。配对码换出来的设备和电脑，归生成码的那台设备的主人；访问口令换的算创建者的。设置里列着所有连上的设备，每台都能单独吊销，吊销后它开着的连接马上断开。

ID token 的校验步骤对照了 [panva/oauth4webapi](https://github.com/panva/oauth4webapi)，state 放 cookie 和 Google 的参数对照了 [pilcrowonpaper/arctic](https://github.com/pilcrowonpaper/arctic)，都是看思路自己写的。

### 让新账号自己开 Pupu

`wrangler.jsonc` 的 `PUPU_SEATS` 是名额，`0` 是不开放，这时和只有一个 Pupu 时一样。改成 `20` 再部署，不在成员名单上的 Google 账号第一次登录时就开一个自己的 Pupu，满了就被拒。`PUPU_DAILY_USD` 是每个 Pupu 每天的模型费用上限，美元，到了当天不再接新消息。

新账号登录 Google 后要填邀请码才开 Pupu。第一个 Pupu 的创建者在网页设置里生成和作废，没用掉的码也占名额。被邀请进别人 Pupu 的成员不用码。

每个 Pupu 是一个 Durable Object。设备凭据和登录码带着 Pupu 的 id 当前缀，Worker 看前缀分流；客户端一直连 `/agents/pupu/me`，Worker 换成它自己的那个，所以 App 不用改。第一个 Pupu 还叫 `me`，老凭据没有前缀，成员不占名额，也不限额。哪个账号住哪由 `Directory` 这个 Durable Object 记，规则在 `src/directory.ts`。

访问口令只在配对时认，是手边没有连上的设备时的救急钥匙。配对失败按来源（IPv4 一个地址，IPv6 一个 /56）计数，10 分钟内错 10 次，这个来源先停 10 分钟；访问口令另记一桶，不管从哪儿来，10 分钟内一共错 20 次就先停。换口令用 `wrangler secret put ACCESS_TOKEN`，已经配对的设备不受影响。

## 许可证

`src/sockets.ts`、`protocol.ts`、`view.ts`、`transcript.ts` 和 `src/client/use-pi-session.ts` 改编自 [cloudflare/agents](https://github.com/cloudflare/agents) 的 `examples/next/harnesses/pi`（MIT 协议）。pi 本身也是 MIT 协议。两份许可证原文都在 `licenses/` 下。
