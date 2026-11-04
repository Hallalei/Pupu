import { handleWaitlist, type WaitlistEnv } from "./waitlist.ts";

interface Env extends WaitlistEnv {
  ASSETS: Fetcher;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/waitlist") return handleWaitlist(request, env);
    if (pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
