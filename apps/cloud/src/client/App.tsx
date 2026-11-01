import { Avatar, Button, Drawer, Tabs } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "../projects";
import { api, usePupuState } from "./api";
import { Approvals } from "./Approvals";
import { Chat, type ChatContext } from "./Chat";
import { useDesktopComputer } from "./desktop";
import { Home } from "./Home";
import { MenuIcon, PlusIcon } from "./icons";
import { Login } from "./Login";
import { NewProject } from "./NewProject";
import { Settings } from "./Settings";

/** pi 的根会话 id，就是聊天。不从 agents/harness/pi 引，免得把服务端代码打进网页。 */
const ROOT_SESSION = "1";

/** 用地址栏的 hash 做路由，手机上的返回手势也能用。 */
type Route =
  | { readonly kind: "home" }
  | { readonly kind: "chat" }
  | { readonly kind: "projects" }
  | { readonly kind: "project"; readonly id: string };

type Section = "home" | "chat" | "projects";

const SECTIONS: readonly (readonly [Section, string])[] = [
  ["home", "主页"],
  ["chat", "聊天"],
  ["projects", "项目"]
];

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const project = path.match(/^\/projects\/(.+)$/);
  if (project) return { kind: "project", id: decodeURIComponent(project[1]) };
  if (path === "/projects") return { kind: "projects" };
  if (path === "/home") return { kind: "home" };
  return { kind: "chat" };
}

function hashOf(route: Route): string {
  switch (route.kind) {
    case "home":
      return "#/home";
    case "chat":
      return "#/";
    case "projects":
      return "#/projects";
    case "project":
      return `#/projects/${encodeURIComponent(route.id)}`;
  }
}

