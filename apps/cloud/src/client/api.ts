import { useCallback, useEffect, useState } from "react";
import type { Project, Proposal } from "../projects";
import type { PupuState } from "../server";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
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
  acceptProposal: (id: string) =>
    request<Project>(`/api/proposals/${encodeURIComponent(id)}/accept`, {
      method: "POST"
    }),
  dismissProposal: (id: string) =>
    request<{ ok: true }>(`/api/proposals/${encodeURIComponent(id)}/dismiss`, {
      method: "POST"
    })
};

/** 项目和建议的列表，页面拿到 `projects_changed` 时调 `refresh()`。 */
export function usePupuState() {
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [proposals, setProposals] = useState<readonly Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const state = await api.state();
      setProjects(state.projects);
      setProposals(state.proposals);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { projects, proposals, error, loaded, refresh };
}
