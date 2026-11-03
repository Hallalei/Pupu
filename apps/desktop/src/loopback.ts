import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * 用 Google 登录时接回调：Google 不让在 App 里的网页登录，所以在系统浏览器里登，
 * 登完 Pupu 把一次性的码送到本机 127.0.0.1 上临时开的端口（RFC 8252 的 loopback 写法）。
 *
 * 只在 127.0.0.1 上听，端口由系统挑，拿到一次回调就关。码要配上 App 自己留着的 verifier 才换得到凭据，
 * 本机别的程序往这个端口塞假码也没用。写法对照了 VS Code github-authentication 的
 * LoopbackAuthServer（listen(0, "127.0.0.1")、拿到结果后跳一个本地页面），代码是自己写的。
 */

/** 和 apps/cloud/src/auth/sign-ins.ts 的 DESKTOP_PATH 一样。 */
export const CALLBACK_PATH = "/pupu-auth";
/** 浏览器那边最多等这么久。 */
export const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/** 32 字节随机数，base64url，43 个字符。 */
export function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE 的 S256。 */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** 登录取消或失败，带给人看的原因。 */
export class SignInCancelled extends Error {}

/** 回调地址上带的东西：成功有 code，失败有 error。都没有返回 null。 */
export function parseCallback(url: URL): { code: string } | { error: string } | null {
  const error = url.searchParams.get("error");
  if (error) return { error };
  const code = url.searchParams.get("code");
  return code ? { code } : null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** 浏览器里最后看到的那一页。 */
function resultPage(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Pupu</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#6f8fb3;color:#1c2634}
main{background:rgba(255,255,255,.9);border-radius:24px;padding:24px;max-width:22rem;margin:16px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:rgba(28,38,52,.62)}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}

/**
 * 开一个临时端口，调 `open(port)` 去打开浏览器，等回调带回 code。
 * 回调带 error、超时或者 `signal` 取消时抛 `SignInCancelled`。
 */
export function receiveCode(
  open: (port: number) => Promise<void>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const result = url.pathname === CALLBACK_PATH ? parseCallback(url) : null;
      if (!result || settled) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const ok = "code" in result;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        connection: "close"
      });
      response.end(
        ok
          ? resultPage("登录好了", "回到 Pupu 就能用了。这个页面可以关掉。")
          : resultPage("没连上 Pupu", result.error)
      );
      finish(() => (ok ? resolve(result.code) : reject(new SignInCancelled(result.error))));
    });
    const timer = setTimeout(
      () => finish(() => reject(new SignInCancelled("浏览器里的登录太久没完成，再点一次「用 Google 登录」。"))),
      options.timeoutMs ?? CALLBACK_TIMEOUT_MS
    );
    const onAbort = () => finish(() => reject(new SignInCancelled("已取消。")));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    function finish(done: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // 不再接新连接；回浏览器的那一页带了 connection: close，发完连接就断。
      server.close();
      done();
    }

    server.on("error", (error) => finish(() => reject(error)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        finish(() => reject(new Error("本机端口没开起来。")));
        return;
      }
      open(address.port).catch((error: unknown) => finish(() => reject(error)));
    });
    if (options.signal?.aborted) onAbort();
  });
}
