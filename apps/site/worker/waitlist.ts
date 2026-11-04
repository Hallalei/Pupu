/** 申请内测：只收邮箱，不记 IP。重复申请和新申请回一样的话，免得有人拿它试探谁申请过。 */

export interface WaitlistEnv {
  DB: Pick<D1Database, "prepare">;
  LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (status: number, body: object): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export async function handleWaitlist(request: Request, env: WaitlistEnv): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "只接受 POST" });

  const key = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(await env.LIMIT.limit({ key })).success) {
    return json(429, { error: "申请得太快了，过一分钟再试。" });
  }

  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    website?: unknown;
  } | null;
  if (!body) return json(400, { error: "没看懂这次提交，再试一次。" });

  // website 是给机器人留的空栏，人看不见。填了就当成功，不入库。
  if (body.website) return json(200, { ok: true });

  const email = normalizeEmail(body.email);
  if (!email) return json(400, { error: "这个邮箱地址不对，检查一下再发。" });

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, created_at TEXT NOT NULL)"
  ).run();
  await env.DB.prepare("INSERT OR IGNORE INTO waitlist (email, created_at) VALUES (?, ?)")
    .bind(email, new Date().toISOString())
    .run();

  return json(200, { ok: true });
}
