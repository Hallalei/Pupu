import { Button, Dropdown, Label, Spinner, Tabs } from "@heroui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { busyComputers, waitingProjects } from "../bridge/activity";
import type { ApprovalView } from "../bridge/approvals";
import { actorOf } from "../members";
import type { Project } from "../projects";
import { api, usePupuState } from "./api";
import { Approvals, WaitingChip } from "./Approvals";
import { BrowserTakeover } from "./BrowserTakeover";
import { Chat, usePressMenu, type ChatContext } from "./Chat";
import { LINE_HINTS, LINE_NAMES, useChatLines, type LineKey } from "./chat-lines";
import { useDesktopComputer } from "./desktop";
import { Doing } from "./Doing";
import { CheckIcon, MenuIcon, PlusIcon } from "./icons";
import { Login } from "./Login";
import { NewProject } from "./NewProject";
import { confirmWhere, type ConfirmWhere } from "./passkey";
import { Settings, type SettingsPage } from "./Settings";
import { setNight } from "./theme";

/** 用地址栏的 hash 做路由，手机上的返回手势也能用。 */
type Route =
  | { readonly kind: "chat" }
  | { readonly kind: "projects" }
  | { readonly kind: "project"; readonly id: string };

type Section = "chat" | "projects";

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const project = path.match(/^\/projects\/(.+)$/);
  if (project) return { kind: "project", id: decodeURIComponent(project[1]) };
  if (path === "/projects") return { kind: "projects" };
  return { kind: "chat" };
}

