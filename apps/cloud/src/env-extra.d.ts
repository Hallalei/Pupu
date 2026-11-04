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
  /** Google Cloud 里「Web 应用」类型的 OAuth 客户端。三个都设了才开 Google 登录。 */
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  /** 创建者的 Google 邮箱。还没有创建者时，只有它能第一个登录、成为创建者，之后不再起作用。见 src/members.ts。 */
  readonly CREATOR_EMAIL?: string;
  /** 只在本机开发用：假的 Google（授权、换 token、公钥都在这个地址下），不用真去 Google 建客户端。线上不要设。 */
  readonly GOOGLE_OIDC_DEV_BASE?: string;
  /** 部署好的 open-connector 地址。和 CONNECTOR_TOKEN 都设了才开「账户」（连接器），见 src/connectors/client.ts。 */
  readonly CONNECTOR_URL?: string;
  /** open-connector 的 OOMOL_CONNECT_ADMIN_TOKEN。 */
  readonly CONNECTOR_TOKEN?: string;
}
