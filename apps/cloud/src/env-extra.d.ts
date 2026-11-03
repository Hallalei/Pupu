/** 不在 wrangler.jsonc 里的绑定：部署时用 `wrangler secret put <名字>` 设置，本地开发写进 `.dev.vars`。 */
interface Env {
  readonly ACCESS_TOKEN?: string;
  /** DeepSeek 开放平台的 API key，模型调用全靠它。 */
  readonly DEEPSEEK_API_KEY?: string;
  /** APNs 的 .p8 私钥全文。三个都设了才发推送。 */
  readonly APNS_KEY?: string;
  /** 这把 .p8 密钥的 Key ID，10 位。 */
  readonly APNS_KEY_ID?: string;
  /** 苹果开发者团队 ID，10 位。 */
  readonly APNS_TEAM_ID?: string;
}
