import { Button, Spinner } from "@heroui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { busyComputers, type ComputerActivity } from "../bridge/activity";
import type { ApprovalView } from "../bridge/approvals";
import { actorOf } from "../members";
import { EVERYONE_ID } from "../projects";
import type { ChildView, ProjectView } from "../server";
import { api, usePupuState } from "./api";
import { Approvals } from "./Approvals";
import { BrowserTakeover } from "./BrowserTakeover";
import { Chat, type ChatContext } from "./Chat";
import { EVERYONE_HINT, PRIVATE_HINT, useChatLines } from "./chat-lines";
import { Docs } from "./Docs";
import { StatusStrip } from "./Doing";
import { CloseIcon, PlusIcon } from "./icons";
import { useWide } from "./layout";
import { Login } from "./Login";
import { NewProject } from "./NewProject";
import { confirmWhere, type ConfirmWhere } from "./passkey";
import { RemoteDesktopLayer } from "./RemoteDesktop";
import { Settings, type SettingsPage } from "./Settings";
import {
  BackButton,
  CardHead,
  CardMembers,
  ChildTitle,
  colorOf,
  MembersCapsule,
  ownsSpace,
  PlaceTitle,
  SpaceHeader,
  SpaceSettings,
  SpaceSidebar,
  SpaceSwitcher,
  SwitchButton,
  type Place
} from "./Spaces";
import { setFrame, setNight } from "./theme";

/** 用地址栏的 hash 做路由，手机上的返回手势也能用。 */
type Route =
  | { readonly kind: "chat" }
  | { readonly kind: "projects" }
  | { readonly kind: "docs"; readonly id?: string }
  | { readonly kind: "project"; readonly id: string; readonly child?: string };

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

