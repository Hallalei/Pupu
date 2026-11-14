import { Button, Drawer, Modal } from "@heroui/react";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { encode } from "uqr";
import type { ComputerPolicy } from "../bridge/policy";
import type { ComputerView } from "../bridge/protocol";
import type { ConnectorService, ConnectorView } from "../connectors/store";
import { mayChangePolicy, type DeviceView } from "../devices";
import type { InviteList } from "../directory";
import type { PupuState } from "../server";
import {
  mayConnect,
  mayInvite,
  mayManageInvites,
  mayRemoveMember,
  mayRevoke,
  type Actor,
  type MemberView
} from "../members";
import { ago } from "./ago";
import { MemberAvatar, MyAvatarPage, PUPU_AVATAR, PupuAvatarPage } from "./Avatar";
import { api } from "./api";
import { useDesktopComputer, type DesktopComputer } from "./desktop";
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  CursorIcon,
  ComputerIcon,
  FolderIcon,
  InfoIcon,
  KeyIcon,
  LaptopIcon,
  LinkIcon,
  MailIcon,
  PeopleIcon,
  PhoneIcon,
  PlusIcon,
  SparkleIcon,
  TicketIcon
} from "./icons";
import { openRemoteDesktop, useRemoteDesktop } from "./RemoteDesktop";
import { addPasskey, Cancelled, confirm, openInBrowser, type ConfirmWhere, type Passkeys } from "./passkey";
import { ModelSection, modelSummary } from "./ModelSettings";
import { ThisComputer } from "./ThisComputer";

/** 什么时候先问你。和 iOS 的 Computer.Policy 一样的三档、一样的字。 */
const POLICIES: readonly (readonly [ComputerPolicy, string])[] = [
  ["trust", "始终允许"],
  ["ask_risky", "高风险时询问"],
  ["ask_all", "每次询问"]
];

type PairingCode = { readonly code: string; readonly expiresAt: number };

/** 设置里的一页。和 iOS 的设置同一套：首页是一张自己的卡片和两组入口，点进去是各自的一页。 */
export type SettingsPage =
  | "root"
  | "accounts"
  | "model"
  | "this"
  | "computers"
  | "members"
  | "avatar"
  | "pupuAvatar"
  | "invites"
  | "devices"
  | "passkeys"
  | "about"
  | { readonly computer: string };

const TITLES: Record<Exclude<SettingsPage, object>, string> = {
  root: "设置",
  accounts: "账户",
  model: "模型",
  this: "这台电脑",
  computers: "电脑",
  members: "成员",
  avatar: "头像",
  pupuAvatar: "Pupu 的头像",
  invites: "邀请码",
  devices: "设备",
  passkeys: "通行密钥",
  about: "关于"
};

/** 返回到哪一页：电脑详情回到电脑列表，别的回首页。 */
function parentOf(page: SettingsPage): SettingsPage {
  return typeof page === "object" ? "computers" : "root";
}

const THIS_COMPUTER: Record<DesktopComputer["status"], string> = {
  offline: "没连上",
  idle: "在线",
  busy: "在做事",
  screen: "在用屏幕",
  waiting: "等你批准"
};

function computerLabel(computer: ComputerView): string {
  if (computer.online) return computer.inUse ? "在线 · 有人在用" : "在线";
  if (computer.stale) return "心跳中断";
  if (computer.lastSeenAt) return `离线 · ${ago(computer.lastSeenAt)}`;
  return "离线";
}

/**
 * 设置：连给 Pupu 的账号、已经连上的电脑和它们的权限分级、成员、邀请码、手机浏览器和电脑 App、通行密钥、连的是哪个 Pupu。
 * 电脑上是居中的弹窗，窄窗口是从右边滑出的抽屉；里面都是一页一页往里点，左上角返回，Esc 退一层。
 */
