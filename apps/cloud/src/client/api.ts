import { useCallback, useEffect, useState } from "react";
import type { ApprovalView } from "../bridge/approvals";
import type { ComputerPolicy } from "../bridge/policy";
import type { DeviceView } from "../devices";
import type { Project } from "../projects";
import type { ReportCard } from "../reports";
import type { PupuState } from "../server";
import { MAIN_SESSION, type ChatsView } from "../threads";

/** 这个浏览器没有凭据，或者凭据被吊销了。页面换成登录。 */
export class UnauthorizedError extends Error {}

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
  state: () => request<PupuState>("/api/state"),
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
  setPolicy: (id: string, policy: ComputerPolicy) =>
    request<{ ok: true }>(`/api/computers/${encodeURIComponent(id)}/policy`, {
      method: "POST",
      body: JSON.stringify({ policy })
    }),
  decideApproval: (id: string, decision: "allow" | "deny") =>
    request<{ ok: true }>(`/api/approvals/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ decision })
    }),
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
  /** 邀请成员。只有创建者在手机 App 上能邀请，网页上调会被拒（见 members.ts 的 `mayInvite`）。 */
  inviteMember: (email: string) =>
    request<{ ok: true }>("/api/members", { method: "POST", body: JSON.stringify({ email }) }),
  removeMember: (id: string) =>
    request<{ ok: true }>(`/api/members/${encodeURIComponent(id)}/remove`, { method: "POST" })
};

const NO_CHATS: ChatsView = { main: { session: MAIN_SESSION, lastAt: null }, private: null };

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
  const [reports, setReports] = useState<readonly ReportCard[]>([]);
  const [chats, setChats] = useState<ChatsView>(NO_CHATS);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const state = await api.state();
      setProjects(state.projects);
      setComputers(state.computers);
      setApprovals(state.approvals);
      setDevices(state.devices);
      setActivity(state.activity);
      setMembers(state.members);
      // 部署新云端之前的老 DO 没有这一项。
      setReports(state.reports ?? []);
      setChats(state.chats ?? NO_CHATS);
      setError(null);
      setUnauthorized(false);
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        setUnauthorized(true);
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
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
    applyActivity: setActivity,
    reports,
    chats,
    error,
    unauthorized,
    loaded,
    refresh
  };
}