/** 记住上次打开的空间，老地址 `#/projects` 直接回到它。浏览器存储可能不可用，失败就算了。 */
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
 * 照设计规范的三层：窗框（`canvas`，进了空间染空间色）、浮在上面的白卡片、卡片上面的 sheet。
 * 窄于 1024（手机和窄窗口）：窗框上是 SpaceHeader，下面一张卡；左上角切换按钮打开 SpaceSwitcher，
 * 设置从它最底下进。宽屏：窗框左边是 SpaceSidebar，右边主卡片；打开子会话时子会话卡并排开在右边。
 * 「我的 Pupu」是自己的私聊，全员是空间列表的第一个。
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
  const [switching, setSwitching] = useState(false);
  const [creating, setCreating] = useState(false);
  /** 开着设置的空间。只在人还在这个空间里时开着。 */
  const [spaceSettings, setSpaceSettings] = useState<string | null>(null);
  const wide = useWide();
  const [settings, setSettings] = useState<SettingsPage | null>(null);
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

  // 窗框跟着空间换色（0.3 秒渐变在样式表里）；「我的 Pupu」、资料不是空间，用 canvas。
  const frame = !unauthorized && project ? colorOf(project) : null;
  useEffect(() => {
    setFrame(frame);
  }, [frame]);

  useEffect(() => {
    if (wide) setSwitching(false);
  }, [wide]);
  // 离开空间就收起它的设置，回来时不自己弹出来。
  const here = route.kind === "project" ? route.id : null;
  useEffect(() => {
    setSpaceSettings(null);
  }, [here]);

  // 老地址「项目」没指定是哪个：回到上次那个，没有就打开最近活跃的。
  useEffect(() => {
    if (route.kind !== "projects" || !loaded) return;
    const last = lastProject();
    const target = allSpaces.find((space) => space.id === last) ?? projects[0] ?? everyone;
    if (target) go({ kind: "project", id: target.id });
  }, [route.kind, loaded, allSpaces, projects, everyone, go]);

  const child = route.kind === "project" && route.child ? project?.children.find((item) => item.session === route.child) : undefined;
  const me = members.find((member) => member.current);
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

  /** 这个人在这个空间能改什么：主人（全员是组织创建者）拉人、移人、改范围和模式，也换颜色和图标。 */
  const rights = (space: ProjectView) => {
    const mine = space.id === EVERYONE_ID ? (everyone?.mayManage ?? false) : ownsSpace(space, me);
    // 全员没有成员名单和范围，不是创建者就没什么可看的。
    return { mine, open: space.id !== EVERYONE_ID || mine };
  };
  const settingsTarget = project && spaceSettings === project.id ? project : undefined;

  const place: Place | null = route.kind === "chat" ? "pupu" : route.kind === "docs" ? "docs" : (project?.id ?? null);
  const nav = {
    spaces: allSpaces,
    members,
    me,
    pupuAvatar,
    current: place,
    unread: { pupu: lines.unread.own, spaces: new Set(lines.unread.everyone ? [EVERYONE_ID] : []) },
    onPupu: () => {
      setSwitching(false);
      go({ kind: "chat" });
    },
    onDocs: () => {
      setSwitching(false);
      go({ kind: "docs" });
    },
    onOpen: (id: string) => {
      setSwitching(false);
      go({ kind: "project", id });
    },
    onCreate: () => {
      setSwitching(false);
      setCreating(true);
    },
    onSettings: () => {
      setSwitching(false);
      setSettings("root");
    }
  };

  const childChat = (space: ProjectView, item: ChildView) => (
    <Chat
      key={item.session}
      session={item.session}
      context={{ ...chat, handoffFrom: `从「${space.name}」派来` }}
      placeholder="接着说这件事"
      empty={<div className="text-message text-ink">{item.title}</div>}
    />
  );
  // 停在审批上的电脑，审批卡就在正下方，同一件事不写两遍。屏幕控制开着的留着，「收回」在状态条上。
  const doing = busyComputers(activity).filter(
    (row) => row.screen || row.state !== "waiting" || !approvals.some((item) => item.computerId === row.computerId)
  );
  // 状态条在「我的 Pupu」和全员的主会话里；宽屏开着子会话时，全员的主会话还在主卡片上。
  const showStrip = route.kind === "chat" || (inEveryone && (!child || wide));
  const openActivity = (activity: ComputerActivity) => {
    if (activity.project) go({ kind: "project", id: activity.project.id });
    else if (!showComputerCard(activity.computerId)) setSettings({ computer: activity.computerId });
  };

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
    body = childChat(project, child);
  } else if (project && inEveryone) {
    body = (
      <Chat
        key={project.session}
        session={project.session}
        context={chat}
        placeholder={EVERYONE_HINT}
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
            {route.kind === "project" && <div className="text-message text-ink">找不到这个空间</div>}
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

  // 窗框上的顶栏（窄屏）和主卡片的头一行（宽屏）写的是同一个地方。
  const spaceRights = project ? rights(project) : null;
  const openSettings = project && spaceRights?.open ? () => setSpaceSettings(project.id) : undefined;
  const title =
    route.kind === "chat" ? (
      <PlaceTitle pupuAvatar={pupuAvatar} />
    ) : route.kind === "docs" ? (
      <PlaceTitle docs />
    ) : project ? (
      <PlaceTitle space={project} />
    ) : null;

  return (
    <div className="flex h-dvh">
      <div className="window-drag" />
      <BrowserTakeover />
      <RemoteDesktopLayer computers={computers} memberId={current?.memberId} confirmBy={confirmBy} passkeys={passkeys} />
      <SpaceSidebar {...nav} />
      <div className="flex min-w-0 flex-1 flex-col lg:py-frame-gap lg:pr-frame-gap">
        {project && child ? (
          <SpaceHeader child leading={<BackButton label={`回到「${project.name}」`} onPress={() => go({ kind: "project", id: project.id })} />}>
            <ChildTitle child={child} />
          </SpaceHeader>
        ) : (
          <SpaceHeader
            leading={<SwitchButton onPress={() => setSwitching(true)} unread={lines.unread.own || lines.unread.everyone} expanded={switching} />}
            trailing={project && <MembersCapsule space={project} members={members} onPress={openSettings} />}
          >
            {title}
          </SpaceHeader>
        )}
        <div className="layer-card relative mx-frame-gap mb-frame-gap flex min-h-0 flex-1 flex-col overflow-hidden lg:m-0">
          {title && (
            <CardHead
              trailing={project && <CardMembers space={project} members={members} mine={spaceRights?.mine ?? false} onPress={openSettings} />}
            >
              {title}
            </CardHead>
          )}
          {error && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">
              <div className="bg-surface-sheet shadow-card rounded-full px-3 py-1 text-caption text-danger-ink">{error}</div>
            </div>
          )}
          <div className="relative z-10 flex shrink-0 flex-col">
            {showStrip && (
              <StatusStrip
                rows={doing}
                onOpen={openActivity}
                onTakeback={async (id) => {
                  await api.takeback(id);
                  await refresh();
                }}
              />
            )}
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
          </div>
          <main className="relative min-h-0 flex-1">
            {body}
          </main>
        </div>
      </div>
      {project && child && wide && (
        <aside aria-label="子会话" className="layer-card slide-in my-frame-gap mr-frame-gap flex w-panel-sub shrink-0 flex-col overflow-hidden">
          <header className="flex shrink-0 items-center gap-2 py-2.5 pr-3 pl-4">
            <ChildTitle child={child} />
            <button
              type="button"
              aria-label="关闭"
              onClick={() => go({ kind: "project", id: project.id })}
              className="tap grid size-control-sm shrink-0 place-items-center rounded-full bg-surface-inset text-[14px]"
            >
              <CloseIcon />
            </button>
          </header>
          <div className="relative min-h-0 flex-1">{childChat(project, child)}</div>
        </aside>
      )}
      <SpaceSwitcher
        {...nav}
        isOpen={switching && !wide}
        onClose={() => setSwitching(false)}
        onOpenChild={(id, session) => {
          setSwitching(false);
          go({ kind: "project", id, child: session });
        }}
      />
      <SpaceSettings
        space={settingsTarget}
        members={members}
        mine={settingsTarget ? rights(settingsTarget).mine : false}
        mayLook={settingsTarget ? rights(settingsTarget).mine : false}
        everyone={settingsTarget?.id === EVERYONE_ID}
        onClose={() => setSpaceSettings(null)}
        onChange={async (change) => {
          if (!settingsTarget) return;
          await api.changeSpace(settingsTarget.id, change);
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
  card.animate([{ outline: "2px solid var(--color-ink)" }, { outline: "2px solid transparent" }], { duration: 1200 });
  return true;
}