export function Settings({
  page,
  onPage,
  connectors,
  onRemoveConnector,
  computers,
  model,
  onModelSaved,
  onRevoke,
  onSetPolicy,
  devices,
  members,
  actor,
  onRevokeDevice,
  onInviteMember,
  onRemoveMember,
  onCreatePairingCode,
  confirmBy,
  passkeys,
  onPasskeysChanged,
  pupuAvatar
}: {
  /** 开着的那一页，关着是 null。 */
  page: SettingsPage | null;
  onPage: (page: SettingsPage | null) => void;
  connectors: Connectors;
  onRemoveConnector: (id: string) => Promise<void>;
  computers: readonly ComputerView[];
  /** 用哪个模型。老的云端没有这一项。 */
  model: PupuState["model"] | null;
  onModelSaved: () => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onSetPolicy: (id: string, policy: ComputerPolicy) => Promise<void>;
  devices: readonly DeviceView[];
  members: readonly MemberView[];
  /** 发请求的是谁（见 members.ts 的 `actorOf`），按钮灰不灰和接口的规则对得上；本机开发没设访问口令时是 null。 */
  actor: Actor | null | undefined;
  onRevokeDevice: (id: string) => Promise<void>;
  onInviteMember: (email: string, proof?: AuthenticationResponseJSON) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  onCreatePairingCode: () => Promise<PairingCode>;
  /** 允许、放宽权限、邀请这类要亲手确认的事，这台设备上怎么确认，见 passkey.ts。 */
  confirmBy: ConfirmWhere;
  passkeys: Passkeys | null;
  onPasskeysChanged: () => Promise<void>;
  /** Pupu 换过的头像，没换过是 null。 */
  pupuAvatar: string | null;
}) {
  const isOpen = page !== null;
  const thisComputer = useDesktopComputer();
  /** 电脑页右上角的「配对」点开了。 */
  const [pairing, setPairing] = useState(false);
  const wide = useWide();
  const invites = useInvites(isOpen && mayManageInvites(actor));
  // 关的时候弹窗还要淡出一会儿，这期间留着原来那页，不闪回首页。
  const lastPage = useRef<SettingsPage>("root");
  if (page) lastPage.current = page;
  const shown = page ?? lastPage.current;
  const back = shown === "root" ? null : () => onPage(parentOf(shown));
  useEscapeBack(isOpen ? back : null);
  useEffect(() => {
    if (shown !== "computers") setPairing(false);
  }, [shown]);
  // 换页时点的那一行没了，焦点会掉到弹窗外面，Esc 和 Tab 就都不灵了：放回新的这一页上。
  const pageKey = typeof shown === "object" ? `computer:${shown.computer}` : shown;
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = pageRef.current;
    if (isOpen && node && !node.closest("[role=dialog]")?.contains(document.activeElement)) node.focus({ preventScroll: true });
  }, [isOpen, pageKey]);

  const emails = new Map(members.map((member) => [member.id, member.email]));
  const showPasskeys = passkeys !== null && (confirmBy === "passkey" || confirmBy === "browser");
  const pairNew = <PairNew origin={window.location.origin} connected={[...devices, ...computers]} onCreate={onCreatePairingCode} />;
  const computer = typeof shown === "object" ? computers.find((item) => item.id === shown.computer) : undefined;
  const title = typeof shown === "object" ? (computer?.name ?? "电脑") : TITLES[shown];

  let body: ReactNode;
  if (shown === "root") {
    const me = members.find((member) => member.current);
    const here = devices.find((device) => device.current);
    const host = window.location.host;
    const online = computers.filter((item) => item.online).length;
    body = (
      <>
        <Profile
          me={me}
          onPress={me ? () => onPage("avatar") : undefined}
          name={me?.email ?? here?.name ?? host}
          detail={[me ? (me.role === "creator" ? "创建者" : "成员") : here ? null : "本机开发", host]
            .filter((part) => part && part !== (me?.email ?? here?.name ?? host))
            .join(" · ")}
        />
        <Group>
          <LinkRow
            icon={<ComputerIcon />}
            title="电脑"
            summary={computers.length === 0 ? "还没有" : `${computers.length} 台 · ${online} 台在线`}
            onPress={() => onPage("computers")}
          />
          {actor?.role === "creator" && (
            <LinkRow
              icon={
                <img
                  src={pupuAvatar ?? PUPU_AVATAR}
                  alt=""
                  className={`size-6 rounded-full ${pupuAvatar?.startsWith("/api/") ? "" : "[image-rendering:pixelated]"}`}
                />
              }
              title="Pupu 的头像"
              onPress={() => onPage("pupuAvatar")}
            />
          )}
          <LinkRow
            icon={<LinkIcon />}
            title="账户"
            summary={
              connectors.accounts.length > 0
                ? `${connectors.accounts.length} 个`
                : connectors.enabled
                  ? "未连接"
                  : "未开启"
            }
            onPress={() => onPage("accounts")}
          />
          {model && (
            <LinkRow
              icon={<SparkleIcon />}
              title="模型"
              summary={modelSummary(model.current, computers)}
              onPress={() => onPage("model")}
            />
          )}
          {thisComputer && (
            <LinkRow
              icon={<LaptopIcon />}
              title="这台电脑"
              summary={thisComputer.paired ? THIS_COMPUTER[thisComputer.status] : "授权被吊销"}
              onPress={() => onPage("this")}
            />
          )}
          {members.length > 0 && (
            <LinkRow icon={<PeopleIcon />} title="成员" summary={`${members.length} 人`} onPress={() => onPage("members")} />
          )}
          {invites.list && (
            <LinkRow
              icon={<TicketIcon />}
              title="邀请码"
              summary={`还能生成 ${invites.list.left} 个`}
              onPress={() => onPage("invites")}
            />
          )}
        </Group>
        <Group>
          <LinkRow
            icon={<PhoneIcon />}
            title="设备"
            summary={devices.length > 0 ? `${devices.length} 台` : undefined}
            onPress={() => onPage("devices")}
          />
          {showPasskeys && (
            <LinkRow
              icon={<KeyIcon />}
              title="通行密钥"
              summary={passkeys.keys.length > 0 ? `${passkeys.keys.length} 把` : "还没加"}
              onPress={() => onPage("passkeys")}
            />
          )}
          <LinkRow icon={<InfoIcon />} title="关于" onPress={() => onPage("about")} />
        </Group>
      </>
    );
  } else if (shown === "accounts") {
    body = <Accounts connectors={connectors} members={members} actor={actor} onRemove={onRemoveConnector} />;
  } else if (shown === "model") {
    body = model ? <ModelSection model={model} computers={computers} onSaved={onModelSaved} /> : <Note>这个 Pupu 还不能换模型。</Note>;
  } else if (shown === "this") {
    body = thisComputer ? <ThisComputer computer={thisComputer} /> : <Note>只有电脑 App 的窗口里有这一页。</Note>;
  } else if (shown === "computers") {
    // 照原型：自己的这台（没有就第一台在线的）摊开在最上面，别的每台一行，点进去是同样的一页。配对在右上角。
    const featured =
      computers.find((item) => item.id === thisComputer?.computerId) ?? computers.find((item) => item.online) ?? computers[0];
    const others = computers.filter((item) => item !== featured);
    body = (
      <>
        {(pairing || computers.length === 0) && <Group title="连接新设备">{pairNew}</Group>}
        {featured && (
          <ComputerPanel
            key={featured.id}
            computer={featured}
            here={featured.id === thisComputer?.computerId}
            owner={featured.ownerId ? (emails.get(featured.ownerId) ?? null) : null}
            actor={actor}
            onRevoke={() => onRevoke(featured.id)}
            onSetPolicy={(policy) => onSetPolicy(featured.id, policy)}
            onClose={() => onPage(null)}
          />
        )}
        {others.length > 0 && (
          <Group>
            {others.map((item) => (
              <LinkRow
                key={item.id}
                icon={<ComputerIcon />}
                title={item.name}
                detail={[computerLabel(item), item.ownerId ? emails.get(item.ownerId) : null].filter(Boolean).join(" · ")}
                dot={item.online}
                onPress={() => onPage({ computer: item.id })}
              />
            ))}
          </Group>
        )}
      </>
    );
  } else if (typeof shown === "object") {
    body = computer ? (
      <ComputerPanel
        key={computer.id}
        computer={computer}
        here={computer.id === thisComputer?.computerId}
        owner={computer.ownerId ? (emails.get(computer.ownerId) ?? null) : null}
        actor={actor}
        onRevoke={async () => {
          await onRevoke(computer.id);
          onPage("computers");
        }}
        onSetPolicy={(policy) => onSetPolicy(computer.id, policy)}
        onClose={() => onPage(null)}
      />
    ) : (
      <Note>这台电脑已经吊销了。</Note>
    );
  } else if (shown === "members") {
    body = (
      <Members
        members={members}
        actor={actor}
        confirmBy={confirmBy}
        passkeys={passkeys}
        onRemove={onRemoveMember}
        onInvite={onInviteMember}
      />
    );
  } else if (shown === "avatar") {
    const me = members.find((member) => member.current);
    body = me ? <MyAvatarPage me={me} /> : <Note>用 Google 登录之后才能换头像。</Note>;
  } else if (shown === "pupuAvatar") {
    body =
      actor?.role === "creator" ? <PupuAvatarPage current={pupuAvatar} /> : <Note>只有创建者能换 Pupu 的头像。</Note>;
  } else if (shown === "invites") {
    body = invites.list ? <Invites list={invites.list} onChanged={invites.load} /> : <Note>这个 Pupu 不发邀请码。</Note>;
  } else if (shown === "devices") {
    body = (
      <>
        {devices.length === 0 ? (
          <Note>还没有配对的手机、浏览器或电脑 App。</Note>
        ) : (
          <Group title="手机、浏览器和电脑 App">
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} actor={actor} onRevoke={() => onRevokeDevice(device.id)} />
            ))}
          </Group>
        )}
        <Group title="连接新设备">{pairNew}</Group>
      </>
    );
  } else if (shown === "passkeys") {
    body =
      passkeys && (confirmBy === "passkey" || confirmBy === "browser") ? (
        <PasskeyList passkeys={passkeys} confirmBy={confirmBy} onChanged={onPasskeysChanged} />
      ) : (
        <Note>这台设备不用通行密钥。</Note>
      );
  } else {
    body = (
      <Group title="连接的 Pupu">
        <div className="flex min-h-control items-center px-4 py-2.5 text-body break-all">{window.location.origin}</div>
      </Group>
    );
  }

  const backButton = back && (
    <button
      type="button"
      aria-label={`返回${TITLES[typeof shown === "object" ? "computers" : "root"]}`}
      onClick={back}
      className="grid size-control-sm shrink-0 place-items-center rounded-full bg-surface text-[16px] hover:bg-surface-secondary"
    >
      <ChevronLeftIcon />
    </button>
  );
  // 首页不写标题，和 iOS 一样第一眼是自己的卡片；读屏照样念「设置」。
  const heading = shown === "root" ? "sr-only" : "min-w-0 flex-1 truncate text-greeting";
  const action = shown === "computers" && computers.length > 0 && (
    <button
      type="button"
      aria-expanded={pairing}
      onClick={() => setPairing((open) => !open)}
      className="tap flex h-control-sm shrink-0 items-center gap-1 rounded-full bg-surface px-3.5 text-subheadline font-semibold hover:bg-surface-secondary"
    >
      <PlusIcon className="text-[13px]" />
      配对
    </button>
  );
  const content = (
    <div key={pageKey} ref={pageRef} tabIndex={-1} className="fade-in flex flex-col gap-6 outline-none">
      {body}
    </div>
  );
  const onOpenChange = (open: boolean) => {
    if (!open) onPage(null);
  };

  if (wide) {
    return (
      <Modal>
        <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
          <Modal.Container placement="center" scroll="inside">
            <Modal.Dialog className="h-[min(85dvh,640px)] w-[min(92vw,520px)] rounded-panel bg-background">
              <Modal.CloseTrigger aria-label="关闭" />
              <Modal.Header className="flex min-h-control-sm flex-col items-start gap-3">
                {backButton}
                <div className="flex w-full items-center gap-3 pr-10">
                  <Modal.Heading className={heading}>{title}</Modal.Heading>
                  {action}
                </div>
              </Modal.Header>
              <Modal.Body className="pt-3 pb-2 text-body text-foreground">{content}</Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    );
  }
  return (
    <Drawer>
      <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="w-[min(88vw,380px)] bg-background">
            <Drawer.Header className="flex flex-col items-start gap-3">
              {backButton}
              <div className="flex w-full items-center gap-3">
                <Drawer.Heading className={heading}>{title}</Drawer.Heading>
                {action}
              </div>
            </Drawer.Header>
            <Drawer.Body className="text-body text-foreground">{content}</Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}

