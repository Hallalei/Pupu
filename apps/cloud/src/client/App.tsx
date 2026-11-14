import { Button, Dropdown, Label, Spinner, Tabs } from "@heroui/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { busyComputers, waitingProjects } from "../bridge/activity";
import type { ApprovalView } from "../bridge/approvals";
import { actorOf } from "../members";
import { MemberAvatar, PUPU_AVATAR } from "./Avatar";
import type { Project } from "../projects";
import { api, usePupuState } from "./api";
import { Approvals, WaitingChip } from "./Approvals";
import { BrowserTakeover } from "./BrowserTakeover";
import { Chat, usePressMenu, type ChatContext } from "./Chat";
import { LINE_HINTS, LINE_NAMES, useChatLines, type LineKey } from "./chat-lines";
import { Docs } from "./Docs";
import { Doing } from "./Doing";
import { CheckIcon, ChevronLeftIcon, CloseIcon, MenuIcon, PlusIcon } from "./icons";
import { ChildDot, childLabel, InviteSheet, ownsSpace, SpaceHeader, SpaceList } from "./Spaces";
import type { ChildView, ProjectView } from "../server";
import { Login } from "./Login";
import { NewProject } from "./NewProject";
import { confirmWhere, type ConfirmWhere } from "./passkey";
import { Settings, type SettingsPage } from "./Settings";
import { RemoteDesktopLayer } from "./RemoteDesktop";
import { setNight } from "./theme";

/** 用地址栏的 hash 做路由，手机上的返回手势也能用。 */
type Route =
  | { readonly kind: "chat" }
  | { readonly kind: "projects" }
  | { readonly kind: "docs"; readonly id?: string }
  | { readonly kind: "project"; readonly id: string; readonly child?: string };

type Section = "chat" | "projects";

function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const child = path.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)$/);
  if (child) return { kind: "project", id: decodeURIComponent(child[1]), child: decodeURIComponent(child[2]) };
  const project = path.match(/^\/projects\/(.+)$/);
  if (project) return { kind: "project", id: decodeURIComponent(project[1]) };
  if (path === "/projects") return { kind: "projects" };
  const doc = path.match(/^\/docs(?:\/(.+))?$/);
  if (doc) return { kind: "docs", id: doc[1] ? decodeURIComponent(doc[1]) : undefined };
  return { kind: "chat" };
}

function hashOf(route: Route): string {
  switch (route.kind) {
    case "chat":
      return "#/";
    case "projects":
      return "#/projects";
    case "docs":
      return route.id ? `#/docs/${encodeURIComponent(route.id)}` : "#/docs";
    case "project":
      return route.child
        ? `#/projects/${encodeURIComponent(route.id)}/tasks/${encodeURIComponent(route.child)}`
        : `#/projects/${encodeURIComponent(route.id)}`;
  }
}

