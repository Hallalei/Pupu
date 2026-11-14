# 空间

协作版：侧栏（窄屏 ≡）是「我的 Pupu」加空间列表。成员建私有空间（L3），主人能邀请、移出、改「谁看得到」。协调模式的空间里，主会话派出去的事是任务卡，点进子会话。

## Sub-features

- `space.create`：「新空间」填名字，建出来 level 是 L3，成员只有自己。没登录时退回老的全组织项目。
- `space.invite`：空间胶囊上的「邀请」（只有主人有）打开邀请框：搜索「组织里的人」，邀请、移出；「谁看得到」三选一（只有成员 L3、全组织 L2、机密 L4）。
- `space.member-view`：不是主人的成员点胶囊上的头像，只看到成员名单。
- `space.pupu`：「我的 Pupu」打开自己的私聊。
- `space.task-card`：协调模式主会话里 delegate 显示成任务卡，状态点和「正在做 / 等你批准 / 做完了 · 结果」。
- `space.child`：宽屏在右侧 420 宽面板打开子会话，窄屏整页，左上返回；第一条显示「从「空间名」派来」，输入框「接着说这件事」。
- `space.access`：被移出或空间收窄，开着的会话连接被 4004 断开，列表里不再有它。

## 要几个成员

本机要假 Google（见 chat.md 的 `chat.sender`）。`/api/members` 不带凭据能邀请（本机开发）。登录用 `/api/auth/google/start?client=browser`，假 Google 的选账号页 `/auth` 带 `email=` 参数可以登任意邮箱。

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
