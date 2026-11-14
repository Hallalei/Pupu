# 空间

协作版：宽屏左侧栏（窄屏切换 sheet）是「我的 Pupu」「资料」加空间列表。每个空间有颜色和像素图标，进了空间窗框染成它的颜色。成员建私有空间（L3），主人能邀请、移出、改「谁看得到」。协调模式的空间里，主会话派出去的事是任务卡，点进子会话。

## Sub-features

- `space.create`：「新空间」填名字，建出来 level 是 L3，成员只有自己。没登录时退回老的全组织项目。
- `space.invite`：空间设置（窄屏点顶栏右边的成员胶囊，宽屏点卡片头的「邀请」或成员头像）：标题行是大号标记加空间名；主人往下有颜色、图标、搜索「组织里的人」、成员（邀请、移出）、「谁看得到」三选一（只有成员 L3、全组织 L2、机密 L4）和「只派活」。
- `space.look`：主人在空间设置里点颜色或图标，马上换上：`html[data-frame]`、body 底色和 `meta[name=theme-color]` 换成新的窗框色，侧栏、顶栏、sheet 里的标记方块跟着换；`/api/state` 里这个空间的 `color`、`icon` 跟着变。
- `space.member-view`：不是主人的成员点成员胶囊，只看到成员名单，没有颜色、图标和范围。
- `space.pupu`：「我的 Pupu」打开自己的私聊。
- `space.everyone`：空间列表第一个是「全员」（楼图标，`#/projects/everyone`），就是原来的根会话 "1"，历史都在。输入栏「在「全员」里说」。创建者点顶栏（宽屏卡片头）的楼打开设置：颜色、图标和「只派活」；别人那里楼只是标识，点不开；`/api/state` 的 `everyone.mode` 跟着在 direct 和 coordinator 之间变，别人改返回 forbidden。
- `space.mode`：主人在邀请框里也有「只派活」开关（项目空间默认开）。
- `space.task-card`：协调模式主会话里 delegate 显示成任务卡，状态点和「正在做 / 等你批准 / 做完了 · 结果」。
- `space.child`：宽屏在主卡片右边开一张 400 宽的子会话卡（从右边滑进来，头一行名字和状态，右边关闭），窄屏整页，顶栏左边返回、中间名字和状态；第一条显示「从「空间名」派来」，输入框「接着说这件事」。
- `space.access`：被移出或空间收窄，开着的会话连接被 4004 断开，列表里不再有它。

## 要几个成员

本机要假 Google（见 chat.md 的 `chat.sender`）。创建者登录以后邀请要亲手确认：用 private-chat.md 里的手机凭据，或者在无头 Chrome 里挂虚拟认证器（CDP `WebAuthn.addVirtualAuthenticator`，`transport: internal`、resident key、`automaticPresenceSimulation`），页面里 `(await import('/src/client/passkey.ts')).confirm({ kind: 'invite', email }, state.passkeys)` 拿到 proof 再 `POST /api/members`。第二个成员用另一个浏览器配置目录登录。登录用 `/api/auth/google/start?client=browser`，假 Google 的选账号页 `/auth` 带 `email=` 参数可以登任意邮箱。

## 协调模式

主人 `POST /api/spaces/:id {"kind":"mode","mode":"coordinator"}`。假模型见 `.verify-evidence/20261114-collab-step1/seed.mjs` 和 step2 的说明。

## Gotchas

- 本机 vite 的 WebSocket 转发先接受连接：被拒的连接在客户端也是「打开」，要看有没有收到 hello；关闭帧要等约 30 秒才到。

## 第 4 步起

- 所有空间默认协调模式：新建的马上切；老空间在 DO 启动时切（`coordinator:<id>` 记在 pupu_meta，工具列表变了会重配，主人切回直接做的不动）。
- 主会话能用委派、list_projects、资料工具和 remember/forget，动电脑的都被 `mayCall` 拦下。
- 升级测法：`$S/old` 检出旧版本起服务、seed，停掉后用新代码起同一个数据目录，看 mode、记录、委派和回投。证据在 `.verify-evidence/20261114-collab-step4/`。

## 记忆（第 9.2 节）

- `memory.remember`：人说「记住……」，Pupu 调 remember，回复里一行「已记住：……」。个人层只在本人私聊，空间层只在本空间的会话，组织层在所有会话；L3、L4 的空间里不能记到组织层。
- `memory.load`：记忆接在每次请求最后一条用户消息末尾的 `[[pupu:memory]]…[[/pupu:memory]]` 里，不写进会话记录。假模型的请求日志里 `memory` 字段能看到。
