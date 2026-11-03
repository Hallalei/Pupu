import { Button, Drawer, Tabs } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { actorOf } from "../members";
import type { Project } from "../projects";
import { api, usePupuState } from "./api";
import { Approvals } from "./Approvals";
import { Chat, type ChatContext } from "./Chat";
import { useDesktopComputer } from "./desktop";
import { ago, Home } from "./Home";
import { ChatIcon, CheckIcon, ChevronDownIcon, FolderIcon, HomeIcon, PlusIcon } from "./icons";
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

/**
 * 手机（窄于 1024）：顶部三段切换，项目页顶栏下方是项目名胶囊，点开从底部弹出的项目列表。
 * 宽屏（电脑 App 的窗口、电脑浏览器）：左侧栏放主页、聊天和全部项目，不要顶部三段和胶囊。
 */
export function App() {
  const [route, go] = useRoute();
  const {
    projects,
    computers,
    approvals,
    devices,
    activity,
    members,
    applyActivity,
    loaded,
    error,
    unauthorized,
    refresh
  } = usePupuState();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 在主页输入栏里发的话：切到聊天，连上以后发出去。 */
  const [pendingChat, setPendingChat] = useState<string | null>(null);
  const thisComputer = useDesktopComputer();
  // 审批的允许只认手机 App。本机开发没设访问口令时没有「这台设备」，照常能点。
  const current = devices.find((device) => device.current);
  const canAllow = !current || current.kind === "phone";

  const chat: ChatContext = useMemo(
    () => ({
      projects: new Map(projects.map((project) => [project.id, project])),
      projectTags: route.kind === "chat",
      computers,
      approvals,
      onOpenProject: (id) => go({ kind: "project", id }),
      onProjectsChanged: () => void refresh(),
      onActivity: applyActivity
    }),
    [projects, computers, approvals, refresh, applyActivity, go, route.kind]
  );

  // 「项目」没指定是哪个：回到上次那个，没有就打开最近活跃的。
  useEffect(() => {
    if (route.kind !== "projects" || !loaded) return;
    const last = lastProject();
    const target = projects.find((project) => project.id === last) ?? projects[0];
    if (target) go({ kind: "project", id: target.id });
  }, [route.kind, loaded, projects, go]);

  const project = route.kind === "project" ? chat.projects.get(route.id) : undefined;
  useEffect(() => {
    if (project) rememberProject(project.id);
  }, [project]);

  const clearPending = useCallback(() => setPendingChat(null), []);

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
        activity={activity}
        onOpenProject={(id) => go({ kind: "project", id })}
        onOpenChat={() => go({ kind: "chat" })}
        onOpenAllProjects={() => setDrawerOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onTakeback={async (id) => {
          await api.takeback(id);
          await refresh();
        }}
        onSend={(text) => {
          setPendingChat(text);
          go({ kind: "chat" });
        }}
      />
    );
  } else if (route.kind === "chat") {
    body = (
      <Chat
        key="chat"
        session={ROOT_SESSION}
        context={chat}
        placeholder="给 Pupu 发消息"
        pending={pendingChat}
        onPendingSent={clearPending}
        empty={
          <div className="flex flex-col gap-2 text-center text-ink-sky">
            <div className="text-greeting">我是 Pupu</div>
            <div className="text-message">
              这是我们的聊天，会一直接着聊下去。
              <br />
              小事我直接办，要持续推进的事放进项目里。
            </div>
          </div>
        }
        starters={["我想做一个新功能，帮我理一理", "帮我规划一下这周要做的事", "我现在有哪些项目？"]}
      />
    );
  } else if (project) {
    body = (
      <Chat
        key={project.session}
        session={project.session}
        context={chat}
        placeholder={`在「${project.name}」里说`}
        empty={
          <div className="strong bubble mx-auto flex max-w-md flex-col gap-1 rounded-panel px-5 py-4 text-center">
            <div className="text-headline">{project.name}</div>
            {project.goal && <div className="text-subheadline text-muted">{project.goal}</div>}
          </div>
        }
      />
    );
  } else {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
        <div className="text-message text-ink-sky">
          {!loaded
            ? "加载中…"
            : route.kind === "project"
              ? "找不到这个项目。"
              : "还没有项目。在聊天里说要做的事，Pupu 会问你要不要建一个；也可以自己建。"}
        </div>
        {loaded && (
          <Button
            variant="ghost"
            onPress={() => setCreating(true)}
            className="glass h-control rounded-full px-4 text-body font-semibold text-foreground"
          >
            <PlusIcon />
            新项目
          </Button>
        )}
      </div>
    );
  }

  const title =
    route.kind === "home" ? "主页" : route.kind === "chat" ? "聊天" : (project?.name ?? "项目");

  return (
    <div className="flex h-dvh">
      <div className="sky" />
      <Sidebar
        route={route}
        projects={projects}
        current={project?.id}
        onGo={go}
        onCreate={() => setCreating(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        thisComputer={thisComputer}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-10 shrink-0 pt-[max(env(safe-area-inset-top),8px)] lg:pt-0">
          <div className="flex h-11 items-center justify-between px-4 lg:hidden">
            <div className="size-11" />
            <Tabs selectedKey={section} onSelectionChange={(key) => goSection(key as Section)}>
              <Tabs.ListContainer>
                <Tabs.List aria-label="Pupu" className="glass h-11 rounded-full p-1">
                  {SECTIONS.map(([id, label]) => (
                    <Tabs.Tab
                      key={id}
                      id={id}
                      className="h-9 w-16 min-w-16 rounded-full px-0 text-subheadline font-medium text-foreground data-[selected=true]:font-semibold data-[selected=true]:text-background"
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
              className="glass grid size-11 place-items-center rounded-full text-subheadline font-semibold"
            >
              我
            </button>
          </div>
          <div className="hidden h-13 items-center justify-center gap-2 px-6 text-on-sky-strong lg:flex">
            {project && <FolderIcon className="shrink-0 text-[16px]" />}
            <span className="truncate text-headline">{title}</span>
            {project?.goal && <span className="truncate text-footnote opacity-80">· {project.goal}</span>}
          </div>
          <div className="h-2 lg:hidden" />
        </header>
        {error && (
          <div className="strong relative z-10 mx-auto mb-2 rounded-full px-3 py-1 text-caption text-danger-ink">
            {error}
          </div>
        )}
        <Approvals
          approvals={approvals}
          canAllow={canAllow}
          phonePaired={devices.some((device) => device.kind === "phone")}
          onDecide={async (id, decision) => {
            await api.decideApproval(id, decision);
            await refresh();
          }}
        />
        {project && (
          <div className="relative z-10 flex shrink-0 justify-center px-4 pb-3 lg:hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label={`当前项目「${project.name}」，切换项目`}
              className="glass flex h-9 max-w-[85%] items-center gap-1.5 rounded-full pr-3 pl-3.5 text-subheadline font-semibold"
            >
              <FolderIcon className="shrink-0 text-[15px]" />
              <span className="truncate">{project.name}</span>
              <ChevronDownIcon className="shrink-0 text-[14px]" />
            </button>
          </div>
        )}
        <main className="min-h-0 flex-1">{body}</main>
      </div>

      <ProjectSheet
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
        members={members}
        actor={actorOf(current ?? null, members)}
        onRevokeDevice={async (id) => {
          await api.revokeDevice(id);
          await refresh();
        }}
        onInviteMember={async (email) => {
          await api.inviteMember(email);
          await refresh();
        }}
        onRemoveMember={async (id) => {
          await api.removeMember(id);
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

/** 宽屏的左侧栏：主页、聊天、全部项目；底下是这台电脑（只在电脑 App 里）和设置。 */
function Sidebar({
  route,
  projects,
  current,
  onGo,
  onCreate,
  onOpenSettings,
  thisComputer
}: {
  route: Route;
  projects: readonly Project[];
  current: string | undefined;
  onGo: (route: Route) => void;
  onCreate: () => void;
  onOpenSettings: () => void;
  thisComputer: ReturnType<typeof useDesktopComputer>;
}) {
  return (
    <aside className="soft relative z-10 m-3 mr-0 hidden w-66 shrink-0 flex-col gap-0.5 overflow-hidden rounded-panel p-2 lg:flex">
      <NavItem icon={<HomeIcon />} current={route.kind === "home"} onPress={() => onGo({ kind: "home" })}>
        主页
      </NavItem>
      <NavItem icon={<ChatIcon />} current={route.kind === "chat"} onPress={() => onGo({ kind: "chat" })}>
        聊天
      </NavItem>
      <div className="mt-3 flex h-8 shrink-0 items-center justify-between pl-2">
        <span className="text-caption font-medium text-muted">项目</span>
        <button
          type="button"
          aria-label="新项目"
          onClick={onCreate}
          className="grid size-control-sm place-items-center rounded-lg text-[16px] text-muted hover:bg-default"
        >
          <PlusIcon />
        </button>
      </div>
      <nav aria-label="项目" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {projects.length === 0 && (
          <p className="px-2 py-1 text-footnote text-muted">还没有项目。在聊天里说要做的事，Pupu 会问你要不要建一个。</p>
        )}
        {projects.map((project) => (
          <NavItem
            key={project.id}
            current={project.id === current}
            onPress={() => onGo({ kind: "project", id: project.id })}
          >
            {project.name}
          </NavItem>
        ))}
      </nav>
      {thisComputer && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-1 flex shrink-0 items-center gap-2 border-t border-foreground/10 px-2 pt-2.5 pb-1.5 text-left"
        >
          <span
            className={`size-2 shrink-0 rounded-full ${thisComputer.status === "offline" ? "bg-offline" : "bg-online"}`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-footnote font-semibold">这台电脑 · {thisComputer.name}</span>
            <span className="block truncate text-caption text-muted">{thisComputer.title}</span>
          </span>
        </button>
      )}
      <NavItem
        icon={
          <span className="grid size-5 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background">
            我
          </span>
        }
        onPress={onOpenSettings}
      >
        设置
      </NavItem>
    </aside>
  );
}

function NavItem({
  icon,
  current = false,
  onPress,
  children
}: {
  icon?: ReactNode;
  current?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-current={current ? "page" : undefined}
      className={`flex h-control shrink-0 items-center gap-2 rounded-[10px] px-2 text-left text-body ${
        current ? "strong font-semibold" : "hover:bg-default/60"
      }`}
    >
      {icon && <span className="shrink-0 text-[16px]">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** 手机上切换项目：从底部弹出，第一行「新项目」，下面是全部项目，最近活动的在前。 */
function ProjectSheet({
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
        <Drawer.Content placement="bottom">
          <Drawer.Dialog className="max-h-[85dvh] rounded-t-panel">
            <Drawer.Header>
              <Drawer.Heading className="text-title">项目</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="flex flex-col gap-6 pb-6">
              <button
                type="button"
                onClick={onCreate}
                className="flex h-13 items-center gap-3 rounded-row bg-surface-inset px-4 text-left text-body text-foreground"
              >
                <PlusIcon className="text-[20px]" />
                新项目
              </button>
              {projects.length > 0 && (
                <div className="flex flex-col divide-y divide-foreground/10 overflow-hidden rounded-row bg-surface-inset">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => onOpen(project.id)}
                      aria-current={project.id === current ? "page" : undefined}
                      className="flex min-h-17 items-center gap-3 px-4 py-3 text-left text-foreground"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className={`truncate text-body ${project.id === current ? "font-semibold" : ""}`}>
                          {project.name}
                        </span>
                        <span className="truncate text-subheadline text-muted">
                          {project.progress || project.goal || "没写目标"}
                        </span>
                      </span>
                      {project.id === current ? (
                        <CheckIcon className="shrink-0 text-[18px]" />
                      ) : (
                        <span className="shrink-0 text-caption text-muted">{ago(project.updatedAt)}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
