# 资料（Artifacts）

共享上下文第一版：组织层和空间里的文字资料、skill。侧栏「我的 Pupu」下面是「资料」（`#/docs`，窄屏在切换 sheet 里），按地方分组，点开读正文；「上传」贴正文或选 .md / .txt，选放在哪（组织或看得到的空间），可以标成 skill。Pupu 有 doc_list / doc_search / doc_read / doc_write / doc_promote 工具，skill 的名字和一句说明列在每个会话的提示词里。

## Sub-features

- `docs.list`：列表只有组织层和自己看得到的空间（成员，或全组织档）。别人的 L3、L4 不出现，`GET /api/docs/:id` 回 404。
- `docs.upload`：放到看不到的空间回 404，没标题或正文回 400；同一个 `operation` 重放不多写。
- `docs.tools`：私聊里搜得到本人在的 L3 的资料；不在的人搜不到。空间会话只存本空间；私聊不说存哪被拒；协调模式主会话只有三个只读工具。
- `docs.skills`：提示词里的 skill 列表只含这条会话读得到的。
- `docs.page`：页面（kind = page，一整页 HTML）。上传框贴进 `<!doctype html>` 开头的正文就存成页面；网页和电脑 App 放进 srcdoc 的沙箱 iframe（`PAGE_SANDBOX`，没有 allow-same-origin），iOS 放进不存数据、没有 baseURL 的 WKWebView。页面里拿不到 cookie、localStorage、`parent.document`、`pupuDesktop`，往 App 发的请求和 WebSocket 被拒；iOS 上页面脚本跳不走，人点外链才开 Safari。

## 怎么验

假模型按「查资料 X」调 doc_search → doc_read，按「存资料 X」调 doc_write，见 `.verify-evidence/20261114-collab-step3/docs-agent.mjs` 和改过的 mock（每次请求记下提供的工具和提示词里的 skill）。

## 测页面沙箱

本机没设 ACCESS_TOKEN 时，云端放行不带凭据的请求，探针里的 POST 和 WebSocket 会「漏」，那不是沙箱的问题。要测线上那样的行为：在 `apps/cloud/.dev.vars` 写一个随机的 `ACCESS_TOKEN`，网页用「用访问口令」登录拿到 cookie，再开探针页；测完删掉 `.dev.vars`。服务端那一侧用 curl 带 cookie 加 `Origin: null` 打 `/api/docs` 和 `/agents/...` 的升级，应该是 401 和拒绝升级。探针页和证据见 `.verify-evidence/20261114-artifacts`。

## Gotchas

- 浏览器的 cookie 按主机名不按端口：localhost 上别的验证实例种的 `pupu_token` 会带过来，页面一直停在配对页。并行验证时用 `PUPU_VERIFY_HOST=127.0.0.1 PUPU_VERIFY_PORT=<别的端口>` 起云端，删 cookie 只删 127.0.0.1 上那一条。

- 协调模式的工具列表是切换时写进会话的。切换早于某个工具上线的会话拿不到新工具，要重新切一次（第 4 步正式开时启动时补上）。
- 本机已有手机配对过的账号，浏览器新登录要手机批准；换个没手机的账号测，或者用新数据目录。
