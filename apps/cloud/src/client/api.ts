import { useCallback, useEffect, useState } from "react";
import type { ApprovalView } from "../bridge/approvals";
import type { ComputerPolicy } from "../bridge/policy";
import type { DeviceView } from "../devices";
import type { Project } from "../projects";
import type { PupuState } from "../server";

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
  createProject: (name: string, goal: string) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, goal })
    }),
  revokeComputer: (id: string) =>
    request<{ ok: true }>(`/api/computers/${encodeURIComponent(id)}/revoke`, {
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
    })
};

/**
 * 项目、电脑、请示和设备。页面拿到 `projects_changed` 这类消息时调 `refresh()`。
 * 被拒（没登录或者被吊销）时 `unauthorized` 是 true，接着轮询：别的标签页登录了，这里也会回来。
 */
export function usePupuState() {
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [computers, setComputers] = useState<PupuState["computers"]>([]);
  const [approvals, setApprovals] = useState<readonly ApprovalView[]>([]);
  const [devices, setDevices] = useState<readonly DeviceView[]>([]);
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

  return { projects, computers, approvals, devices, error, unauthorized, loaded, refresh };
}
