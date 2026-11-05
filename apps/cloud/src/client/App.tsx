import { Button, Dropdown, Label, Tabs } from "@heroui/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { actorOf } from "../members";
import type { Project } from "../projects";
import { api, usePupuState } from "./api";
import { Approvals } from "./Approvals";
import { Chat, usePressMenu, type ChatContext } from "./Chat";
import { LINE_HINTS, LINE_NAMES, useChatLines, type LineKey } from "./chat-lines";
import { useDesktopComputer } from "./desktop";
import { Home } from "./Home";
import { ChatIcon, CheckIcon, FolderIcon, HomeIcon, LockIcon, MenuIcon, PlusIcon } from "./icons";
import { Login } from "./Login";
import { NewProject } from "./NewProject";
import { Settings } from "./Settings";
import { setNight } from "./theme";

/** 用地址栏的 hash 做路由，手机上的返回手势也能用。 */
type Route =
  | { readonly kind: "home" }
  | { readonly kind: "chat" }
  | { readonly kind: "projects" }
  | { readonly kind: "project"; readonly id: string };

type Section = "home" | "chat" | "projects";

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
 * 手机（窄于 1024）：顶部三段切换，中间一段是 Pupu，长按换大家和私聊。项目页左上角 ≡ 打开整页项目列表，
 * 三段下方的小胶囊写项目名。
 * 宽屏（电脑 App 的窗口、电脑浏览器）：左侧栏放主页、大家、私聊和全部项目，不要顶部三段和胶囊。
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
    reports,
    chats,
    loaded,
    error,
    unauthorized,
    refresh
  } = usePupuState();
  const [listOpen, setListOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const section = sectionOf(route);
  const lines = useChatLines(chats, route.kind === "chat");
  const { line, session, canSwitch } = lines;
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
      members,
      reports: route.kind === "chat" ? reports.filter((card) => card.chat === session) : undefined,
      onOpenProject: (id) => go({ kind: "project", id }),
      onProjectsChanged: () => void refresh(),
      onActivity: applyActivity
    }),
    [projects, computers, approvals, members, reports, session, refresh, applyActivity, go, route.kind]
  );

  // 夜空是私聊的记号：主页的输入栏发到私聊时也是；项目是公开的，不用。
  const night = line === "private" && section !== "projects" && !unauthorized;
  useEffect(() => {
    setNight(night);
  }, [night]);

  useEffect(() => {
    if (section !== "projects") setListOpen(false);
  }, [section]);

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

  // 打开了项目，它报回聊天的结果都算看过；人在项目里时新报回来的也是。
  const unseenHere = Boolean(project && reports.some((card) => card.projectId === project.id && !card.seen));
  const projectId = project?.id;
  useEffect(() => {
    if (!projectId || !unseenHere) return;
    api.markProjectSeen(projectId).then(refresh, () => {});
  }, [projectId, unseenHere, refresh]);

  const clearPending = useCallback(() => setPendingChat(null), []);

  if (unauthorized) return <Login />;

  const openLine = (key: LineKey) => {
    lines.pick(key);
    go({ kind: "chat" });
  };
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
        onOpenAllProjects={() => {
          setListOpen(true);
          go({ kind: "projects" });
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onTakeback={async (id) => {
          await api.takeback(id);
          await refresh();
        }}
        onSend={(text) => {
          setPendingChat(text);
          go({ kind: "chat" });
        }}
        placeholder={LINE_HINTS[line]}
      />
    );
  } else if (route.kind === "chat") {
    body = (
      <Chat
        key={session}
        session={session}
        context={chat}
        placeholder={LINE_HINTS[line]}
        pending={pendingChat}
        onPendingSent={clearPending}
        empty={
          <div className="flex flex-col gap-2 text-center text-ink-sky">
            <div className="text-greeting">我是 Pupu</div>
            {line === "main" ? (
              <div className="text-message">
                这是大家和我的聊天，会一直接着聊下去。
                <br />
                小事我直接办，要持续推进的事放进项目里。
              </div>
            ) : (
              <div className="text-message">
                这里只有你和我，别人看不到。
                <br />
                要转到项目的时候，我先跟你说一声。
              </div>
            )}
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
        top={
          <span className="glass flex h-7 max-w-full items-center rounded-full px-3 text-footnote text-foreground lg:hidden">
            <span className="truncate">{project.name}</span>
          </span>
        }
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
    route.kind === "home" ? "主页" : route.kind === "chat" ? LINE_NAMES[line] : (project?.name ?? "项目");

  return (
    <div className="flex h-dvh">
      <div className="sky" />
      <Sidebar
        route={route}
        projects={projects}
        current={project?.id}
        line={line}
        canSwitch={canSwitch}
        unread={lines.unread}
        onOpenLine={openLine}
        onGo={go}
        onCreate={() => setCreating(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        thisComputer={thisComputer}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-10 shrink-0 pt-[max(env(safe-area-inset-top),8px)] lg:pt-0">
          <div className="flex h-11 items-center justify-between px-4 lg:hidden">
            {section === "projects" ? (
              <button
                type="button"
                aria-label="全部项目"
                aria-expanded={listOpen}
                onClick={() => setListOpen((open) => !open)}
                className="glass grid size-11 place-items-center rounded-full text-[20px]"
              >
                <MenuIcon />
              </button>
            ) : (
              <div className="size-11" />
            )}
            <SectionSwitch
              section={section}
              onSection={goSection}
              line={line}
              canSwitch={canSwitch}
              unread={lines.unread}
              onOpenLine={openLine}
            />
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
        <main className="relative min-h-0 flex-1">
          {body}
          {listOpen && (
            <ProjectList
              projects={projects}
              current={project?.id}
              onOpen={(id) => {
                setListOpen(false);
                go({ kind: "project", id });
              }}
              onCreate={() => {
                setListOpen(false);
                setCreating(true);
              }}
            />
          )}
        </main>
      </div>

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

/** 顶部三段。中间一段是 Pupu：写着当前那条聊天，长按或右键换大家和私聊。 */
function SectionSwitch({
  section,
  onSection,
  line,
  canSwitch,
  unread,
  onOpenLine
}: {
  section: Section;
  onSection: (section: Section) => void;
  line: LineKey;
  canSwitch: boolean;
  unread: Record<LineKey, boolean>;
  onOpenLine: (line: LineKey) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const press = usePressMenu((target) => {
    anchor.current = target;
    setMenuOpen(true);
  });
  const fresh = (["main", "private"] as const).filter((key) => unread[key]);
  const segment =
    "h-9 rounded-full px-0 text-subheadline text-foreground data-[selected=true]:text-background";
  const indicator = <Tabs.Indicator className="rounded-full bg-foreground" />;

  return (
    <>
      <Tabs selectedKey={section} onSelectionChange={(key) => onSection(key as Section)}>
        <Tabs.ListContainer>
          <Tabs.List aria-label="Pupu" className="glass h-11 rounded-full p-1">
            <Tabs.Tab id="home" className={`${segment} w-16 min-w-16 font-medium`}>
              主页
              {indicator}
            </Tabs.Tab>
            <Tabs.Tab
              id="chat"
              aria-label={[LINE_NAMES[line], ...fresh.map((key) => `${LINE_NAMES[key]}有新消息`)].join("，")}
              className={`${segment} font-semibold`}
            >
              <span {...(canSwitch ? press : {})} className="pressable relative flex h-9 items-center gap-1.5 pr-3 pl-1.5">
                <img src="/pupu-avatar.png" alt="" className="size-6.5 rounded-full [image-rendering:pixelated]" />
                {LINE_NAMES[line]}
                {fresh.length > 0 && (
                  <span className="absolute top-0.5 left-6 size-2.5 rounded-full bg-danger outline-2 outline-background" />
                )}
              </span>
              {indicator}
            </Tabs.Tab>
            <Tabs.Tab id="projects" className={`${segment} w-16 min-w-16 font-medium`}>
              项目
              {indicator}
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
      <Dropdown isOpen={menuOpen} onOpenChange={setMenuOpen}>
        <Dropdown.Popover triggerRef={anchor} placement="bottom">
          <Dropdown.Menu
            aria-label="切换聊天"
            onAction={(key) => {
              setMenuOpen(false);
              onOpenLine(key as LineKey);
            }}
          >
            {(["main", "private"] as const).map((key) => (
              <Dropdown.Item key={key} id={key} textValue={LINE_NAMES[key]}>
                <Label>{LINE_NAMES[key]}</Label>
                {key === line && <CheckIcon className="ml-auto" />}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </>
  );
}

/** 宽屏的左侧栏：主页、大家、私聊、全部项目；底下是这台电脑（只在电脑 App 里）和设置。 */
function Sidebar({
  route,
  projects,
  current,
  line,
  canSwitch,
  unread,
  onOpenLine,
  onGo,
  onCreate,
  onOpenSettings,
  thisComputer
}: {
  route: Route;
  projects: readonly Project[];
  current: string | undefined;
  line: LineKey;
  canSwitch: boolean;
  unread: Record<LineKey, boolean>;
  onOpenLine: (line: LineKey) => void;
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
      <NavItem
        icon={<ChatIcon />}
        current={route.kind === "chat" && line === "main"}
        unread={unread.main}
        onPress={() => onOpenLine("main")}
      >
        {LINE_NAMES.main}
      </NavItem>
      {canSwitch && (
        <NavItem
          icon={<LockIcon />}
          current={route.kind === "chat" && line === "private"}
          unread={unread.private}
          onPress={() => onOpenLine("private")}
        >
          {LINE_NAMES.private}
        </NavItem>
      )}
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
  unread = false,
  onPress,
  children
}: {
  icon?: ReactNode;
  current?: boolean;
  unread?: boolean;
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
      {unread && <span role="img" aria-label="有新消息" className="mr-1 size-2.5 shrink-0 rounded-full bg-danger" />}
    </button>
  );
}

/** 手机上切换项目：盖住内容区的整页列表，顶栏留在上面。第一行「新项目」，下面是全部项目，最近活动的在前。 */
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
  const row = "flex h-13 w-full items-center px-4 text-left text-body text-foreground active:bg-foreground/10";
  return (
    <nav
      aria-label="全部项目"
      className="fade-in absolute inset-0 z-40 overflow-y-auto bg-surface-strong backdrop-blur-[28px] lg:hidden"
    >
      <button type="button" onClick={onCreate} className={row}>
        新项目
      </button>
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          onClick={() => onOpen(project.id)}
          aria-current={project.id === current ? "page" : undefined}
          className={`${row} ${project.id === current ? "font-semibold" : ""}`}
        >
          <span className="truncate">{project.name}</span>
        </button>
      ))}
    </nav>
  );
}