function sectionOf(route: Route): Section {
  return route.kind === "project" ? "projects" : route.kind;
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

/** 记住上次打开的项目，点「项目」时直接回到它。浏览器存储可能不可用，失败就算了。 */
const LAST_PROJECT = "pupu:last-project";

function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

function rememberProject(id: string) {
  try {
    localStorage.setItem(LAST_PROJECT, id);
  } catch {
    // 不记也能用。
  }
}

export function App() {
  const [route, go] = useRoute();
  const { projects, computers, approvals, devices, loaded, error, unauthorized, refresh } = usePupuState();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const thisComputer = useDesktopComputer();

  const chat: ChatContext = useMemo(
    () => ({
      projects: new Map(projects.map((project) => [project.id, project])),
      projectTags: route.kind === "chat",
      onOpenProject: (id) => go({ kind: "project", id }),
      onProjectsChanged: () => void refresh()
    }),
    [projects, refresh, go, route.kind]
  );

  // 「项目」没指定是哪个：回到上次那个，没有就打开最近活跃的。
  useEffect(() => {
    if (route.kind !== "projects" || !loaded) return;
    const last = lastProject();
    const target =
      projects.find((project) => project.id === last) ?? projects[0];
    if (target) go({ kind: "project", id: target.id });
  }, [route.kind, loaded, projects, go]);

  const project =
    route.kind === "project" ? chat.projects.get(route.id) : undefined;
  useEffect(() => {
    if (project) rememberProject(project.id);
  }, [project]);

  if (unauthorized) return <Login />;

  const section = sectionOf(route);
  const goSection = (key: Section) => {
    if (key === "home") go({ kind: "home" });
    else if (key === "chat") go({ kind: "chat" });
    else go({ kind: "projects" });
  };

  let body;
  if (route.kind === "home") {
    body = (
      <Home
        projects={projects}
        computers={computers}
        onOpenProject={(id) => go({ kind: "project", id })}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    );
  } else if (route.kind === "chat") {
    body = (
      <Chat
        key="chat"
        session={ROOT_SESSION}
        context={chat}
        placeholder="给 Pupu 发消息"
        empty={
          <div className="flex flex-col gap-2 text-center">
            <div className="text-2xl font-semibold text-(--on-sky-strong)">
              我是 Pupu
            </div>
            <div className="text-[15px] leading-7 text-(--on-sky-strong)/80">
              这是我们的聊天，会一直接着聊下去。
              <br />
              小事我直接办，要持续推进的事放进项目里。
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
  } else if (project) {
    body = (
      <Chat
        key={project.session}
        session={project.session}
        context={chat}
        placeholder={`在「${project.name}」里说`}
        top={
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="glass mx-auto max-w-[80%] truncate rounded-full px-3.5 py-1 text-[13px] font-medium"
          >
            {project.name}
          </button>
        }
        empty={
          <div className="glass-strong bubble mx-auto max-w-md rounded-3xl px-5 py-4 text-center text-[15px] leading-7">
            <div className="font-semibold">{project.name}</div>
            {project.goal && <div className="text-muted">{project.goal}</div>}
          </div>
        }
      />
    );
  } else {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="text-[15px] leading-7 text-(--on-sky-strong)">
          {!loaded
            ? "加载中…"
            : route.kind === "project"
              ? "找不到这个项目。"
              : "还没有项目。在聊天里说要做的事，Pupu 会问你要不要建一个；也可以自己建。"}
        </div>
        {loaded && (
          <Button variant="secondary" onPress={() => setCreating(true)}>
            <PlusIcon />
            新项目
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-dvh">
      <div className="sky" />
      {/* 宽屏（电脑 App 的窗口、电脑浏览器）：项目列表常驻左边，抽屉不用了。 */}
      <aside className="glass relative z-10 my-3 ml-3 hidden w-64 shrink-0 flex-col overflow-hidden rounded-3xl lg:flex">
        <div className="px-4 pt-4 pb-1 text-sm font-medium text-muted">项目</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <ProjectList
            projects={projects}
            current={project?.id}
            onOpen={(id) => go({ kind: "project", id })}
            onCreate={() => setCreating(true)}
          />
        </div>
        {thisComputer && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-2 border-t border-foreground/10 px-4 py-3 text-left text-[13px]"
          >
            <span
              className={`size-2 shrink-0 rounded-full ${
                thisComputer.status === "offline" ? "bg-foreground/25" : "bg-emerald-600"
              }`}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{thisComputer.name}</span>
              <span className="block truncate text-muted">{thisComputer.title}</span>
            </span>
          </button>
        )}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="pt-safe relative z-10 grid grid-cols-[3rem_1fr_3rem] items-center px-3 py-2.5">
          <div className="lg:invisible">
            {section === "projects" && (
              <Button
                isIconOnly
                variant="ghost"
                aria-label="打开项目抽屉"
                onPress={() => setDrawerOpen(true)}
                className="glass size-10 rounded-full text-lg text-foreground"
              >
                <MenuIcon />
              </Button>
            )}
          </div>
          <Tabs
            className="justify-self-center"
            selectedKey={section}
            onSelectionChange={(key) => goSection(key as Section)}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="Pupu" className="glass rounded-full p-1 *:min-w-16 *:rounded-full">
                {SECTIONS.map(([id, label]) => (
                  <Tabs.Tab
                    key={id}
                    id={id}
                    className="data-[selected=true]:text-background"
                  >
                    {label}
                    <Tabs.Indicator className="rounded-full bg-foreground" />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
          <button
            type="button"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
            className="justify-self-end rounded-full"
          >
            <Avatar size="sm">
              <Avatar.Fallback>我</Avatar.Fallback>
            </Avatar>
          </button>
        </header>
        {error && (
          <div className="relative z-10 mx-auto rounded-full bg-danger px-3 py-1 text-xs text-danger-foreground">
            {error}
          </div>
        )}
        <Approvals
          approvals={approvals}
          onDecide={async (id, decision) => {
            await api.decideApproval(id, decision);
            await refresh();
          }}
        />
        <main className="min-h-0 flex-1">{body}</main>
      </div>

      <ProjectDrawer
        isOpen={drawerOpen}
        onOpenChange={setDrawerOpen}
        projects={projects}
        current={project?.id}
        onOpen={(id) => {
          setDrawerOpen(false);
          go({ kind: "project", id });
        }}
        onCreate={() => {
          setDrawerOpen(false);
          setCreating(true);
        }}
      />
      <Settings
        isOpen={settingsOpen}
        onOpenChange={setSettingsOpen}
        computers={computers}
        onRevoke={async (id) => {
          await api.revokeComputer(id);
          await refresh();
        }}
        onSetPolicy={async (id, policy) => {
          await api.setPolicy(id, policy);
          await refresh();
        }}
        devices={devices}
        onRevokeDevice={async (id) => {
          await api.revokeDevice(id);
          await refresh();
        }}
        onCreatePairingCode={api.createPairingCode}
      />
      <NewProject
        isOpen={creating}
        onOpenChange={setCreating}
        onCreate={async (name, goal) => {
          const created = await api.createProject(name, goal);
          await refresh();
          go({ kind: "project", id: created.id });
        }}
      />
    </div>
  );
}

function ProjectDrawer({
  isOpen,
  onOpenChange,
  projects,
  current,
  onOpen,
  onCreate
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly Project[];
  current: string | undefined;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <Drawer>
      <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Drawer.Content placement="left">
          <Drawer.Dialog className="w-[min(80vw,320px)]">
            <Drawer.Header>
              <Drawer.Heading>项目</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body>
              <ProjectList projects={projects} current={current} onOpen={onOpen} onCreate={onCreate} />
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}

/** 新项目按钮和项目列表。手机上放在抽屉里，宽屏常驻左边。 */
function ProjectList({
  projects,
  current,
  onOpen,
  onCreate
}: {
  projects: readonly Project[];
  current: string | undefined;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <nav className="flex flex-col">
      <button
        type="button"
        onClick={onCreate}
        className="flex items-center gap-2 rounded-xl px-2 py-3 text-left text-[17px] text-muted hover:bg-default lg:py-2 lg:text-[15px]"
      >
        <PlusIcon />
        新项目
      </button>
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          onClick={() => onOpen(project.id)}
          aria-current={project.id === current ? "page" : undefined}
          className={`truncate rounded-xl px-2 py-3 text-left text-[17px] hover:bg-default lg:py-2 lg:text-[15px] ${
            project.id === current ? "bg-default font-semibold text-foreground" : "text-muted"
          }`}
        >
          {project.name}
        </button>
      ))}
    </nav>
  );
}
