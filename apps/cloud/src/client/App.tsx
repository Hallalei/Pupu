import { useCallback, useEffect, useMemo, useState } from "react";
import { api, usePupuState } from "./api";
import { Chat, type CardContext } from "./Chat";
import { Projects } from "./Projects";

/** pi 的根会话 id，就是主对话。不从 agents/harness/pi 引，免得把服务端代码打进网页。 */
const ROOT_SESSION = "1";

/** 用地址栏的 hash 做路由，手机上的返回手势也能用。 */
type Route =
  | { readonly kind: "main" }
  | { readonly kind: "projects" }
  | { readonly kind: "project"; readonly id: string };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const project = path.match(/^\/projects\/(.+)$/);
  if (project) return { kind: "project", id: decodeURIComponent(project[1]) };
  if (path === "/projects") return { kind: "projects" };
  return { kind: "main" };
}

function hashOf(route: Route): string {
  switch (route.kind) {
    case "main":
      return "#/";
    case "projects":
      return "#/projects";
    case "project":
      return `#/projects/${encodeURIComponent(route.id)}`;
  }
}

function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const go = useCallback((next: Route) => {
    location.hash = hashOf(next);
  }, []);
  return [route, go] as const;
}

export function App() {
  const [route, go] = useRoute();
  const state = usePupuState();
  const { refresh } = state;

  const cards: CardContext = useMemo(
    () => ({
      projects: new Map(state.projects.map((project) => [project.id, project])),
      proposals: new Map(state.proposals.map((proposal) => [proposal.id, proposal])),
      onAccept: async (id) => {
        await api.acceptProposal(id);
        await refresh();
      },
      onDismiss: async (id) => {
        await api.dismissProposal(id);
        await refresh();
      },
      onOpenProject: (id) => go({ kind: "project", id }),
      onProjectsChanged: () => void refresh()
    }),
    [state.projects, state.proposals, refresh, go]
  );

  const project =
    route.kind === "project" ? cards.projects.get(route.id) : undefined;

  let body;
  if (route.kind === "main") {
    body = (
      <Chat
        key="main"
        session={ROOT_SESSION}
        cards={cards}
        placeholder="跟 Pupu 说点什么"
        empty={
          <div className="flex flex-col gap-2">
            <div className="text-2xl font-semibold">我是 Pupu</div>
            <div className="text-[15px] leading-7 text-(--muted)">
              这是我们的主对话，会一直接着聊下去。小事我直接办；要持续推进的事，我会建议放进项目里。
            </div>
          </div>
        }
        starters={[
          "我想做一个新功能，帮我理一理",
          "帮我规划一下这周要做的事",
          "我现在有哪些项目？"
        ]}
      />
    );
  } else if (route.kind === "projects") {
    body = (
      <Projects
        projects={state.projects}
        proposals={state.proposals}
        onOpen={(id) => go({ kind: "project", id })}
        onCreate={async (name, goal) => {
          const created = await api.createProject(name, goal);
          await refresh();
          go({ kind: "project", id: created.id });
        }}
        onAccept={cards.onAccept}
        onDismiss={cards.onDismiss}
      />
    );
  } else if (project) {
    body = (
      <Chat
        key={project.session}
        session={project.session}
        cards={cards}
        placeholder={`在「${project.name}」里说`}
        header={
          <div className="flex flex-col gap-1 border-b border-(--border) pb-3">
            <button
              type="button"
              onClick={() => go({ kind: "projects" })}
              className="self-start text-sm text-(--muted)"
            >
              ← 所有项目
            </button>
            <div className="text-lg font-semibold">{project.name}</div>
            {project.goal && (
              <div className="text-sm text-(--muted)">{project.goal}</div>
            )}
          </div>
        }
        empty={
          <div className="text-[15px] leading-7 text-(--muted)">
            这是「{project.name}」的项目会话，会一直持续下去。从这里开始推进它。
          </div>
        }
      />
    );
  } else {
    body = (
      <div className="p-8 text-center text-sm text-(--muted)">
        {state.loaded ? "找不到这个项目。" : "加载中…"}
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-(--border) px-4 pt-[max(env(safe-area-inset-top),0px)]">
        <div className="flex h-12 items-center gap-2">
          <span className="size-2.5 rounded-full bg-(--accent)" />
          <span className="font-semibold">Pupu</span>
        </div>
        {state.error && (
          <span className="truncate text-xs text-(--danger)">{state.error}</span>
        )}
      </header>
      <main className="min-h-0 flex-1">{body}</main>
      <nav className="pb-safe flex border-t border-(--border) bg-(--surface)">
        <Tab active={route.kind === "main"} onClick={() => go({ kind: "main" })}>
          主对话
        </Tab>
        <Tab
          active={route.kind !== "main"}
          onClick={() => go({ kind: "projects" })}
          badge={state.proposals.filter((proposal) => proposal.status === "pending").length}
        >
          项目
        </Tab>
      </nav>
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
  badge = 0
}: {
  active: boolean;
  onClick: () => void;
  children: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex h-14 flex-1 items-center justify-center text-[15px] ${
        active ? "font-semibold text-(--fg)" : "text-(--muted)"
      }`}
    >
      {children}
      {badge > 0 && (
        <span className="ml-1.5 rounded-full bg-(--accent) px-1.5 text-xs leading-5 text-(--accent-fg)">
          {badge}
        </span>
      )}
      {active && (
        <span className="absolute top-0 h-0.5 w-10 rounded-full bg-(--accent)" />
      )}
    </button>
  );
}
