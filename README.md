# Pupu

Context, Not Control。组织大脑，让智能在组织间流动。

Pupu 是一个团体共用的云端 Agent。大家在手机、电脑和网页上和同一个 Pupu 聊天、开项目；它能在你授权的电脑上跑命令、读写文件、操作窗口和浏览器，高风险的动作要电脑主人亲手批准：手机上点，或者在浏览器里用通行密钥确认。

https://github.com/user-attachments/assets/15098287-b833-4787-a8b7-b26b98ae730a

官网：https://getpupu.com

## 仓库里有什么

| 目录 | 内容 |
|---|---|
| [apps/cloud](apps/cloud) | 云端：一个 Cloudflare Durable Object 加 React 网页；`bridge/` 是跑在电脑上的桥 |
| [apps/desktop](apps/desktop) | 电脑 App（Electron，macOS）：托管桥、托盘、窗口 |
| [apps/ios](apps/ios) | 手机 App（UIKit，iOS 26 以上）：聊天、项目、审批、灵动岛 |
| [apps/site](apps/site) | 官网（Astro），单独一个 Worker |
| [media/promo](media/promo) | 宣传片，代码渲染 |
| [design/icon](design/icon) | 图标的生成脚本和成品 |
| [docs](docs) | 需求说明和调研 |

## 跑起来

需要 Node 22.18 以上、一个 DeepSeek 开放平台的 API key。先起云端：

```bash
cd apps/cloud
npm install
echo "DEEPSEEK_API_KEY=<你的 key>" > .dev.vars
npm run dev
```

打开 http://localhost:5173 就能聊天。本机开发不用登录；Google 登录、电脑桥、审批怎么测，见 [apps/cloud/README.md](apps/cloud/README.md)。

电脑 App 连本机的云端：

```bash
cd apps/desktop
npm install
PUPU_URL=http://localhost:5173 npm run dev
```

手机 App 用 Xcode 打开 `apps/ios/Pupu.xcodeproj`，换成你自己的开发团队和 Bundle ID 再跑。

## 检查

```bash
node scripts/check.mjs                 # 三个 app 的类型检查和测试
git config core.hooksPath .githooks    # 推送前自动跑改到的那几个
```

## 部署自己的一份

云端和官网都部署在 Cloudflare Workers 上。`apps/cloud/wrangler.jsonc` 和 `apps/site/wrangler.jsonc` 里的域名、数据库 ID 是 getpupu.com 这一份的，部署前换成你自己的。要设哪些 secret，见 [apps/cloud/README.md](apps/cloud/README.md) 的「部署」一节。

## 许可

[MIT](LICENSE)。

仓库里带的别人的东西按各自的许可：

- `.claude/` 下的 pstack：MIT，见 [.claude/LICENSE](.claude/LICENSE)。
- `media/promo/fonts/` 的 Fusion Pixel 字体：SIL OFL 1.1，见 [OFL.txt](media/promo/fonts/OFL.txt)。
- 电脑桥的输入助手和风险判定参考了 Cindy（Apache-2.0），出处写在代码注释里。