function sectionOf(route: Route): Section {
  return route.kind === "project" || route.kind === "docs" ? "projects" : route.kind;
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

/** 宽屏（侧栏常驻，子会话开在右边）。和 Tailwind 的 lg 一样是 1024。 */
function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const query = matchMedia("(min-width: 1024px)");
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
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
    pupuAvatar,
    model,
    loaded,
    error,
    unauthorized,
    refresh
  } = usePupuState();
  const [listOpen, setListOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const wide = useWide();
  const [settings, setSettings] = useState<SettingsPage | null>(null);
  const section = sectionOf(route);
  const lines = useChatLines(chats, route.kind === "chat");
  const { line, session, canSwitch } = lines;
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
      children: new Map(projects.flatMap((space) => space.children.map((child) => [child.session, child] as const))),
      onOpenChild: (session) => {
        const space = projects.find((item) => item.children.some((child) => child.session === session));
        if (space) go({ kind: "project", id: space.id, child: session });
      },
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

  const project = route.kind === "project" ? projects.find((item) => item.id === route.id) : undefined;
  const child = route.kind === "project" && route.child ? project?.children.find((item) => item.session === route.child) : undefined;
  const me = members.find((member) => member.current);
  const inviteSpace = projects.find((item) => item.id === inviting && item.id === project?.id);
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
  /** 「我的 Pupu」是自己的私聊；没有成员身份（本机开发没登录）时只有大家。 */
  const openPupu = () => {
    setListOpen(false);
    openLine(chats.private ? "private" : "main");
  };
  const spaceList = (inWide: boolean) => (
    <SpaceList
      spaces={projects}
      members={members}
      waiting={waiting}
      current={project?.id}
      currentChild={child?.session}
      pupuAvatar={pupuAvatar}
      onPupu={openPupu}
      docs={route.kind === "docs"}
      onDocs={() => {
        setListOpen(false);
        go({ kind: "docs" });
      }}
      onOpen={(id) => {
        setListOpen(false);
        go({ kind: "project", id });
      }}
      onOpenChild={(id, session) => {
        setListOpen(false);
        go({ kind: "project", id, child: session });
      }}
      onCreate={() => {
        setListOpen(false);
        setCreating(true);
      }}
      wide={inWide}
    />
  );
  const childChat = (space: ProjectView, item: ChildView, top?: ReactNode) => (
    <Chat
      key={item.session}
      session={item.session}
      context={{ ...chat, handoffFrom: `从「${space.name}」派来` }}
      placeholder="接着说这件事"
      top={top}
      empty={<div className="text-message text-ink-sky">{item.title}</div>}
    />
  );
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
  } else if (route.kind === "docs") {
    body = <Docs version={projects} open={route.id} onOpen={(id) => go({ kind: "docs", id })} />;
  } else if (project && child && !wide) {
    body = childChat(
      project,
      child,
      <span className="glass flex h-8 max-w-full items-center gap-2 rounded-full px-3 text-footnote text-foreground">
        <span className="truncate font-semibold">{child.title}</span>
        <ChildDot child={child} />
        <span className="shrink-0 text-muted">{childLabel(child)}</span>
      </span>
    );
  } else if (project) {
    body = (
      <Chat
        key={project.session}
        session={project.session}
        context={chat}
        placeholder={`在「${project.name}」里说`}
        top={<SpaceHeader space={project} members={members} mine={ownsSpace(project, me)} onMembers={() => setInviting(project.id)} />}
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
              新空间
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
      <RemoteDesktopLayer computers={computers} memberId={current?.memberId} confirmBy={confirmBy} passkeys={passkeys} />
      <aside className="sidebar glass relative z-10 m-3 mr-0 hidden w-66 shrink-0 flex-col overflow-hidden rounded-panel lg:flex">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">{spaceList(true)}</div>
      </aside>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="relative z-10 shrink-0 pt-[max(env(safe-area-inset-top),8px)]">
          <div className="titlebar-lead flex h-bar items-center justify-between px-4">
            {/* 宽屏的项目列表在左侧栏，≡ 不要了，位置留着让切换居中。 */}
            {project && child && !wide ? (
              <button
                type="button"
                aria-label={`回到「${project.name}」`}
                onClick={() => go({ kind: "project", id: project.id })}
                className="glass lift tap grid size-bar place-items-center rounded-full text-[20px]"
              >
                <ChevronLeftIcon />
              </button>
            ) : section === "projects" ? (
              <button
                type="button"
                aria-label="全部空间"
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
              avatar={pupuAvatar}
            />
            <button
              type="button"
              aria-label="设置"
              onClick={() => setSettings("root")}
              className="glass lift tap grid size-bar place-items-center rounded-full text-subheadline font-semibold"
            >
              <MemberAvatar
                name="我"
                src={members.find((member) => member.current)?.avatar ?? null}
                className="size-[calc(100%-4px)]"
              />
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
              onOpen={(activity) => {
                if (activity.project) go({ kind: "project", id: activity.project.id });
                else if (!showComputerCard(activity.computerId)) setSettings({ computer: activity.computerId });
              }}
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
            <div className="fade-in absolute inset-0 z-40 overflow-y-auto bg-surface-strong py-2 backdrop-blur-[28px] lg:hidden">
              {spaceList(false)}
            </div>
          )}
        </main>
      </div>
      {project && child && wide && (
        <aside
          aria-label="子会话"
          className="glass relative z-10 m-3 ml-0 flex w-105 shrink-0 flex-col overflow-hidden rounded-panel"
        >
          <header className="flex shrink-0 items-center gap-2 py-3 pr-3 pl-5">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-body font-semibold">{child.title}</span>
              <span className="flex items-center gap-1.5 text-caption text-muted">
                <ChildDot child={child} />
                {childLabel(child)}
              </span>
            </span>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => go({ kind: "project", id: project.id })}
              className="tap grid size-8 place-items-center rounded-full hover:bg-foreground/6"
            >
              <CloseIcon />
            </button>
          </header>
          <div className="relative min-h-0 flex-1">{childChat(project, child)}</div>
        </aside>
      )}
      <InviteSheet
        space={inviteSpace}
        members={members}
        mine={inviteSpace ? ownsSpace(inviteSpace, me) : false}
        onClose={() => setInviting(null)}
        onChange={async (change) => {
          if (!inviteSpace) return;
          await api.changeSpace(inviteSpace.id, change);
          await refresh();
        }}
      />

      <Settings
        page={settings}
        onPage={setSettings}
        connectors={connectors}
        onRemoveConnector={async (id) => {
          await api.removeConnector(id);
          await refresh();
        }}
        computers={computers}
        model={model}
        onModelSaved={refresh}
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
        pupuAvatar={pupuAvatar}
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
          // 本机开发没登录时建不了私有空间，退回老的全组织项目。
          const created = me ? await api.createSpace(name, goal) : await api.createProject(name, goal);
          await refresh();
          go({ kind: "project", id: created.id });
        }}
      />
    </div>
  );
}

/** 把对话里这台电脑最近的那张任务卡滚到眼前，闪一下。对话里没有这张卡就返回 false。 */
function showComputerCard(computerId: string): boolean {
  const cards = document.querySelectorAll<HTMLElement>(`[data-computer-card="${CSS.escape(computerId)}"]`);
  const card = cards[cards.length - 1];
  if (!card) return false;
  card.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  card.animate([{ outline: "2px solid var(--color-foreground)" }, { outline: "2px solid transparent" }], { duration: 1200 });
  return true;
}

/** 顶部切换。聊天那段是 Pupu：写着当前那条聊天，长按、右键或在已选中时再点一下，换大家和私聊。 */
function SectionSwitch({
  section,
  onSection,
  line,
  canSwitch,
  unread,
  onOpenLine,
  avatar
}: {
  section: Section;
  onSection: (section: Section) => void;
  line: LineKey;
  canSwitch: boolean;
  unread: Record<LineKey, boolean>;
  onOpenLine: (line: LineKey) => void;
  /** Pupu 换过的头像，没换过是 null。 */
  avatar: string | null;
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
                <MemberAvatar name="Pupu" src={avatar ?? PUPU_AVATAR} className="size-6.5 pointer-fine:size-6" />
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
