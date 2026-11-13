import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalView } from "../bridge/approvals";
import type { ComputerPolicy } from "../bridge/policy";
import type { DeviceView } from "../devices";
import type { InviteList } from "../directory";
import type { Purpose } from "../passkeys";
import type { Project } from "../projects";
import type { ReportCard } from "../reports";
import type { PupuState } from "../server";
import { MAIN_SESSION, type ChatsView } from "../threads";
import { createSnapshotOrder } from "./snapshot-order";

/** 这个浏览器没有凭据，或者凭据被吊销了。页面换成登录。 */
export class UnauthorizedError extends Error {}

/** 网络半通时请求不成功也不报错，不设上限就一直停在「加载中」。 */
const STATE_TIMEOUT_MS = 10_000;

/** 请求没到云端：超时，或者 fetch 自己失败。云端回的错误照原话显示。 */
function isUnreachable(cause: unknown): boolean {
  return cause instanceof TypeError || (cause instanceof DOMException && cause.name === "TimeoutError");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  if (response.status === 401 && path !== "/api/pair") {
    throw new UnauthorizedError("这个浏览器还没连上 Pupu");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // 响应体不是 JSON，用状态码。
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}


export const api = {
  state: () => request<PupuState>("/api/state", { signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }),
  /** 开没开 Google 登录。见 src/auth/routes.ts。 */
  googleEnabled: async () => (await request<{ enabled: boolean }>("/api/auth/google")).enabled,
  createProject: (name: string, goal: string) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, goal })
    }),
  /** 打开了这个项目：它报回聊天的结果都算看过。 */
  markProjectSeen: (id: string) =>
    request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/seen`, { method: "POST" }),
  revokeComputer: (id: string) =>
    request<{ ok: true }>(`/api/computers/${encodeURIComponent(id)}/revoke`, {
      method: "POST"
    }),
  /** 收回这台电脑的屏幕控制，和电脑菜单栏上的收回一样。 */
  takeback: (id: string) =>
    request<{ ok: true }>(`/api/computers/${encodeURIComponent(id)}/takeback`, {
      method: "POST"
    }),
  /** `proof` 是往宽里改时用通行密钥确认过的结果，见 passkey.ts。 */
  setPolicy: (id: string, policy: ComputerPolicy, proof?: AuthenticationResponseJSON) =>
    request<{ ok: true }>(`/api/computers/${encodeURIComponent(id)}/policy`, {
      method: "POST",
      body: JSON.stringify({ policy, proof })
    }),
  decideApproval: (id: string, decision: "allow" | "deny", proof?: AuthenticationResponseJSON) =>
    request<{ ok: true }>(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ decision, proof })
    }),
  /** 用通行密钥确认一件事之前，先拿挑战。 */
  proofOptions: (purpose: Purpose) =>
    request<PublicKeyCredentialRequestOptionsJSON>("/api/proofs", { method: "POST", body: JSON.stringify({ purpose }) }),
  passkeyOptions: (proof?: AuthenticationResponseJSON) =>
    request<PublicKeyCredentialCreationOptionsJSON>("/api/passkeys/options", {
      method: "POST",
      body: JSON.stringify({ proof })
    }),
  addPasskey: (response: RegistrationResponseJSON) =>
    request<{ ok: true }>("/api/passkeys", { method: "POST", body: JSON.stringify({ response }) }),
  /** 拿配对码或访问口令换这个浏览器的凭据。凭据写进 HttpOnly cookie，脚本拿不到。 */
  pair: (credential: { code: string } | { accessToken: string }) =>
    request<{ id: string; name: string }>("/api/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "browser", ...credential })
    }),
  createPairingCode: () =>
    request<{ code: string; expiresAt: number }>("/api/pairing-codes", { method: "POST" }),
  revokeDevice: (id: string) =>
    request<{ ok: true }>(`/api/devices/${encodeURIComponent(id)}/revoke`, {
      method: "POST"
    }),
  /** 邀请成员。只有创建者能邀请，网页上要带通行密钥的确认（见 members.ts 的 `mayInvite`）。 */
  inviteMember: (email: string, proof?: AuthenticationResponseJSON) =>
    request<{ ok: true }>("/api/members", { method: "POST", body: JSON.stringify({ email, proof }) }),
  removeMember: (id: string) =>
    request<{ ok: true }>(`/api/members/${encodeURIComponent(id)}/remove`, { method: "POST" }),
  /** 连一个账号：返回 open-connector 的授权页地址。只有手机和本机开发能连，见 members.ts 的 `mayConnect`。 */
  connect: (service: string) =>
    request<{ url: string }>(`/api/connectors/${encodeURIComponent(service)}/connect`, { method: "POST" }),
  /** 断开一个账号，open-connector 那边一起撤销授权。 */
  removeConnector: (id: string) =>
    request<{ ok: true }>(`/api/connectors/${encodeURIComponent(id)}/remove`, { method: "POST" }),
  /** 换自己的头像：一个预设的 id，或者 null 换回名字的第一个字。 */
  setAvatar: (preset: string | null) =>
    request<{ ok: true }>("/api/me/avatar", { method: "POST", body: JSON.stringify({ preset }) }),
  /** 上传自己的头像：先裁成正方形缩小（见 Avatar.tsx 的 `cropToSquare`），云端只验不转码。 */
  uploadAvatar: (image: Blob) =>
    request<{ ok: true }>("/api/me/avatar", { method: "PUT", body: image, headers: { "Content-Type": image.type } }),
  invites: () => request<InviteList>("/api/invites"),
  createInvite: () => request<{ code: string }>("/api/invites", { method: "POST" }),
  revokeInvite: (code: string) =>
    request<{ ok: true }>(`/api/invites/${encodeURIComponent(code)}/revoke`, { method: "POST" })
};

const NO_CHATS: ChatsView = { main: { session: MAIN_SESSION, lastAt: null }, private: null };
const NO_CONNECTORS: PupuState["connectors"] = { enabled: false, services: [], accounts: [] };

/**
 * 项目、电脑、请示、设备和项目报回聊天的结果。页面拿到 `projects_changed` 这类消息时调 `refresh()`。
 * 被拒（没登录或者被吊销）时 `unauthorized` 是 true，接着轮询：别的标签页登录了，这里也会回来。
 */
export function usePupuState() {
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [computers, setComputers] = useState<PupuState["computers"]>([]);
  const [approvals, setApprovals] = useState<readonly ApprovalView[]>([]);
  const [devices, setDevices] = useState<readonly DeviceView[]>([]);
  const [activity, setActivity] = useState<PupuState["activity"]>([]);
  const [members, setMembers] = useState<PupuState["members"]>([]);
  const [connectors, setConnectors] = useState<PupuState["connectors"]>(NO_CONNECTORS);
  const [reports, setReports] = useState<readonly ReportCard[]>([]);
  const [chats, setChats] = useState<ChatsView>(NO_CHATS);
  const [passkeys, setPasskeys] = useState<PupuState["passkeys"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const fetching = useRef(0);
  const [order] = useState(createSnapshotOrder);

  const refresh = useCallback(async () => {
    fetching.current += 1;
    const ticket = order.start();
    try {
      const state = await api.state();
      const use = order.arrived(ticket);
      if (use.state) {
        setProjects(state.projects);
        setComputers(state.computers);
        setApprovals(state.approvals);
        setDevices(state.devices);
        setMembers(state.members);
        setConnectors(state.connectors);
        // 部署新云端之前的老 DO 没有这一项。
        setReports(state.reports ?? []);
        setChats(state.chats ?? NO_CHATS);
        setPasskeys(state.passkeys ?? null);
        setLoaded(true);
      }
      if (use.activity) setActivity(state.activity);
      if (use.outcome) {
        setError(null);
        setUnauthorized(false);
      }
    } catch (cause) {
      if (!order.failed(ticket)) return;
      if (cause instanceof UnauthorizedError) {
        setUnauthorized(true);
        setLoaded(true);
        return;
      }
      // 一次都没取到时不算加载完：空列表会让人以为真的没有项目。
      setError(isUnreachable(cause) ? "连不上 Pupu，正在重试。" : cause instanceof Error ? cause.message : String(cause));
    } finally {
      fetching.current -= 1;
    }
  }, [order]);

  const applyActivity = useCallback(
    (next: PupuState["activity"]) => {
      order.pushed();
      setActivity(next);
    },
    [order]
  );

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && fetching.current === 0) void refresh();
    }, 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  /** 每台电脑在做什么。会话连接上收到 `activity` 帧时用 `applyActivity` 直接换掉，不用等下一次拉取。 */
  return {
    projects,
    computers,
    approvals,
    devices,
    activity,
    members,
    connectors,
    applyActivity,
    reports,
    chats,
    passkeys,
    error,
    unauthorized,
    loaded,
    refresh
  };
}