/**
 * 在里面那几页按 Esc 退一层，不关掉设置。监听挂在 window 的捕获阶段，比弹窗自己关窗的处理先拿到。
 */
function useEscapeBack(back: (() => void) | null) {
  useEffect(() => {
    if (!back) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      back();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [back]);
}

/** 发给新用户开 Pupu 的码。别的 Pupu 的创建者，接口回 403，list 一直是 null，首页就没有这一行。 */
function useInvites(enabled: boolean) {
  const [list, setList] = useState<InviteList | null>(null);
  const load = useCallback(() => api.invites().then(setList), []);
  useEffect(() => {
    if (enabled) load().catch(() => setList(null));
  }, [enabled, load]);
  return { list, load };
}

/** 首页最上面：自己是谁，连的是哪个 Pupu。 */
function Profile({
  me,
  name,
  detail,
  onPress
}: {
  me: MemberView | undefined;
  name: string;
  detail: string;
  /** 是成员时点进去换头像。 */
  onPress?: () => void;
}) {
  const content = (
    <>
      <MemberAvatar name={name} src={me?.avatar ?? null} className="size-10 bg-foreground text-headline text-background" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-title">{name}</span>
        {detail && <span className="block truncate text-subheadline text-muted">{detail}</span>}
      </span>
    </>
  );
  if (!onPress) return <div className="flex items-center gap-3 rounded-row bg-surface px-4 py-3">{content}</div>;
  return (
    <button
      type="button"
      aria-label="换头像"
      onClick={onPress}
      className="flex w-full items-center gap-3 rounded-row bg-surface px-4 py-3 text-left hover:bg-surface-secondary"
    >
      {content}
      <ChevronRightIcon className="shrink-0 text-[14px] text-muted" />
    </button>
  );
}

/** 一组行，白底圆角，行和行之间一条细线；上面可以有个小标题，下面可以有一句说明。 */
function Group({ title, note, children }: { title?: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      {title && <h3 className="m-0 px-4 text-footnote text-muted">{title}</h3>}
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-row bg-surface">{children}</div>
      {note && <p className="m-0 px-4 text-footnote font-normal text-muted">{note}</p>}
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="m-0 px-4 text-subheadline text-muted">{children}</p>;
}

function Dot({ online }: { online: boolean }) {
  return <span className={`size-2 rounded-full ${online ? "bg-online" : "bg-offline"}`} aria-hidden="true" />;
}

/** 点进下一页的一行：图标、名字、右边一句摘要和 ›。 */
function LinkRow({
  icon,
  title,
  detail,
  dot,
  summary,
  onPress
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
  /** 在不在线：给了就在 detail 前面画一个点。 */
  dot?: boolean;
  summary?: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex min-h-control w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-foreground/4"
    >
      {icon && <span className="grid size-5 shrink-0 place-items-center text-[18px]">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body">{title}</span>
        {detail && (
          <span className="flex items-center gap-1.5 text-subheadline text-muted">
            {dot !== undefined && <Dot online={dot} />}
            <span className="truncate">{detail}</span>
          </span>
        )}
      </span>
      {summary && <span className="shrink-0 text-body text-muted">{summary}</span>}
      <ChevronRightIcon className="shrink-0 text-[14px] text-muted" />
    </button>
  );
}

const WIDE = "(min-width: 1024px)";

/** 窗口够不够宽，跟着窗口大小变。 */
function useWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(WIDE).matches
  );
}

/**
 * 一行上的操作。吊销、移除先展开确认；改分级直接发。在发的时候这一行的按钮都等着，
 * 没成的原因写在这一行下面，下一次操作时清掉。每行各管各的，别的行照常能点。
 */
type RowAction = {
  readonly confirming: boolean;
  readonly request: { readonly status: "idle" | "sending" } | { readonly status: "failed"; readonly error: string };
};

const IDLE_ROW: RowAction = { confirming: false, request: { status: "idle" } };

function useRowAction() {
  const [action, setAction] = useState<RowAction>(IDLE_ROW);
  async function run(work: () => Promise<void>) {
    setAction((current) => ({ ...current, request: { status: "sending" } }));
    try {
      await work();
      setAction(IDLE_ROW);
    } catch (cause) {
      if (cause instanceof Cancelled) {
        setAction(IDLE_ROW);
        return;
      }
      const error = cause instanceof Error ? cause.message : String(cause);
      setAction((current) => ({ ...current, request: { status: "failed", error } }));
    }
  }
  return {
    confirming: action.confirming,
    sending: action.request.status === "sending",
    error: action.request.status === "failed" ? action.request.error : null,
    confirm: () => setAction({ confirming: true, request: { status: "idle" } }),
    cancel: () => setAction(IDLE_ROW),
    run
  };
}

/** 吊销、移除前的那一句确认，和两个按钮。 */
function ConfirmPanel({
  text,
  label,
  sending,
  onCancel,
  onConfirm
}: {
  text: string;
  label: string;
  sending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-subheadline text-muted">{text}</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="tertiary" onPress={onCancel}>
          取消
        </Button>
        <Button size="sm" variant="danger" isPending={sending} onPress={onConfirm}>
          {label}
        </Button>
      </div>
    </div>
  );
}

function RowError({ error }: { error: string | null }) {
  return error ? <p className="m-0 text-subheadline text-danger-ink">{error}</p> : null;
}

/** 账户（连接器）：`enabled` 是这个 Pupu 配没配 open-connector。 */
type Connectors = PupuState["connectors"];

const SERVICE_ICONS: Record<string, typeof LinkIcon> = {
  gmail: MailIcon,
  googlecalendar: CalendarIcon,
  googledrive: FolderIcon,
  github: CodeIcon
};

function ServiceIcon({ service }: { service: string }) {
  const Icon = SERVICE_ICONS[service] ?? LinkIcon;
  return (
    <span className="grid size-5 shrink-0 place-items-center text-[18px]">
      <Icon />
    </span>
  );
}

/**
 * 账户一页，和 iOS 的一样：上面是连上的账号，下面是能连的服务。连账号只在手机 App 上做（`mayConnect`），
 * 这里一般只能看和断开；本机开发不带凭据时也能连，授权页开在新标签页里。
 */
function Accounts({
  connectors,
  members,
  actor,
  onRemove
}: {
  connectors: Connectors;
  members: readonly MemberView[];
  actor: Actor | null | undefined;
  onRemove: (id: string) => Promise<void>;
}) {
  const me = members.find((member) => member.current)?.id;
  const connectable = mayConnect(actor);
  const note =
    "Pupu 读邮件、看日程直接用；发信、建日程、改 issue 这类写操作，会先推到连这个账号的人的手机上批准。凭据存在这个 Pupu 自己的 open-connector 里。";
  return (
    <>
      {connectors.accounts.length > 0 && (
        <Group title="已连接">
          {connectors.accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              // 别人连的写上是谁的；自己的不写。
              owner={account.memberId === me ? null : account.ownerEmail}
              onRemove={() => onRemove(account.id)}
            />
          ))}
        </Group>
      )}
      {connectors.enabled ? (
        <Group note={connectable ? note : `连账号要在手机 App 上做。${note}`}>
          {connectors.services.map((service) => (
            <ServiceRow key={service.id} service={service} connectable={connectable} />
          ))}
        </Group>
      ) : (
        <Note>这个 Pupu 还没配连接器。配好 open-connector 之后，这里就能连 Gmail、Google 日历、云端硬盘和 GitHub。</Note>
      )}
    </>
  );
}

