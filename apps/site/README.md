# Pupu 官网

Astro 出静态页，单独一个 Worker 托管，和 `apps/cloud` 分开部署。改官网不碰 Pupu 云端。

主线是「Context, Not Control」。写文案时只写已经上线的功能。

## 本地看

```bash
npm install
npm run preview
```

打开 http://localhost:4330 。`preview` 先构建，再用 `wrangler dev` 跑，申请内测会写进本地数据库。只改页面时用 `npm run dev` 更快，但没有 `/api/waitlist`。

## 检查

```bash
npm run check
npm test
```

## 文件

- `src/pages/index.astro`：首页八段，演示里的人名、电脑名和项目都是虚构的。
- `src/styles/tokens.css`：取自「Pupu 设计规范」的颜色和圆角，名字不改。
- `src/scripts/site.ts`：入场、演示播放、审批卡、表单。没有 JS 时内容照常显示，减弱动效时不播放。
- `src/components/Cat.astro`：像素小猫，网格抄自 `design/icon/pixels.py`。
- `worker/`：`/api/waitlist`，其余请求交给静态资源。

## 上线前要做

1. 确认「消息显示是谁发的」已经部署。首页的多人演示依赖它。
2. 配公开的联系邮箱 `PUBLIC_CONTACT_EMAIL`，隐私说明里才会出现删除邮箱的办法。
3. 确认 `wrangler.jsonc` 里的 Worker 名和 D1 数据库，再跑 `npm run deploy`。

## 看申请名单

```bash
npx wrangler d1 execute pupu-site --remote --command "SELECT email, created_at FROM waitlist ORDER BY created_at"
```
