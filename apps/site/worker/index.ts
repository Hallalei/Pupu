import { handleWaitlist, type WaitlistEnv } from "./waitlist.ts";

interface Env extends WaitlistEnv {
  ASSETS: Fetcher;
}

const HOST = "getpupu.com";

/** http 和 www 都转到 https://getpupu.com，路径和参数不变。别的域名（workers.dev、本地）不管。 */
export function canonicalUrl(url: URL): string | null {
  if (url.hostname !== HOST && url.hostname !== `www.${HOST}`) return null;
  if (url.protocol === "https:" && url.hostname === HOST) return null;
  const target = new URL(url);
  target.protocol = "https:";
  target.hostname = HOST;
  target.port = "";
  return target.href;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    const target = canonicalUrl(url);
    // GET 用 301；POST 之类用 308，浏览器跟过去时不会把请求改成 GET。
    if (target) {
      const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
      return Response.redirect(target, status);
    }
    if (url.pathname === "/api/waitlist") return handleWaitlist(request, env);
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