function AccountRow({
  account,
  owner,
  onRemove
}: {
  account: ConnectorView;
  /** 别人连的才有：连它的人的邮箱。 */
  owner: string | null;
  onRemove: () => Promise<void>;
}) {
  const row = useRowAction();
  const detail = [account.account, owner && `${owner} 连的`].filter(Boolean).join(" · ");
  const label = account.account ? `${account.name}（${account.account}）` : account.name;
  return (
    <div className="flex flex-col gap-2 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <ServiceIcon service={account.service} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body">{account.name}</div>
          {detail && <div className="truncate text-subheadline text-muted">{detail}</div>}
        </div>
        {!row.confirming && account.removable && (
          <button
            type="button"
            aria-label={`断开${label}`}
            className="shrink-0 text-subheadline text-danger-ink hover:opacity-75"
            onClick={row.confirm}
          >
            断开
          </button>
        )}
      </div>
      {row.confirming && (
        <ConfirmPanel
          text={`断开后 Pupu 不能再用${label}，授权在那边一起撤销。要再用就重新连。`}
          label="断开"
          sending={row.sending}
          onCancel={row.cancel}
          onConfirm={() => void row.run(onRemove)}
        />
      )}
      <RowError error={row.error} />
    </div>
  );
}

function ServiceRow({ service, connectable }: { service: ConnectorService; connectable: boolean }) {
  const row = useRowAction();
  function connect() {
    // 授权页开在新标签页：要在点的这一下里先开，等拿到地址再打开会被浏览器当成弹窗拦掉。
    // 授权完那一页说「可以关掉了」，回到这里时 Pupu 的状态会重新拉一次。
    const tab = window.open("about:blank", "_blank");
    void row.run(async () => {
      try {
        if (!tab) throw new Error("浏览器拦住了授权页，允许这个网站打开新窗口再点一次。");
        tab.opener = null;
        tab.location.href = (await api.connect(service.id)).url;
      } catch (cause) {
        tab?.close();
        throw cause;
      }
    });
  }
  return (
    <div className="flex flex-col gap-2 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <ServiceIcon service={service.id} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body">{service.name}</div>
          <div className="text-subheadline text-muted">{service.detail}</div>
        </div>
        {connectable && (
          <Button size="sm" variant="secondary" isPending={row.sending} onPress={connect}>
            连接
          </Button>
        )}
      </div>
      <RowError error={row.error} />
    </div>
  );
}

