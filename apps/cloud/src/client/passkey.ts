import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type AuthenticationResponseJSON
} from "@simplewebauthn/browser";
import type { Purpose } from "../passkeys";
import type { PupuState } from "../server";
import { api } from "./api";

/**
 * 网页上的「亲手确认」：没有手机的人用通行密钥（指纹或电脑密码）确认允许、放宽权限、邀请。规则在云端 passkeys.ts。
 * 电脑 App 的窗口里没有通行密钥（Electron 默认不接系统的），要在浏览器里做，见 `confirmWhere`。
 */

export type Passkeys = NonNullable<PupuState["passkeys"]>;

/** 这台设备上怎么亲手确认：手机直接点；网页用通行密钥；电脑 App 交给浏览器；有手机的去手机上。 */
export type ConfirmWhere = "here" | "passkey" | "browser" | "phone";

export function confirmWhere(kind: "phone" | "browser" | "desktop" | null, passkeys: Passkeys | null): ConfirmWhere {
  if (kind === null || kind === "phone") return "here";
  if (!passkeys || passkeys.add === "has_phone") return "phone";
  if (kind === "desktop" || !browserSupportsWebAuthn()) return "browser";
  return "passkey";
}

/** 系统弹窗被关掉或者超时：人没确认，不算出错。 */
export class Cancelled extends Error {}

/**
 * 为这件事确认一次，返回给云端的结果。还没有通行密钥、又允许加第一把时，先加一把再确认。
 * 每一步都要人在系统弹窗里按指纹或输密码。
 */
export async function confirm(purpose: Purpose, passkeys: Passkeys): Promise<AuthenticationResponseJSON> {
  if (passkeys.keys.length === 0) await addPasskey(passkeys);
  return ask(async () => startAuthentication({ optionsJSON: await api.proofOptions(purpose) }));
}

/** 加一把通行密钥。已经有过的要先用旧的那把确认。 */
export async function addPasskey(passkeys: Passkeys): Promise<void> {
  const proof =
    passkeys.add === "needs_proof"
      ? await ask(async () => startAuthentication({ optionsJSON: await api.proofOptions({ kind: "add" }) }))
      : undefined;
  const response = await ask(async () => startRegistration({ optionsJSON: await api.passkeyOptions(proof) }));
  await api.addPasskey(response);
}

async function ask<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof WebAuthnError && cause.code === "ERROR_CEREMONY_ABORTED") throw new Cancelled("没确认");
    if (cause instanceof Error && cause.name === "NotAllowedError") throw new Cancelled("没确认");
    throw cause;
  }
}

/** 电脑 App 里点了「在浏览器里批准」：在系统浏览器里打开网页版，请示在那里也看得到。 */
export function openInBrowser(): void {
  window.open(`${location.origin}/`, "_blank", "noopener");
}
