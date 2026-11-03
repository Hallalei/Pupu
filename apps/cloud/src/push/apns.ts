/**
 * 直接请求 APNs（苹果的推送服务）。
 *
 * 部署后的 Worker 用 fetch 就能和 APNs 说上 HTTP/2；本地 `wrangler dev` 的 fetch 只走 HTTP/1.1，
 * 会报 Network connection lost，所以推送只能在部署后的环境里测（2026-11-02 实测）。
 *
 * 认证用 token：.p8 私钥在 WebCrypto 里签 ES256 JWT。APNs 要求 20 到 60 分钟换一次，换得太勤会回
 * 429 TooManyProviderTokenUpdates，所以签好的 JWT 存进 SQLite，DO 重启后接着用，满 50 分钟才换。
 * 写法对照了 frink 的 live-activity-forwarder 和 plannotator 的 relay（思路相同，代码是自己写的）。
 */

export type ApnsEnv = "sandbox" | "production";

export const APNS_HOSTS: Readonly<Record<ApnsEnv, string>> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com"
};

/** App 的 bundle id，也是通知的 topic。实时活动的 topic 是它后面加 `.push-type.liveactivity`。 */
export const APNS_TOPIC = "com.leizi.pupu";

/** 签好的 JWT 用这么久就换。 */
export const PROVIDER_TOKEN_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** 这些原因说明这个 token 以后都用不了，删掉。410 也是。 */
const GONE_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"]);

export type ApnsKey = {
  /** .p8 文件的全文。 */
  readonly key: string;
  readonly keyId: string;
  readonly teamId: string;
};

export type ApnsPush = {
  readonly token: string;
  readonly env: ApnsEnv;
  readonly type: "alert" | "liveactivity";
  /** 10 马上投；5 由系统挑省电的时候投。 */
  readonly priority: 5 | 10;
  readonly payload: unknown;
  /** 同一个 collapse id 的新通知替换旧的。手机上它也是这条通知的 identifier。 */
  readonly collapseId?: string;
  /** 秒级时间戳。过了这个时间 APNs 就不再投。 */
  readonly expiration?: number;
};

export type ApnsResult = {
  /** 0 是没连上 APNs。 */
  readonly status: number;
  readonly reason: string | null;
  /** 这个 token 以后都用不了。 */
  readonly gone: boolean;
};

export type ApnsOptions = {
  readonly key: ApnsKey;
  /** 签好的 JWT 存在哪。DO 里是 pupu_meta。 */
  readonly cache: { get(): string | undefined; set(value: string): void };
  readonly now: () => number;
  readonly fetch?: typeof fetch;
};

type Cached = { readonly kid: string; readonly iss: string; readonly iat: number; readonly jwt: string };

/** 部署时设的三个 secret 都在才发推送。 */
export function apnsKeyFrom(env: {
  readonly APNS_KEY?: string;
  readonly APNS_KEY_ID?: string;
  readonly APNS_TEAM_ID?: string;
}): ApnsKey | null {
  const key = env.APNS_KEY?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  if (!key || !keyId || !teamId) return null;
  return { key, keyId, teamId };
}

export class Apns {
  readonly #options: ApnsOptions;
  /** 正在签的那一次。一批推送同时要 JWT 时只签一次。 */
  #signing: Promise<string> | null = null;

  constructor(options: ApnsOptions) {
    this.#options = options;
  }

  async send(push: ApnsPush): Promise<ApnsResult> {
    const first = await this.#post(push, await this.#providerToken(false));
    // 缓存里的 JWT 被 APNs 认为过期了（比如时钟有偏差），换一个再试一次。
    if (first.status === 403 && first.reason === "ExpiredProviderToken") {
      return this.#post(push, await this.#providerToken(true));
    }
    return first;
  }

  async #post(push: ApnsPush, jwt: string): Promise<ApnsResult> {
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      "apns-push-type": push.type,
      "apns-topic": push.type === "liveactivity" ? `${APNS_TOPIC}.push-type.liveactivity` : APNS_TOPIC,
      "apns-priority": String(push.priority),
      "content-type": "application/json"
    };
    if (push.collapseId) headers["apns-collapse-id"] = push.collapseId;
    if (push.expiration !== undefined) headers["apns-expiration"] = String(push.expiration);
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(`${APNS_HOSTS[push.env]}/3/device/${push.token}`, {
        method: "POST",
        headers,
        body: JSON.stringify(push.payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      return { status: 0, reason: error instanceof Error ? error.message : String(error), gone: false };
    }
    if (response.ok) return { status: response.status, reason: null, gone: false };
    let reason: string | null = null;
    try {
      const body = (await response.json()) as { reason?: unknown };
      if (typeof body.reason === "string") reason = body.reason;
    } catch {
      // 不是 JSON。
    }
    return { status: response.status, reason, gone: response.status === 410 || GONE_REASONS.has(reason ?? "") };
  }

  async #providerToken(renew: boolean): Promise<string> {
    const { key, cache, now } = this.#options;
    if (!renew) {
      const cached = readCached(cache.get());
      if (cached && cached.kid === key.keyId && cached.iss === key.teamId && now() - cached.iat * 1000 < PROVIDER_TOKEN_MS) {
        return cached.jwt;
      }
    }
    if (!this.#signing) {
      const iat = Math.floor(now() / 1000);
      this.#signing = signProviderToken(key, iat)
        .then((jwt) => {
          cache.set(JSON.stringify({ kid: key.keyId, iss: key.teamId, iat, jwt } satisfies Cached));
          return jwt;
        })
        .finally(() => {
          this.#signing = null;
        });
    }
    return this.#signing;
  }
}

function readCached(raw: string | undefined): Cached | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Cached>;
    if (typeof value.kid !== "string" || typeof value.iss !== "string") return null;
    if (typeof value.iat !== "number" || typeof value.jwt !== "string") return null;
    return value as Cached;
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * APNs 的 provider token：`{alg: ES256, kid}.{iss: 团队 id, iat}`，用 .p8 私钥签。
 * WebCrypto 的 ECDSA 签名就是 r‖s 各 32 字节，正是 JWS 的 ES256 要的格式，不用转 DER。
 * secret 里粘进来的字面 `\n` 也认。
 */
export async function signProviderToken(key: ApnsKey, iat: number): Promise<string> {
  const body = key.key.replace(/-----[^-]+-----|\\n|\s/g, "");
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  const signer = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: key.keyId })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: key.teamId, iat })));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signer,
    encoder.encode(`${header}.${claims}`)
  );
  return `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
}