function hashOf(route: Route): string {
  switch (route.kind) {
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
 * 和 iOS 同一个结构：顶栏中间切换聊天和项目，聊天那段是 Pupu，长按、右键或再点一下换大家和私聊；
 * 右边「我」打开设置。项目页顶上的小胶囊写项目名。
 * 窄于 1024：项目页左上角 ≡ 打开整页项目列表。宽屏（电脑 App 的窗口、电脑浏览器）：这页列表常驻在左边。
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
    connectors,
    applyActivity,
    reports,
    chats,
    passkeys,
    loaded,
    error,
    unauthorized,
    refresh
  } = usePupuState();
  const [listOpen, setListOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState<SettingsPage | null>(null);
  const section = sectionOf(route);
  const lines = useChatLines(chats, route.kind === "chat");
  const { line, session, canSwitch } = lines;
  const thisComputer = useDesktopComputer();
  // 允许和放宽权限要电脑主人亲手确认。本机开发没设访问口令时没有「这台设备」，照常能点。
  const current = devices.find((device) => device.current);
  const confirmBy = confirmWhere(current?.kind ?? null, passkeys);
  // 通行密钥只证明是哪个成员：新手机登录、别人的电脑、没主人的电脑，还是要手机。
  const approvalWhere = useCallback(
    (approval: ApprovalView): ConfirmWhere => {
      if (confirmBy === "here" || confirmBy === "phone") return confirmBy;
      const owner =
        approval.kind === "sign_in" ? null : (computers.find((computer) => computer.id === approval.computerId)?.ownerId ?? null);
      return owner !== null && owner === current?.memberId ? confirmBy : "phone";
    },
    [confirmBy, computers, current?.memberId]
  );

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

  // 夜空是私聊的记号；项目是公开的，不用。登录页也是夜空，衬着左边的大图。
  const night = unauthorized || (line === "private" && route.kind === "chat");
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

  if (unauthorized) return <Login />;

  const openLine = (key: LineKey) => {
    lines.pick(key);
    go({ kind: "chat" });
  };
  const waiting = waitingProjects(activity);
  // 停在审批上的电脑，审批卡就在正上方，同一件事不写两遍。屏幕控制开着的留着，「收回」在这一行上。
  const doing = busyComputers(activity).filter(
    (row) => row.screen || row.state !== "waiting" || !approvals.some((item) => item.computerId === row.computerId)
  );

  let body;
  if (route.kind === "chat") {
    body = (
      <Chat
        key={session}
        session={session}
        context={chat}
        placeholder={LINE_HINTS[line]}
        empty={
          <div className="flex flex-col gap-2 text-center text-ink-sky">
            <div className="text-greeting">我是 Pupu</div>
            {line === "private" && <div className="text-message">这里只有你和我，别人看不到。</div>}
          </div>
        }
        starters={["我想做一个新功能，帮我理一理", "帮我规划一下这周要做的事"]}
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
          <span className="glass flex h-7 max-w-full items-center rounded-full px-3 text-footnote text-foreground">
            <span className="truncate">{project.name}</span>
          </span>
        }
        empty={
          <div className="flex max-w-md flex-col gap-2 text-center text-ink-sky">
            <div className="text-greeting">{project.name}</div>
            {project.goal && <div className="text-message">{project.goal}</div>}
          </div>
        }
      />
    );
  } else {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
        {!loaded ? (
          <Spinner size="sm" aria-label="正在打开" />
        ) : (
          <>
            {route.kind === "project" && <div className="text-message text-ink-sky">找不到这个项目</div>}
            <Button
              variant="ghost"
              onPress={() => setCreating(true)}
              className="glass lift tap h-control rounded-full px-4 text-body font-semibold text-foreground"
            >
              <PlusIcon />
              新项目
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-dvh">
      <div className="sky" />
      <div className="window-drag" />
      <BrowserTakeover />
      <Sidebar
        projects={projects}
        waiting={waiting}
        current={project?.id}
        onOpen={(id) => go({ kind: "project", id })}
        onCreate={() => setCreating(true)}
        thisComputer={thisComputer}
        onOpenThisComputer={() => setSettings("this")}
      />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="relative z-10 shrink-0 pt-[max(env(safe-area-inset-top),8px)]">
          <div className="titlebar-lead flex h-bar items-center justify-between px-4">
            {/* 宽屏的项目列表在左侧栏，≡ 不要了，位置留着让切换居中。 */}
            {section === "projects" ? (
              <button
                type="button"
                aria-label="全部项目"
                aria-expanded={listOpen}
                onClick={() => setListOpen((open) => !open)}
                className="glass lift tap grid size-bar place-items-center rounded-full text-[20px] lg:invisible"
              >
                <MenuIcon />
              </button>
            ) : (
              <div className="size-bar" />
            )}
            <SectionSwitch
              section={section}
              onSection={(kind) => go({ kind })}
              line={line}
              canSwitch={canSwitch}
              unread={lines.unread}
              onOpenLine={openLine}
            />
            <button
              type="button"
              aria-label="设置"
              onClick={() => setSettings("root")}
              className="glass lift tap grid size-bar place-items-center rounded-full text-subheadline font-semibold"
            >
              我
            </button>
          </div>
          <div className="h-2" />
        </header>
        {error && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">
            <div className="strong bubble rounded-full px-3 py-1 text-caption text-danger-ink">{error}</div>
          </div>
        )}
        <div className="status relative z-10 flex shrink-0 flex-col">
          <Approvals
            approvals={approvals}
            where={approvalWhere}
            passkeys={passkeys}
            phonePaired={devices.some((device) => device.kind === "phone")}
            onDecide={async (id, decision, proof) => {
              await api.decideApproval(id, decision, proof);
              await refresh();
            }}
          />
          {route.kind === "chat" && (
            <Doing
              rows={doing}
              onOpenProject={(id) => go({ kind: "project", id })}
              onTakeback={async (id) => {
                await api.takeback(id);
                await refresh();
              }}
            />
          )}
        </div>
        <main className="relative min-h-0 flex-1">
          {body}
          {listOpen && (
            <ProjectList
              projects={projects}
              waiting={waiting}
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
        page={settings}
        onPage={setSettings}
        connectors={connectors}
        onRemoveConnector={async (id) => {
          await api.removeConnector(id);
          await refresh();
        }}
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
        onInviteMember={async (email, proof) => {
          await api.inviteMember(email, proof);
          await refresh();
        }}
        confirmBy={confirmBy}
        passkeys={passkeys}
        onPasskeysChanged={refresh}
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

/** 顶部切换。聊天那段是 Pupu：写着当前那条聊天，长按、右键或在已选中时再点一下，换大家和私聊。 */
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
    "h-bar-inner rounded-full px-0 text-subheadline text-foreground data-[selected=true]:text-background";
  const indicator = <Tabs.Indicator className="rounded-full bg-foreground" />;

  return (
    <>
      <Tabs selectedKey={section} onSelectionChange={(key) => onSection(key as Section)}>
        <Tabs.ListContainer>
          <Tabs.List aria-label="Pupu" className="glass h-bar rounded-full p-1">
            <Tabs.Tab
              id="chat"
              aria-label={[LINE_NAMES[line], ...fresh.map((key) => `${LINE_NAMES[key]}有新消息`)].join("，")}
              className={`${segment} font-semibold`}
            >
              <span
                {...(canSwitch ? press : {})}
                onClick={(event) => {
                  // 电脑上没有长按：已经在聊天时再点一下也打开菜单。
                  if (canSwitch && section === "chat") press.onContextMenu(event);
                }}
                className="pressable relative flex h-bar-inner items-center gap-1.5 pr-3 pl-1"
              >
                <img
                  src="/pupu-avatar.png"
                  alt=""
                  className="size-6.5 rounded-full [image-rendering:pixelated] pointer-fine:size-6"
                />
                {LINE_NAMES[line]}
                {fresh.length > 0 && (
                  <span className="absolute top-0.5 left-6 size-2.5 rounded-full bg-danger outline-2 outline-background" />
                )}
              </span>
              {indicator}
            </Tabs.Tab>
            <Tabs.Tab id="projects" className={`${segment} w-16 min-w-16 font-medium pointer-fine:w-14 pointer-fine:min-w-14`}>
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

/**
 * 宽屏的左侧栏：就是窄窗口里 ≡ 打开的那页项目列表，常驻在左边。第一行「新项目」，下面是全部项目，最近活动的在前。
 * 导航属于控件层，用和顶栏一样的玻璃。这台电脑没连上时，底下露一行，点开设置里的「这台电脑」。
 */
function Sidebar({
  projects,
  waiting,
  current,
  onOpen,
  onCreate,
  thisComputer,
  onOpenThisComputer
}: {
  projects: readonly Project[];
  waiting: ReadonlySet<string>;
  current: string | undefined;
  onOpen: (id: string) => void;
  onCreate: () => void;
  thisComputer: ReturnType<typeof useDesktopComputer>;
  onOpenThisComputer: () => void;
}) {
  const row = "flex min-h-control w-full shrink-0 items-center gap-2 rounded-tag px-3 py-1.5 text-left text-body";
  const trouble = thisComputer && (!thisComputer.paired || thisComputer.status === "offline");
  return (
    <aside className="sidebar glass relative z-10 m-3 mr-0 hidden w-66 shrink-0 flex-col overflow-hidden rounded-panel lg:flex">
      <nav aria-label="全部项目" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        <button type="button" onClick={onCreate} className={`${row} hover:bg-foreground/6`}>
          新项目
        </button>
        {projects.map((project) => {
          const selected = project.id === current;
          const detail = project.progress || project.goal;
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => onOpen(project.id)}
              aria-current={selected ? "page" : undefined}
              className={`${row} ${selected ? "bg-nav-current font-semibold" : "hover:bg-foreground/6"}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{project.name}</span>
                {detail && <span className="block truncate text-subheadline font-normal text-muted">{detail}</span>}
              </span>
              {waiting.has(project.id) && <WaitingChip />}
            </button>
          );
        })}
      </nav>
      {trouble && (
        <button
          type="button"
          onClick={onOpenThisComputer}
          className="m-2 mt-0 flex shrink-0 items-center gap-2 rounded-tag px-3 py-2 text-left text-subheadline text-muted hover:bg-foreground/6"
        >
          <span className="size-2 shrink-0 rounded-full bg-offline" aria-hidden="true" />
          {thisComputer.paired ? "这台电脑没连上 Pupu" : "这台电脑的授权被吊销了"}
        </button>
      )}
    </aside>
  );
}

/** 手机上切换项目：盖住内容区的整页列表，顶栏留在上面。第一行「新项目」，下面是全部项目，最近活动的在前。 */
function ProjectList({
  projects,
  waiting,
  current,
  onOpen,
  onCreate
}: {
  projects: readonly Project[];
  waiting: ReadonlySet<string>;
  current: string | undefined;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const row =
    "flex min-h-13 w-full items-center gap-3 px-4 py-2 text-left text-body text-foreground active:bg-foreground/10";
  return (
    <nav
      aria-label="全部项目"
      className="fade-in absolute inset-0 z-40 overflow-y-auto bg-surface-strong backdrop-blur-[28px] lg:hidden"
    >
      <button type="button" onClick={onCreate} className={row}>
        新项目
      </button>
      {projects.map((project) => {
        const detail = project.progress || project.goal;
        return (
          <button
            key={project.id}
            type="button"
            onClick={() => onOpen(project.id)}
            aria-current={project.id === current ? "page" : undefined}
            className={`${row} ${project.id === current ? "font-semibold" : ""}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{project.name}</span>
              {detail && <span className="block truncate text-subheadline font-normal text-muted">{detail}</span>}
            </span>
            {waiting.has(project.id) && <WaitingChip />}
          </button>
        );
      })}
    </nav>
  );
}
