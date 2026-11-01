import { net } from "electron";
import type { Credential } from "./credentials.ts";

/**
 * 配对：用户给一个配对码，换出两份凭据。
 * 1. 码换窗口的 `desktop` 设备凭据；
 * 2. 窗口凭据再要一个新码（和设置里「生成配对码」同一个接口），换桥的 `computer` 凭据。
 * 码用一次就作废，所以要第二个。走的都是现有接口，云端只多认一种 `desktop`。
 */

type PairBody = { id?: string; name?: string; token?: string; error?: string };

async function call<T>(origin: string, pathname: string, body: unknown, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await net.fetch(new URL(pathname, origin).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error(`连不上 ${new URL(origin).host}，看看网络。`);
  }
  const value = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !value) {
    if (value?.error) throw new Error(value.error);
    throw new Error(
      response.status >= 500 ? `Pupu 那边出错了（${response.status}），再试一次。` : `配对失败：${response.status}`
    );
  }
  return value;
}

function credentialOf(body: PairBody): Credential {
  if (!body.id || !body.name || !body.token) throw new Error("云端返回的凭据不完整。");
  return { id: body.id, name: body.name, token: body.token };
}

/** 配对码换窗口的凭据。本机开发服务器没设访问口令时，可以不填码。 */
export async function pairDesktop(origin: string, code: string, name: string): Promise<Credential> {
  return credentialOf(
    await call<PairBody>(origin, "/api/pair", { kind: "desktop", name, ...(code ? { code } : {}) })
  );
}

/** 用窗口的凭据给这台电脑的桥换一份凭据。 */
export async function pairComputer(origin: string, desktopToken: string, name: string): Promise<Credential> {
  const { code } = await call<{ code?: string }>(origin, "/api/pairing-codes", {}, desktopToken);
  if (!code) throw new Error("云端没给配对码。");
  return credentialOf(await call<PairBody>(origin, "/api/pair", { kind: "computer", name, code }));
}

/** 窗口的凭据还能不能用。连不上不算失效。 */
export async function desktopStatus(origin: string, token: string): Promise<"ok" | "revoked" | "unknown"> {
  try {
    const response = await net.fetch(new URL("/api/state", origin).toString(), {
      headers: { authorization: `Bearer ${token}` }
    });
    if (response.status === 401) return "revoked";
    return response.ok ? "ok" : "unknown";
  } catch {
    return "unknown";
  }
}
