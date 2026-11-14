import { Button, Spinner, Tabs } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { busyComputers, waitingProjects } from "../bridge/activity";
import type { ApprovalView } from "../bridge/approvals";
import { actorOf } from "../members";
import { MemberAvatar, PUPU_AVATAR } from "./Avatar";
import { EVERYONE_ID } from "../projects";
import { api, usePupuState } from "./api";
import { Approvals, WaitingChip } from "./Approvals";
import { BrowserTakeover } from "./BrowserTakeover";
import { Chat, type ChatContext } from "./Chat";
import { EVERYONE_HINT, PRIVATE_HINT, useChatLines } from "./chat-lines";
import { Docs } from "./Docs";
import { Doing } from "./Doing";
import { ChevronLeftIcon, CloseIcon, MenuIcon, PlusIcon } from "./icons";
import { ChildDot, childLabel, EveryoneHeader, EveryoneSheet, InviteSheet, ownsSpace, SpaceHeader, SpaceList } from "./Spaces";
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
 * 和 iOS 同一个结构：顶栏中间切换聊天和项目，聊天那段是「我的 Pupu」，自己的私聊；全员在空间列表第一个。
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
    everyone,
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
  const [everyoneSettings, setEveryoneSettings] = useState(false);
  const wide = useWide();
  const [settings, setSettings] = useState<SettingsPage | null>(null);
  const section = sectionOf(route);
  // 全员空间就是原来的主会话（root）。路由里是 `#/projects/everyone`。
  const project =
    route.kind === "project"
      ? route.id === EVERYONE_ID
        ? (everyone ?? undefined)
        : projects.find((item) => item.id === route.id)
      : undefined;
  const inEveryone = project !== undefined && project.id === EVERYONE_ID;
  const lines = useChatLines(chats, route.kind === "chat" ? (chats.private ?? chats.main).session : inEveryone && route.kind === "project" && !route.child ? project.session : null);
  // 聊天页显示的那条：自己的私聊，本机开发没登录时是全员那条。
  const session = lines.own;
  const allSpaces = useMemo(() => (everyone ? [everyone, ...projects] : projects), [everyone, projects]);
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
      projectTags: route.kind === "chat" || inEveryone,
      computers,
      approvals,
      members,
      reports:
        route.kind === "chat"
          ? reports.filter((card) => card.chat === session)
          : inEveryone
            ? reports.filter((card) => card.chat === project.session)
            : undefined,
      onOpenProject: (id) => go({ kind: "project", id }),
      children: new Map(allSpaces.flatMap((space) => space.children.map((child) => [child.session, child] as const))),
      onOpenChild: (session) => {
        const space = allSpaces.find((item) => item.children.some((child) => child.session === session));
        if (space) go({ kind: "project", id: space.id, child: session });
      },
      onProjectsChanged: () => void refresh(),
      onActivity: applyActivity
    }),
    [projects, allSpaces, computers, approvals, members, reports, session, refresh, applyActivity, go, route.kind, inEveryone, project?.session]
  );

  // App 里跟着系统的浅色深色；只有登录页（品牌层）铺夜空，衬着左边的大图。
  useEffect(() => {
    setNight(unauthorized);
  }, [unauthorized]);

  useEffect(() => {
    if (section !== "projects") setListOpen(false);
  }, [section]);
  useEffect(() => {
    if (!inEveryone) setEveryoneSettings(false);
  }, [inEveryone]);

  // 「项目」没指定是哪个：回到上次那个，没有就打开最近活跃的。
  useEffect(() => {
    if (route.kind !== "projects" || !loaded) return;
    const last = lastProject();
    const target = allSpaces.find((space) => space.id === last) ?? projects[0] ?? everyone;
    if (target) go({ kind: "project", id: target.id });
  }, [route.kind, loaded, allSpaces, projects, everyone, go]);

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

  /** 「我的 Pupu」是自己的私聊；没有成员身份（本机开发没登录）时是全员那条。 */
  const openPupu = () => {
    setListOpen(false);
    go({ kind: "chat" });
  };
  const spaceList = (inWide: boolean) => (
    <SpaceList
      spaces={projects}
      everyone={everyone}
      everyoneUnread={lines.unread.everyone}
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
      empty={<div className="text-message text-ink">{item.title}</div>}
    />
  );
  const waiting = waitingProjects(activity);
  // 停在审批上的电脑，审批卡就在正上方，同一件事不写两遍。屏幕控制开着的留着，「收回」在这一行上。
  const doing = busyComputers(activity).filter(
    (row) => row.screen || row.state !== "waiting" || !approvals.some((item) => item.computerId === row.computerId)
  );

  let body;
  if (route.kind === "chat" && !loaded) {
    // 还不知道有没有私聊：先别开会话，免得落到全员那条，发出去全组织都看得到。
    body = (
      <div className="grid h-full place-items-center">
        <Spinner size="sm" aria-label="正在打开" />
      </div>
    );
  } else if (route.kind === "chat") {
    body = (
      <Chat
        key={session}
        session={session}
        context={chat}
        placeholder={lines.isPrivate ? PRIVATE_HINT : EVERYONE_HINT}
        empty={
          <div className="flex flex-col gap-2 text-center text-ink">
            <div className="text-greeting">我是 Pupu</div>
            {lines.isPrivate && <div className="text-message">这里只有你和我，别人看不到。</div>}
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
      <span className="bg-surface-inset flex h-8 max-w-full items-center gap-2 rounded-full px-3 text-footnote text-ink">
        <span className="truncate font-semibold">{child.title}</span>
        <ChildDot child={child} />
        <span className="shrink-0 text-ink-muted">{childLabel(child)}</span>
      </span>
    );
  } else if (project && inEveryone) {
    body = (
      <Chat
        key={project.session}
        session={project.session}
        context={chat}
        placeholder={EVERYONE_HINT}
        top={<EveryoneHeader space={project} mayManage={everyone?.mayManage ?? false} onSettings={() => setEveryoneSettings(true)} />}
        empty={<div className="text-greeting text-ink">{project.name}</div>}
      />
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
          <div className="flex max-w-md flex-col gap-2 text-center text-ink">
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
            {route.kind === "project" && <div className="text-message text-ink">找不到这个项目</div>}
            <Button
              variant="ghost"
              onPress={() => setCreating(true)}
              className="bg-surface-inset tap h-control rounded-full px-4 text-body font-semibold text-ink"
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
      <div className="window-drag" />
      <BrowserTakeover />
      <RemoteDesktopLayer computers={computers} memberId={current?.memberId} confirmBy={confirmBy} passkeys={passkeys} />
      <aside className="sidebar bg-surface-inset relative z-10 m-3 mr-0 hidden w-66 shrink-0 flex-col overflow-hidden rounded-row lg:flex">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">{spaceList(true)}</div>
      </aside>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="relative z-10 shrink-0 pt-[max(env(safe-area-inset-top),8px)]">
          <div className="titlebar-lead flex h-control items-center justify-between px-4">
            {/* 宽屏的项目列表在左侧栏，≡ 不要了，位置留着让切换居中。 */}
            {project && child && !wide ? (
              <button
                type="button"
                aria-label={`回到「${project.name}」`}
                onClick={() => go({ kind: "project", id: project.id })}
                className="bg-surface-inset tap grid size-control place-items-center rounded-full text-[20px]"
              >
                <ChevronLeftIcon />
              </button>
            ) : section === "projects" ? (
              <button
                type="button"
                aria-label="全部空间"
                aria-expanded={listOpen}
                onClick={() => setListOpen((open) => !open)}
                className="bg-surface-inset tap relative grid size-control place-items-center rounded-full text-[20px] lg:invisible"
              >
                <MenuIcon />
                {lines.unread.everyone && !inEveryone && (
                  <span className="absolute top-1.5 right-1.5 size-2.5 rounded-full bg-danger outline-2 outline-surface" />
                )}
              </button>
            ) : (
              <div className="size-control" />
            )}
            <SectionSwitch
              section={section}
              onSection={(kind) => go({ kind })}
              unread={lines.unread.own}
              everyoneUnread={lines.unread.everyone && section === "chat"}
              avatar={pupuAvatar}
            />
            <button
              type="button"
              aria-label="设置"
              onClick={() => setSettings("root")}
              className="bg-surface-inset tap grid size-control place-items-center rounded-full text-subheadline font-semibold"
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
            <div className="bg-surface-sheet shadow-card rounded-full px-3 py-1 text-caption text-danger-ink">{error}</div>
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
          {(route.kind === "chat" || (inEveryone && !child)) && (
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
            <div className="fade-in absolute inset-0 z-40 overflow-y-auto bg-surface py-2 lg:hidden">
              {spaceList(false)}
            </div>
          )}
        </main>
      </div>
      {project && child && wide && (
        <aside
          aria-label="子会话"
          className="bg-surface-inset relative z-10 m-3 ml-0 flex w-105 shrink-0 flex-col overflow-hidden rounded-row"
        >
          <header className="flex shrink-0 items-center gap-2 py-3 pr-3 pl-5">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-body font-semibold">{child.title}</span>
              <span className="flex items-center gap-1.5 text-caption text-ink-muted">
                <ChildDot child={child} />
                {childLabel(child)}
              </span>
            </span>
            <button
              type="button"
              aria-label="关闭"
              onClick={() => go({ kind: "project", id: project.id })}
              className="tap grid size-8 place-items-center rounded-full hover:bg-ink/6"
            >
              <CloseIcon />
            </button>
          </header>
          <div className="relative min-h-0 flex-1">{childChat(project, child)}</div>
        </aside>
      )}
      <EveryoneSheet
        space={everyoneSettings && inEveryone && everyone?.mayManage ? project : undefined}
        onClose={() => setEveryoneSettings(false)}
        onChange={async (mode) => {
          await api.changeSpace(EVERYONE_ID, { kind: "mode", mode });
          await refresh();
        }}
      />
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
        onSetRemoteConfirm={async (id, level) => {
          await api.setRemoteConfirm(id, level);
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

/** 顶部切换。聊天那段是「我的 Pupu」：自己的私聊。 */
function SectionSwitch({
  section,
  onSection,
  unread,
  everyoneUnread,
  avatar
}: {
  section: Section;
  onSection: (section: Section) => void;
  unread: boolean;
  /** 全员有新消息、人在聊天段：窄屏没有侧栏，红点挂在「项目」上。到了项目段改挂在 ≡ 上。 */
  everyoneUnread: boolean;
  /** Pupu 换过的头像，没换过是 null。 */
  avatar: string | null;
}) {
  const segment =
    "h-control-sm rounded-full px-0 text-subheadline text-ink data-[selected=true]:text-on-action";
  const indicator = <Tabs.Indicator className="rounded-full bg-action" />;

  return (
    <Tabs selectedKey={section} onSelectionChange={(key) => onSection(key as Section)}>
      <Tabs.ListContainer>
        <Tabs.List aria-label="Pupu" className="bg-surface-inset h-control rounded-full p-1">
          <Tabs.Tab id="chat" aria-label={unread ? "我的 Pupu，有新消息" : "我的 Pupu"} className={`${segment} font-semibold`}>
            <span className="relative flex h-control-sm items-center gap-1.5 pr-3 pl-1">
              <MemberAvatar name="Pupu" src={avatar ?? PUPU_AVATAR} className="size-6.5 pointer-fine:size-6" />
              Pupu
              {unread && <span className="absolute top-0.5 left-6 size-2.5 rounded-full bg-danger outline-2 outline-surface" />}
            </span>
            {indicator}
          </Tabs.Tab>
          <Tabs.Tab
            id="projects"
            aria-label={everyoneUnread ? "项目，全员有新消息" : "项目"}
            className={`${segment} relative w-16 min-w-16 font-medium pointer-fine:w-14 pointer-fine:min-w-14`}
          >
            项目
            {everyoneUnread && <span className="absolute top-0.5 right-0.5 size-2.5 rounded-full bg-danger outline-2 outline-surface lg:hidden" />}
            {indicator}
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}
