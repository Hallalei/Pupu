# 多组织：一个账号在好几个 Pupu 里

规则见 `docs/协作方案.md` 第 1、9 节：人人有自己的 Pupu，能被邀请进别人的；被邀请的新账号不自动开；移出只断那一个，个人入口锁起来，再邀请回来恢复。

## 前提

要多个 Pupu，所以要开名额和假 Google。`apps/cloud/.dev.vars` 写这几行（不含任何真 key，测完删掉）：

```
GOOGLE_CLIENT_ID=fake-client.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=fake-secret
CREATOR_EMAIL=owner@example.com
GOOGLE_OIDC_DEV_BASE=http://localhost:9998
PUPU_SEATS=5
```

假 Google 换个端口跑，别和别的验证抢 9999：`(cd apps/cloud && PORT=9998 node dev/fake-google.mjs)`。假 Google 的 `/auth` 带上 `email=任意地址` 就是那个账号。

## 服务端整条路径

```bash
BASE=http://localhost:5199 node $S/multi-org.mjs
```

要空数据。它走：林夏（第一个 Pupu 的创建者）发码 → bee 填码开自己的 → 林夏邀请已经有 Pupu 的 bee → bee 切过去、切回来不多发设备 → 林夏打不开 bee 的个人入口 → 移除 bee，bee 的请求自动回到自己的、切不回去、入口锁着 → 再邀请回来是同一条个人入口 → 没有 Pupu 的 cat 被邀请只进那一个，之后用码开自己的 → 手机切换拿码换凭据，那边已有手机就等允许。

## 界面

- 网页和电脑 App 窗口：设置第一页，头像下面一组列着各个 Pupu，当前的打勾，点一下切过去并重新载入。只有一个、又开不了自己的时候不显示。
- iOS：「我」第一页同样一组。切到没进过的 Pupu 时拿码换凭据，不等谁点允许（切换不加确认）。
- iOS 被移出：手机正在那个 Pupu 里时把它移出，5 秒轮询拿到 401 后换到存着的另一个 Pupu，主界面弹「你已经不在刚才那个 Pupu 里了。」。要用签了名的包，见 SKILL.md 的 iOS 一节。
- 一个 Pupu 配过手机后，网页生成的码配不了新手机（`mayPair`）。重来一遍就换空数据，别去吊销旧手机。