/** 分级的下拉：系统自带的选择框，样子是一颗小胶囊。别人的电脑只能往严里改，放宽的那几项灰掉。 */
function PolicySelect({
  computer,
  actor,
  sending,
  onChange
}: {
  computer: ComputerView;
  actor: Actor | null | undefined;
  sending: boolean;
  onChange: (policy: ComputerPolicy) => void;
}) {
  return (
    <span className="relative shrink-0">
      <select
        aria-label={`「${computer.name}」上什么时候先问你`}
        value={computer.policy}
        disabled={sending}
        onChange={(event) => {
          const next = event.target.value as ComputerPolicy;
          if (next !== computer.policy) onChange(next);
        }}
        className="tap h-8 appearance-none rounded-full border border-separator bg-surface py-0 pr-7 pl-3 text-subheadline text-foreground"
      >
        {POLICIES.map(([policy, name]) => (
          <option key={policy} value={policy} disabled={!mayChangePolicy(computer.policy, policy, actor, computer.ownerId)}>
            {name}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[11px] text-muted" />
    </span>
  );
}

/**
 * 一台电脑：名字和在不在线、什么时候先问你、吊销，一组排下来。电脑页最上面那台和点进去的那一页都是它。
 * 远程控制只有手机上有（云端也只让手机看远程桌面），这里不放。
 */
function ComputerPanel({
  computer,
  here,
  owner,
  actor,
  onRevoke,
  onSetPolicy,
  onClose
}: {
  computer: ComputerView;
  /** 就是眼前这台电脑（电脑 App 里）。 */
  here: boolean;
  /** 主人的邮箱。 */
  owner: string | null;
  actor: Actor | null | undefined;
  onRevoke: () => Promise<void>;
  onSetPolicy: (policy: ComputerPolicy) => Promise<void>;
  /** 关掉设置：远程桌面盖满整个窗口，设置弹窗还开着会抢走键盘焦点。 */
  onClose: () => void;
}) {
  const row = useRowAction();
  const policy = useRowAction();
  const remote = useRemoteDesktop(computer.id);
  // 和 iOS 一样只给主人自己的电脑；离线的放一行灰的说明。
  const mine = !here && computer.ownerId !== null && computer.ownerId === actor?.memberId;
  return (
    <section className="flex flex-col gap-1.5" data-computer={computer.id}>
      {remote && remote !== "phone" ? (
        <button
          type="button"
          onClick={() => {
            openRemoteDesktop(computer.id, remote);
            if (remote !== "browser") onClose();
          }}
          className="tap mb-2 flex h-control w-full items-center justify-center gap-2 rounded-full bg-foreground text-body font-semibold text-background"
        >
          <CursorIcon />
          {remote === "browser" ? "在浏览器里远程控制" : "远程控制"}
        </button>
      ) : remote === "phone" ? (
        <div className="mb-2"><Note>在手机 App 上远程控制这台电脑。</Note></div>
      ) : mine && !computer.online ? (
        <div className="mb-2 flex h-control w-full items-center justify-center rounded-full bg-foreground/35 text-body font-semibold text-background">
          离线，连上才能远程控制
        </div>
      ) : null}
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-row bg-surface">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <ComputerIcon className="shrink-0 text-[26px]" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-body font-semibold">{computer.name}</span>
            <span className="flex items-center gap-1.5 text-subheadline text-muted">
              <Dot online={computer.online} />
              <span className="truncate">
                {[computerLabel(computer), here ? "这台电脑" : owner, computer.screen ? "屏幕已授权" : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          </span>
        </div>
        <div className="flex min-h-control items-center gap-3 py-2.5 pr-3 pl-4">
          <span className="min-w-0 flex-1 text-body">Pupu 用它之前问我</span>
          <PolicySelect
            computer={computer}
            actor={actor}
            sending={policy.sending}
            onChange={(next) => void policy.run(() => onSetPolicy(next))}
          />
        </div>
        {mayRevoke(actor, computer.ownerId) &&
          (row.confirming ? (
            <div className="px-4 py-3">
              <ConfirmPanel
                text={`吊销后「${computer.name}」会断开。要再用，就在那台电脑上重新配对。`}
                label="吊销"
                sending={row.sending}
                onCancel={row.cancel}
                onConfirm={() => void row.run(onRevoke)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={row.confirm}
              className="flex min-h-control w-full items-center px-4 py-2.5 text-left text-body text-danger-ink hover:bg-foreground/4"
            >
              吊销
            </button>
          ))}
      </div>
      <RowError error={policy.error ?? row.error} />
    </section>
  );
}

function DeviceRow({
  device,
  actor,
  onRevoke
}: {
  device: DeviceView;
  actor: Actor | null | undefined;
  onRevoke: () => Promise<void>;
}) {
  const row = useRowAction();
  return (
    <div className="flex flex-col gap-2 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body">
            {device.name}
            {device.current && (
              <span className="text-muted">{device.kind === "desktop" ? " · 这个窗口" : " · 这个浏览器"}</span>
            )}
          </div>
          <div className="truncate text-subheadline text-muted">{deviceLabel(device)}</div>
        </div>
        {!row.confirming && mayRevoke(actor, device.memberId) && (
          <button
            type="button"
            className="shrink-0 text-subheadline text-danger-ink hover:opacity-75"
            onClick={row.confirm}
          >
            吊销
          </button>
        )}
      </div>
      {row.confirming && (
        <ConfirmPanel
          text={
            device.current
              ? device.kind === "desktop"
                ? "吊销后这个窗口马上退出，要再用就在 App 里重新配对。"
                : "吊销后这个浏览器马上退出，要再用就重新配对。"
              : `吊销后「${device.name}」马上断开。要再用，就在那台设备上重新配对。`
          }
          label="吊销"
          sending={row.sending}
          onCancel={row.cancel}
          onConfirm={() => void row.run(onRevoke)}
        />
      )}
      <RowError error={row.error} />
    </div>
  );
}

function MemberRow({
  member,
  actor,
  onRemove
}: {
  member: MemberView;
  actor: Actor | null | undefined;
  onRemove: () => Promise<void>;
}) {
  const row = useRowAction();
  return (
    <div className="flex flex-col gap-2 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <MemberAvatar name={member.name} src={member.avatar} className="size-8 strong text-footnote" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body">
            {member.email}
            {member.current && <span className="text-muted"> · 你</span>}
          </div>
          <div className="text-subheadline text-muted">
            {member.role === "creator" ? "创建者" : member.joinedAt ? "成员" : "成员 · 还没登录过"}
          </div>
        </div>
        {!row.confirming && mayRemoveMember(actor, member) && (
          <button type="button" className="shrink-0 text-subheadline text-danger-ink hover:opacity-75" onClick={row.confirm}>
            移除
          </button>
        )}
      </div>
      {row.confirming && (
        <ConfirmPanel
          text={`移除后 ${member.email} 不能再登录，他名下的手机、浏览器、电脑 App 和电脑马上断开。`}
          label="移除"
          sending={row.sending}
          onCancel={row.cancel}
          onConfirm={() => void row.run(onRemove)}
        />
      )}
      <RowError error={row.error} />
    </div>
  );
}

const DEVICE_KINDS: Record<DeviceView["kind"], string> = { phone: "手机", browser: "浏览器", desktop: "电脑 App" };

/**
 * 成员名单：创建者在前。创建者能移除别人；邀请要亲手确认（加人等于放宽权限，见 `mayInvite`）：
 * 手机上直接邀请，网页上用通行密钥，电脑 App 交给浏览器。
 */
function Members({
  members,
  actor,
  confirmBy,
  passkeys,
  onRemove,
  onInvite
}: {
  members: readonly MemberView[];
  actor: Actor | null | undefined;
  confirmBy: ConfirmWhere;
  passkeys: Passkeys | null;
  onRemove: (id: string) => Promise<void>;
  onInvite: (email: string, proof?: AuthenticationResponseJSON) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const how: "now" | ConfirmWhere = mayInvite(actor)
    ? "now"
    : passkeys && mayInvite(actor, actor?.memberId ?? null)
      ? confirmBy
      : "phone";

  async function invite() {
    setInviting(true);
    setError(null);
    try {
      const to = email.trim();
      const proof = how === "passkey" && passkeys ? await confirm({ kind: "invite", email: to }, passkeys) : undefined;
      await onInvite(to, proof);
      setEmail("");
    } catch (cause) {
      if (!(cause instanceof Cancelled)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInviting(false);
    }
  }

  return (
    <>
      <Group>
        {members.map((member) => (
          <MemberRow key={member.id} member={member} actor={actor} onRemove={() => onRemove(member.id)} />
        ))}
      </Group>
      {how === "now" || how === "passkey" ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void invite();
          }}
        >
          <input
            type="email"
            aria-label="要邀请的 Google 邮箱"
            placeholder="要邀请的 Google 邮箱"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="min-w-0 flex-1 rounded-full bg-surface px-4 py-1.5 text-body"
          />
          <Button type="submit" isPending={inviting} isDisabled={!email.trim()}>
            邀请
          </Button>
        </form>
      ) : how === "browser" ? (
        <Button variant="secondary" className="self-start" onPress={openInBrowser}>
          在浏览器里邀请
        </Button>
      ) : (
        actor?.role === "creator" && <Note>邀请成员要在手机 App 的设置里做。</Note>
      )}
      {error && <p className="m-0 px-4 text-subheadline text-danger-ink">{error}</p>}
    </>
  );
}

/** 邀请码一页：没用过的能复制、作废，用过的写是谁用的。 */
function Invites({ list, onChanged }: { list: InviteList; onChanged: () => Promise<void> }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function create() {
    setCreating(true);
    await change(api.createInvite);
    setCreating(false);
  }

  return (
    <>
      {list.invites.length > 0 && (
        <Group>
          {list.invites.map((invite) => (
            <div key={invite.code} className="flex min-h-control items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-body">{invite.code}</div>
                {invite.usedBy && <div className="truncate text-subheadline text-muted">{invite.usedBy}</div>}
              </div>
              {!invite.usedBy && (
                <>
                  <button
                    type="button"
                    className="shrink-0 text-subheadline hover:opacity-75"
                    onClick={() => {
                      void navigator.clipboard?.writeText(invite.code);
                      setCopied(invite.code);
                    }}
                  >
                    {copied === invite.code ? "已复制" : "复制"}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 text-subheadline text-danger-ink hover:opacity-75"
                    onClick={() => void change(() => api.revokeInvite(invite.code))}
                  >
                    作废
                  </button>
                </>
              )}
            </div>
          ))}
        </Group>
      )}
      <Group note={`还能生成 ${list.left} 个。新用户填码就能开自己的 Pupu。`}>
        <button
          type="button"
          disabled={creating || list.left === 0}
          onClick={() => void create()}
          className="flex min-h-control w-full items-center px-4 py-2.5 text-left text-body font-semibold enabled:hover:bg-foreground/4 disabled:text-muted"
        >
          {creating ? "正在生成…" : "生成邀请码"}
        </button>
      </Group>
      {error && <p className="m-0 px-4 text-subheadline text-danger-ink">{error}</p>}
    </>
  );
}

/**
 * 这个人的通行密钥。没有手机时，允许、放宽权限、邀请靠它确认：系统弹窗里按指纹或输电脑密码。
 * 电脑 App 的窗口里加不了（见 passkey.ts），交给浏览器。
 */
function PasskeyList({
  passkeys,
  confirmBy,
  onChanged
}: {
  passkeys: Passkeys;
  confirmBy: "passkey" | "browser";
  onChanged: () => Promise<void>;
}) {
  const row = useRowAction();
  const add =
    confirmBy === "browser"
      ? openInBrowser
      : () =>
          void row.run(async () => {
            await addPasskey(passkeys);
            await onChanged();
          });
  return (
    <>
      {passkeys.keys.length > 0 && (
        <Group>
          {passkeys.keys.map((key) => (
            <div key={key.id} className="flex flex-col px-4 py-2.5">
              <div className="truncate text-body">{key.name}</div>
              <div className="truncate text-subheadline text-muted">
                {key.lastUsedAt ? `${ago(key.lastUsedAt)}用过` : `${ago(key.createdAt)}加的`}
              </div>
            </div>
          ))}
        </Group>
      )}
      <Group note="没有手机时，允许 Pupu 的请示、放宽电脑权限、邀请成员，都用通行密钥确认：按指纹或输电脑密码。">
        <button
          type="button"
          disabled={row.sending}
          onClick={add}
          className="flex min-h-control w-full items-center px-4 py-2.5 text-left text-body font-semibold enabled:hover:bg-foreground/4 disabled:text-muted"
        >
          {confirmBy === "browser" ? "在浏览器里加" : row.sending ? "正在加…" : "加一把通行密钥"}
        </button>
      </Group>
      <RowError error={row.error} />
    </>
  );
}

/** 比如「手机 · a@gmail.com · 3 分钟前用过」。邮箱是这台设备属于的成员。 */
function deviceLabel(device: DeviceView): string {
  const seen = device.lastSeenAt ? `${ago(device.lastSeenAt)}用过` : null;
  return [DEVICE_KINDS[device.kind], device.member, seen].filter(Boolean).join(" · ");
}

/**
 * 连接新设备：生成一个配对码，手机扫二维码或者填码，浏览器和电脑 App 填码。
 * 连过手机以后，网页生成的码配不了新手机（见 `mayPair`），要在旧手机上生成。
 * 用这个码的设备连上了，或者码过期了，就收起来。放在一组里，和 iOS 一样是一行「生成配对码」。
 */
function PairNew({
  origin,
  connected,
  onCreate
}: {
  origin: string;
  /** 已经连上的设备和电脑。生成码之后多出来的那台，就是用这个码连上的。 */
  connected: readonly { readonly id: string; readonly name: string }[];
  onCreate: () => Promise<PairingCode>;
}) {
  const [pairing, setPairing] = useState<(PairingCode & { known: ReadonlySet<string> }) | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    if (!pairing) return;
    const added = connected.find((item) => !pairing.known.has(item.id));
    if (added) {
      setJoined(added.name);
      setPairing(null);
    }
  }, [connected, pairing]);

  async function create() {
    setBusy(true);
    setError(null);
    setJoined(null);
    try {
      const code = await onCreate();
      setPairing({ ...code, known: new Set(connected.map((item) => item.id)) });
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const left = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;
  const link = pairing
    ? `pupu://pair?server=${encodeURIComponent(origin)}&code=${encodeURIComponent(pairing.code)}`
    : "";

  if (pairing && left > 0) {
    return (
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <QrCode text={link} label="配对二维码，用 iPhone 相机扫" />
          <div className="flex min-w-0 flex-col gap-1">
            <div className="font-mono text-xl font-semibold tracking-wider" aria-label="配对码">
              {pairing.code}
            </div>
            <div className="text-subheadline text-muted" aria-live="polite">
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} 后过期
            </div>
          </div>
        </div>
        <p className="m-0 text-subheadline text-muted">
          手机扫码或在 App 里填码，浏览器和电脑 App 填码。连过手机的，新手机要用旧手机设置里生成的码。
        </p>
        <div className="flex justify-end">
          <Button size="sm" variant="tertiary" onPress={() => setPairing(null)}>
            不用了
          </Button>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void create()}
      className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left enabled:hover:bg-foreground/4"
    >
      <span className="text-body font-semibold">
        {busy ? "正在生成…" : joined || pairing ? "再生成一个配对码" : "生成配对码"}
      </span>
      <span className={`text-subheadline ${error ? "text-danger-ink" : "text-muted"}`}>
        {error ??
          (joined
            ? `「${joined}」连上了。`
            : pairing
              ? "配对码过期了。"
              : "新手机、浏览器和电脑都用配对码连上。码 10 分钟内有效，用一次就作废。")}
      </span>
    </button>
  );
}

/** 白底黑块，深色模式下也一样，相机才认得出来。 */
function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 0 });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      })
    );
    return { size: qr.size, path: d };
  }, [text]);
  return (
    <div className="shrink-0 rounded-tag bg-white p-2">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${size} ${size}`}
        shapeRendering="crispEdges"
        className="block size-32"
      >
        <path d={path} fill="#000" />
      </svg>
    </div>
  );
}
