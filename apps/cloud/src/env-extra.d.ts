/** 不在 wrangler.jsonc 里的绑定：部署时用 `wrangler secret put ACCESS_TOKEN` 设置。 */
interface Env {
  readonly ACCESS_TOKEN?: string;
}
