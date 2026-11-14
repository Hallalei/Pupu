import { Spinner } from "@heroui/react";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { encode } from "uqr";
import type { ComputerPolicy } from "../bridge/policy";
import type { ComputerView } from "../bridge/protocol";
import { REMOTE_CONFIRMS, mayChangeRemoteConfirm, type RemoteConfirm } from "../bridge/remote-confirm";
import type { ConnectorService, ConnectorView } from "../connectors/store";
import { mayChangePolicy, type DeviceView } from "../devices";
import type { InviteList } from "../directory";
import type { OrgList, PupuState } from "../server";
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
import { MemberAvatar, MyAvatarPage, PupuAvatar, PupuAvatarPage } from "./Avatar";
import { api } from "./api";
import { useDesktopComputer } from "./desktop";
import {
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  CursorIcon,
  ComputerIcon,
  FolderIcon,
  LaptopIcon,
  LinkIcon,
  MailIcon,
  PeopleIcon,
  PhoneIcon,
  PlusIcon,
  SparkleIcon
} from "./icons";
import { openRemoteDesktop, useRemoteDesktop } from "./RemoteDesktop";
import { addPasskey, Cancelled, confirm, openInBrowser, type ConfirmWhere, type Passkeys } from "./passkey";
import { ModelSection, modelSummary } from "./ModelSettings";
import { Sheet, SheetBack, SheetClose } from "./Sheet";
import {
  Dot,
  Group,
  Note,
  PILL,
  PILL_ACTION,
  PILL_CANCEL,
  PILL_DANGER,
  PILL_ROW,
  PILL_SECONDARY,
  ROW_BUTTON,
  TEXT_BUTTON,
  computerLabel
} from "./settings-ui";
import { statusWord, ThisComputer } from "./ThisComputer";

/** 什么时候先问你。和 iOS 的 Computer.Policy 一样的三档、一样的字。 */
const POLICIES: readonly (readonly [ComputerPolicy, string])[] = [
  ["trust", "始终允许"],
  ["ask_risky", "高风险时询问"],
  ["ask_all", "每次询问"]
];

type PairingCode = { readonly code: string; readonly expiresAt: number };

/**
 * 设置里的一页。和规范 SettingsSheet 一样：首页是自己、换一个 Pupu、这个 Pupu 三组，点进去是各自的一页。
 * 自己那一行进「账户」：头像、Google 账户、通行密钥、邀请码和连上的服务都在那里。
 */
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
  | { readonly computer: string };

type NamedPage = Exclude<SettingsPage, object>;

const TITLES: Record<NamedPage, string> = {
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
  passkeys: "通行密钥"
};

/** 返回到哪一页：电脑详情回电脑列表；头像、通行密钥、邀请码回「账户」；别的回首页。 */
function parentOf(page: SettingsPage): NamedPage {
  if (typeof page === "object") return "computers";
  if (page === "avatar" || page === "passkeys" || page === "invites") return "accounts";
  return "root";
}

/**
 * 设置（规范 SettingsSheet）：自己、换一个 Pupu、这个 Pupu 的电脑、设备、成员、模型。
 * 宽屏是居中的弹窗，宽 560、最高 640；窄窗口照手机从下面升起。里面一页一页往里点，左上角返回，Esc 退一层。
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
  onSetRemoteConfirm,
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
  onSetRemoteConfirm: (id: string, level: RemoteConfirm) => Promise<void>;
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

  const names = new Map(members.map((member) => [member.id, member.name]));
  const me = members.find((member) => member.current);
  const showPasskeys = passkeys !== null && (confirmBy === "passkey" || confirmBy === "browser");
  const pairNew = <PairNew origin={window.location.origin} connected={[...devices, ...computers]} onCreate={onCreatePairingCode} />;
  const computer = typeof shown === "object" ? computers.find((item) => item.id === shown.computer) : undefined;
  const title = typeof shown === "object" ? (computer?.name ?? "电脑") : TITLES[shown];
  const panel = (item: ComputerView, afterRevoke?: () => void) => (
    <ComputerPanel
      key={item.id}
      computer={item}
      here={item.id === thisComputer?.computerId}
      owner={item.ownerId ? (names.get(item.ownerId) ?? null) : null}
      actor={actor}
      onRevoke={async () => {
        await onRevoke(item.id);
        afterRevoke?.();
      }}
      onSetPolicy={(policy) => onSetPolicy(item.id, policy)}
      onSetRemoteConfirm={(level) => onSetRemoteConfirm(item.id, level)}
      canConfirm={remoteConfirmable(confirmBy, passkeys)}
      onClose={() => onPage(null)}
    />
  );

  let body: ReactNode;
  if (shown === "root") {
    const here = devices.find((device) => device.current);
    const online = computers.filter((item) => item.online).length;
    body = (
      <>
        <Group label="自己">
          <SelfRow name={me?.name ?? here?.name ?? window.location.host} avatar={me?.avatar ?? null} onPress={() => onPage("accounts")} />
        </Group>
        {me && <Orgs open={isOpen} pupuAvatar={pupuAvatar} />}
        <Group label="这个 Pupu" inset="icon">
          <LinkRow
            icon={<ComputerIcon />}
            title="电脑"
            summary={computers.length === 0 ? "还没有" : `${computers.length} 台 · ${online} 台在线`}
            onPress={() => onPage("computers")}
          />
          {thisComputer && (
            <LinkRow
              icon={<LaptopIcon />}
              title="这台电脑"
              summary={statusWord(thisComputer)}
              onPress={() => onPage("this")}
            />
          )}
          <LinkRow
            icon={<PhoneIcon />}
            title="设备"
            summary={devices.length > 0 ? `${devices.length} 台` : undefined}
            onPress={() => onPage("devices")}
          />
          {members.length > 0 && (
            <LinkRow icon={<PeopleIcon />} title="成员" summary={`${members.length} 人`} onPress={() => onPage("members")} />
          )}
          {model && (
            <LinkRow
              icon={<SparkleIcon />}
              title="模型"
              summary={modelSummary(model.current, computers)}
              onPress={() => onPage("model")}
            />
          )}
          {actor?.role === "creator" && (
            <LinkRow
              icon={<PupuAvatar src={pupuAvatar} className="size-5" />}
              title="Pupu 的头像"
              onPress={() => onPage("pupuAvatar")}
            />
          )}
        </Group>
      </>
    );
  } else if (shown === "accounts") {
    body = (
      <>
        <Group label="自己">
          {me && (
            <LinkRow
              title="头像"
              trailing={<MemberAvatar name={me.name} src={me.avatar} className="size-7 bg-surface text-footnote font-semibold" />}
              onPress={() => onPage("avatar")}
            />
          )}
          {me && <ValueRow title="Google 账户" value={me.email} />}
          {showPasskeys && (
            <LinkRow
              title="通行密钥"
              summary={passkeys.keys.length > 0 ? `${passkeys.keys.length} 把` : "还没加"}
              onPress={() => onPage("passkeys")}
            />
          )}
          {invites.list && (
            <LinkRow title="邀请码" summary={`还能生成 ${invites.list.left} 个`} onPress={() => onPage("invites")} />
          )}
        </Group>
        <Accounts connectors={connectors} members={members} actor={actor} onRemove={onRemoveConnector} />
        <Group title="连接的 Pupu">
          <div className="flex min-h-13 items-center px-4 py-2.5 text-body break-all pointer-fine:min-h-11">{window.location.origin}</div>
        </Group>
      </>
    );
  } else if (shown === "model") {
    body = model ? <ModelSection model={model} computers={computers} onSaved={onModelSaved} /> : <Note>这个 Pupu 还不能换模型。</Note>;
  } else if (shown === "this") {
    body = thisComputer ? <ThisComputer computer={thisComputer} /> : <Note>只有电脑 App 的窗口里有这一页。</Note>;
  } else if (shown === "computers") {
    // 规范 ComputerRow：在线的每台一块，电脑 App 眼前这台摊在最上面；离线的一台一行，点进去是同样的一块。配对在右上角。
    const here = computers.find((item) => item.id === thisComputer?.computerId);
    const blocks = [...(here ? [here] : []), ...computers.filter((item) => item !== here && item.online)];
    const offline = computers.filter((item) => item !== here && !item.online);
    body = (
      <>
        {(pairing || computers.length === 0) && <Group title="连接新设备">{pairNew}</Group>}
        {blocks.map((item) => panel(item))}
        {offline.length > 0 && (
          <Group label="离线的电脑" inset="icon">
            {offline.map((item) => (
              <LinkRow
                key={item.id}
                icon={<ComputerIcon />}
                title={item.name}
                detail={computerLabel(item)}
                dot={false}
                onPress={() => onPage({ computer: item.id })}
              />
            ))}
          </Group>
        )}
      </>
    );
  } else if (typeof shown === "object") {
    body = computer ? panel(computer, () => onPage("computers")) : <Note>这台电脑已经吊销了。</Note>;
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
  } else {
    body =
      passkeys && (confirmBy === "passkey" || confirmBy === "browser") ? (
        <PasskeyList passkeys={passkeys} confirmBy={confirmBy} onChanged={onPasskeysChanged} />
      ) : (
        <Note>这台设备不用通行密钥。</Note>
      );
  }

  // 电脑页右上角的「配对」：surface-inset 胶囊，展开或收起列表上面的「连接新设备」。
  const action = shown === "computers" && computers.length > 0 && (
    <button
      type="button"
      aria-expanded={pairing}
      onClick={() => setPairing((open) => !open)}
      className="tap flex h-control-sm shrink-0 items-center gap-1 rounded-full bg-surface-inset px-3.5 text-subheadline font-semibold text-ink"
    >
      <PlusIcon className="text-[13px]" />
      配对
    </button>
  );

  return (
    <Sheet
      isOpen={isOpen}
      onClose={() => onPage(null)}
      label="设置"
      width="w-[min(calc(100vw-12px),560px)]"
      className="h-[min(85dvh,640px)] max-lg:h-full"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-8.5 shrink-0 items-center gap-3 px-3.5 pt-2 pb-3.5 pointer-fine:min-h-control-sm lg:px-4 lg:pt-4 lg:pb-4">
          {back && <SheetBack label={`返回${TITLES[parentOf(shown)]}`} onBack={back} />}
          <h2 className="m-0 min-w-0 flex-1 truncate text-title">{title}</h2>
          {action}
          <SheetClose onClose={() => onPage(null)} />
        </div>
        <div
          key={pageKey}
          ref={pageRef}
          tabIndex={-1}
          className="fade-in flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 pb-6 text-body text-ink outline-none lg:px-4 lg:pb-4"
        >
          {body}
        </div>
      </div>
    </Sheet>
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

/** 发给新用户开 Pupu 的码。别的 Pupu 的创建者，接口回 403，list 一直是 null，「账户」里就没有这一行。 */
function useInvites(enabled: boolean) {
  const [list, setList] = useState<InviteList | null>(null);
  const load = useCallback(() => api.invites().then(setList), []);
  useEffect(() => {
    if (enabled) load().catch(() => setList(null));
  }, [enabled, load]);
  return { list, load };
}

/** 首页最上面自己那一行：头像 42、名字，下面「账户、连上的服务」，行高 64。 */
function SelfRow({ name, avatar, onPress }: { name: string; avatar: string | null; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex min-h-16 w-full items-center gap-3 px-4 py-2.5 text-left pointer-fine:hover:bg-line"
    >
      <MemberAvatar name={name} src={avatar} className="size-10.5 bg-surface text-headline" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-headline">{name}</span>
        <span className="truncate text-subheadline text-ink-muted">账户、连上的服务</span>
      </span>
      <ChevronRightIcon className="shrink-0 text-[12px] text-ink-faint" />
    </button>
  );
}

/** 点进下一页的一行：图标 20、名字，右边一句摘要（或别的东西）和 ›。行高 52，电脑档 44。 */
function LinkRow({
  icon,
  title,
  detail,
  dot,
  summary,
  trailing,
  onPress
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
  /** 在不在线：给了就在 detail 前面画一个点。 */
  dot?: boolean;
  summary?: string;
  /** 摘要换成别的，比如头像。 */
  trailing?: ReactNode;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex min-h-13 w-full items-center gap-3 px-4 py-2 text-left pointer-fine:min-h-11 pointer-fine:hover:bg-line"
    >
      {icon && <span className="grid size-5 shrink-0 place-items-center text-[20px]">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body">{title}</span>
        {detail && (
          <span className="flex items-center gap-1.5 text-subheadline text-ink-muted">
            {dot !== undefined && <Dot online={dot} />}
            <span className="truncate">{detail}</span>
          </span>
        )}
      </span>
      {summary && <span className="shrink-0 text-subheadline text-ink-muted">{summary}</span>}
      {trailing}
      <ChevronRightIcon className="shrink-0 text-[12px] text-ink-faint" />
    </button>
  );
}

/** 只给人看的一行：名字，右边一句（subheadline、ink-muted）。 */
function ValueRow({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex min-h-13 items-center gap-3 px-4 py-2 pointer-fine:min-h-11">
      <span className="shrink-0 text-body">{title}</span>
      <span className="min-w-0 flex-1 truncate text-right text-subheadline text-ink-muted">{value}</span>
    </div>
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

/** 吊销、移除前的那一句确认，和两个按钮：网页和电脑 App 不弹窗，展开在这一行下面。 */
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
      <p className="m-0 text-subheadline text-ink-muted">{text}</p>
      <div className="flex justify-end gap-2">
        <button type="button" disabled={sending} onClick={onCancel} className={PILL_CANCEL}>
          取消
        </button>
        <button type="button" disabled={sending} onClick={onConfirm} className={PILL_DANGER}>
          {sending && <Spinner size="sm" color="current" aria-label="正在处理" className="size-3.5" />}
          {label}
        </button>
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
          {detail && <div className="truncate text-subheadline text-ink-muted">{detail}</div>}
        </div>
        {!row.confirming && account.removable && (
          <button
            type="button"
            aria-label={`断开${label}`}
            className={`${TEXT_BUTTON} text-danger-ink`}
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
          <div className="text-subheadline text-ink-muted">{service.detail}</div>
        </div>
        {connectable && (
          <button type="button" disabled={row.sending} onClick={connect} className={PILL_ROW}>
            {row.sending && <Spinner size="sm" color="current" aria-label="正在打开" className="size-3.5" />}
            连接
          </button>
        )}
      </div>
      <RowError error={row.error} />
    </div>
  );
}

/**
 * 电脑那一块里能改的一行（规范 ComputerRow）：名字在左，当前那一档写在右边（subheadline、ink-muted）。
 * 点哪里都打开系统自带的选择框：它盖满整行、看不见，读屏和键盘照常用它。不能选的档灰掉。
 */
function SelectRow<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  disabled,
  onChange
}: {
  label: string;
  ariaLabel: string;
  value: T;
  options: readonly { readonly value: T; readonly name: string; readonly disabled: boolean }[];
  disabled: boolean;
  onChange: (next: T) => void;
}) {
  return (
    <label className="relative flex min-h-13 items-center gap-2 px-4 py-2 pointer-fine:min-h-11 has-enabled:pointer-fine:hover:bg-line has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-ink">
      <span className="min-w-0 flex-1 text-body">{label}</span>
      <span className="shrink-0 text-subheadline text-ink-muted">{options.find((option) => option.value === value)?.name}</span>
      <ChevronDownIcon className="shrink-0 text-[11px] text-ink-faint" />
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value as T;
          if (next !== value) onChange(next);
        }}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0 disabled:cursor-default"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 这台设备上能不能按确认：网页要有一把通行密钥，连过手机的去手机上确认。null 是能。 */
function remoteConfirmable(confirmBy: ConfirmWhere, passkeys: Passkeys | null): string | null {
  if (confirmBy === "here") return null;
  if (confirmBy === "phone") return "要远程控制前确认，在手机 App 上改。";
  return passkeys && passkeys.keys.length > 0 ? null : "要远程控制前确认，先加一把通行密钥。";
}

/**
 * 一台电脑（规范 ComputerRow）：一块 surface-inset，头一行是电脑图标、名字和状态词，下面是「远程控制」，
 * 再往下是「Pupu 用它之前问我」、主人自己的「远程控制前」和「吊销」。电脑页上在线的每台一块，离线的点进去也是它。
 * 规范里在线时还有一张屏幕缩略图，云端现在没有这份数据，先不画（见 restyle 记录）。
 */
function ComputerPanel({
  computer,
  here,
  owner,
  actor,
  onRevoke,
  onSetPolicy,
  onSetRemoteConfirm,
  canConfirm,
  onClose
}: {
  computer: ComputerView;
  /** 就是眼前这台电脑（电脑 App 里）。 */
  here: boolean;
  /** 主人的名字。 */
  owner: string | null;
  actor: Actor | null | undefined;
  onRevoke: () => Promise<void>;
  onSetPolicy: (policy: ComputerPolicy) => Promise<void>;
  onSetRemoteConfirm: (level: RemoteConfirm) => Promise<void>;
  /** 选要确认的档位前，这里能不能确认：null 是能，不然是灰掉时的那句话。 */
  canConfirm: string | null;
  /** 关掉设置：远程桌面盖满整个窗口，设置弹窗还开着会抢走键盘焦点。 */
  onClose: () => void;
}) {
  const row = useRowAction();
  const policy = useRowAction();
  const remoteConfirm = useRowAction();
  const remote = useRemoteDesktop(computer.id);
  // 和 iOS 一样只给主人自己的电脑；离线的放一颗灰的胶囊。
  const mine = !here && computer.ownerId !== null && computer.ownerId === actor?.memberId;
  const ownerRow = actor === null || (computer.ownerId !== null && computer.ownerId === actor?.memberId);
  // 「在线 · 林夏的」；电脑 App 里眼前这台写「在线 · 这台电脑」，屏幕授权给了 Pupu 时接「屏幕已授权」。
  const status = [computerLabel(computer), here ? "这台电脑" : owner ? `${owner}的` : null, here && computer.screen ? "屏幕已授权" : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Group
      label={computer.name}
      note={canConfirm !== null && ownerRow ? canConfirm : undefined}
      error={policy.error ?? remoteConfirm.error ?? row.error}
    >
      <div className="flex flex-col gap-3 p-4" data-computer={computer.id}>
        <div className="flex items-center gap-3">
          <ComputerIcon className="shrink-0 text-[28px]" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-headline">{computer.name}</span>
            <span className="flex items-center gap-1.5 text-subheadline text-ink-muted">
              <Dot online={computer.online} />
              <span className="truncate">{status}</span>
            </span>
          </span>
        </div>
        {remote && remote !== "phone" ? (
          <button
            type="button"
            onClick={() => {
              openRemoteDesktop(computer.id, remote);
              if (remote !== "browser") onClose();
            }}
            className={`${PILL_ACTION} w-full`}
          >
            <CursorIcon />
            {remote === "browser" ? "在浏览器里远程控制" : "远程控制"}
          </button>
        ) : remote === "phone" ? (
          <p className="m-0 text-subheadline text-ink-muted">在手机 App 上远程控制这台电脑。</p>
        ) : mine && !computer.online ? (
          <div className="flex h-control w-full items-center justify-center rounded-full bg-action-off text-body font-semibold text-ink-muted">
            离线，连上才能远程控制
          </div>
        ) : null}
      </div>
      <SelectRow
        label="Pupu 用它之前问我"
        ariaLabel={`「${computer.name}」上什么时候先问你`}
        value={computer.policy}
        options={POLICIES.map(([value, name]) => ({
          value,
          name,
          disabled: !mayChangePolicy(computer.policy, value, actor, computer.ownerId)
        }))}
        disabled={policy.sending}
        onChange={(next) => void policy.run(() => onSetPolicy(next))}
      />
      {ownerRow && (
        <SelectRow
          label="远程控制前"
          ariaLabel={`远程控制「${computer.name}」前要不要确认`}
          value={computer.remoteConfirm}
          options={REMOTE_CONFIRMS.map(([value, name]) => ({
            value,
            name,
            disabled:
              (value !== "none" && canConfirm !== null) ||
              !mayChangeRemoteConfirm(computer.remoteConfirm, value, actor, computer.ownerId)
          }))}
          disabled={remoteConfirm.sending}
          onChange={(next) => void remoteConfirm.run(() => onSetRemoteConfirm(next))}
        />
      )}
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
            className="flex min-h-13 w-full items-center px-4 py-2 text-left text-body text-danger-ink pointer-fine:min-h-11 pointer-fine:hover:bg-line"
          >
            吊销
          </button>
        ))}
    </Group>
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
    <div className="flex min-h-13 flex-col justify-center gap-2 px-4 py-2.5 pointer-fine:min-h-11">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="text-body [overflow-wrap:anywhere]">
            {device.name}
            {device.current && (
              <span className="text-ink-muted">{device.kind === "desktop" ? " · 这个窗口" : " · 这个浏览器"}</span>
            )}
          </div>
          <div className="text-subheadline text-ink-muted">
            {deviceParts(device).map((part, index, parts) => (
              <Fragment key={index}>
                <span className="whitespace-nowrap">{index < parts.length - 1 ? `${part} ·` : part}</span>
                {index < parts.length - 1 && " "}
              </Fragment>
            ))}
          </div>
        </div>
        {!row.confirming && mayRevoke(actor, device.memberId) && (
          <button type="button" className={`${TEXT_BUTTON} text-danger-ink`} onClick={row.confirm}>
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
        <MemberAvatar name={member.name} src={member.avatar} className="size-8 bg-surface text-footnote font-semibold" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body">
            {member.email}
            {member.current && <span className="text-ink-muted"> · 你</span>}
          </div>
          <div className="text-subheadline text-ink-muted">
            {member.role === "creator" ? "创建者" : member.joinedAt ? "成员" : "成员 · 还没登录过"}
          </div>
        </div>
        {!row.confirming && mayRemoveMember(actor, member) && (
          <button type="button" className={`${TEXT_BUTTON} text-danger-ink`} onClick={row.confirm}>
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
            className="field flex-1"
          />
          <button type="submit" disabled={inviting || !email.trim()} className={PILL_ACTION}>
            {inviting && <Spinner size="sm" color="current" aria-label="正在邀请" className="size-4" />}
            邀请
          </button>
        </form>
      ) : how === "browser" ? (
        <button type="button" onClick={openInBrowser} className={`${PILL_SECONDARY} self-start`}>
          在浏览器里邀请
        </button>
      ) : (
        actor?.role === "creator" && <Note>邀请成员要在手机 App 的设置里做。</Note>
      )}
      {error && <p className="m-0 px-1 text-subheadline text-danger-ink">{error}</p>}
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
            <div key={invite.code} className="flex min-h-13 items-center gap-3 px-4 py-2.5 pointer-fine:min-h-11">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-body">{invite.code}</div>
                {invite.usedBy && <div className="truncate text-subheadline text-ink-muted">{invite.usedBy}</div>}
              </div>
              {!invite.usedBy && (
                <>
                  <button
                    type="button"
                    className={`${TEXT_BUTTON} text-ink`}
                    onClick={() => {
                      void navigator.clipboard?.writeText(invite.code);
                      setCopied(invite.code);
                    }}
                  >
                    {copied === invite.code ? "已复制" : "复制"}
                  </button>
                  <button
                    type="button"
                    className={`${TEXT_BUTTON} text-danger-ink`}
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
      <Group note={`还能生成 ${list.left} 个。新用户填码就能开自己的 Pupu。`} error={error}>
        <button
          type="button"
          disabled={creating || list.left === 0}
          onClick={() => void create()}
          className={ROW_BUTTON}
        >
          {creating ? "正在生成…" : "生成邀请码"}
        </button>
      </Group>
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
            <div key={key.id} className="flex min-h-13 flex-col justify-center gap-0.5 px-4 py-2.5 pointer-fine:min-h-11">
              <div className="truncate text-body">{key.name}</div>
              <div className="truncate text-subheadline text-ink-muted">
                {key.lastUsedAt ? `${ago(key.lastUsedAt)}用过` : `${ago(key.createdAt)}加的`}
              </div>
            </div>
          ))}
        </Group>
      )}
      <Group note="没有手机时，允许 Pupu 的请示、放宽电脑权限、邀请成员，都用通行密钥确认：按指纹或输电脑密码。" error={row.error}>
        <button type="button" disabled={row.sending} onClick={add} className={ROW_BUTTON}>
          {confirmBy === "browser" ? "在浏览器里加" : row.sending ? "正在加…" : "加一把通行密钥"}
        </button>
      </Group>
    </>
  );
}

/** 比如「手机 · a@gmail.com · 3 分钟前用过」，一段一段给，放不下在「·」处折行。邮箱是这台设备属于的成员。 */
function deviceParts(device: DeviceView): string[] {
  const seen = device.lastSeenAt ? `${ago(device.lastSeenAt)}用过` : null;
  return [DEVICE_KINDS[device.kind], device.member, seen].filter((part): part is string => Boolean(part));
}

/**
 * 连接新设备（规范 Devices）：生成一个配对码，手机扫二维码或者填码，浏览器和电脑 App 填码。
 * 连过手机以后，网页生成的码配不了新手机（见 `mayPair`），要在旧手机上生成。
 * 用这个码的设备连上了，或者码过期了，就自己收起来。「收起」只是收起来，码在用掉或过期之前仍然有效，照样等它连上。
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
  const [collapsed, setCollapsed] = useState(false);
  const [joined, setJoined] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= pairing.expiresAt) window.clearInterval(timer);
    }, 1000);
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
      setCollapsed(false);
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

  if (pairing && left > 0 && !collapsed) {
    return (
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <QrCode text={link} label="配对二维码，用 iPhone 相机扫" />
          <div className="flex min-w-0 flex-col gap-1">
            <div className="font-mono text-title font-semibold tracking-[0.05em]" aria-label="配对码">
              {pairing.code}
            </div>
            <div className="text-subheadline text-ink-muted" aria-live="polite">
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} 后过期
            </div>
          </div>
        </div>
        <p className="m-0 text-subheadline text-ink-muted">
          手机扫码或在 App 里填码，浏览器和电脑 App 填码。连过手机的，新手机要用旧手机设置里生成的码。
        </p>
        <div className="flex justify-end">
          <button type="button" onClick={() => setCollapsed(true)} className={`${PILL} h-8 px-3.5 text-ink pointer-fine:hover:bg-line`}>
            收起
          </button>
        </div>
      </div>
    );
  }
  const expired = pairing !== null && left === 0;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void create()}
      className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left enabled:pointer-fine:hover:bg-line"
    >
      <span className="text-body font-semibold text-ink">
        {busy ? "正在生成…" : joined || expired ? "再生成一个配对码" : "生成配对码"}
      </span>
      <span className={`text-subheadline ${error ? "text-danger-ink" : "text-ink-muted"}`}>
        {error ??
          (joined
            ? `「${joined}」连上了。`
            : expired
              ? "配对码已过期。"
              : "新手机、浏览器和电脑都用配对码连上。码 10 分钟内有效，用一次就作废。")}
      </span>
    </button>
  );
}

/** 二维码：两种主题都是白底 #ffffff、黑块 #000000，相机才认得出来（规范 Devices 写明的例外，不换成 token）。 */
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

/**
 * 这个账号在的几个 Pupu，点一下切过去（docs/协作方案.md 第 1 节：人人有自己的，能进别人的）。规范 SettingsSheet「换一个 Pupu」：
 * 每个 Pupu 一行，那个 Pupu 的头像 28、名字、右边「N 人」，当前的打勾；最后一行「开自己的 Pupu」，在行里填邀请码。
 * 只有一个、也开不了自己的时候不显示。切完重新载入：网页的凭据和连接都跟着 Pupu 走。
 */
function Orgs({ open, pupuAvatar }: { open: boolean; pupuAvatar: string | null }) {
  const [list, setList] = useState<OrgList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .orgs()
      .then((next) => live && setList(next))
      .catch(() => live && setList(null));
    return () => {
      live = false;
    };
  }, [open]);

  async function go(key: string, work: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await work();
      window.location.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  }

  if (!list || (list.orgs.length < 2 && !list.canOpenOwn)) return null;
  const row = "flex min-h-13 w-full items-center gap-3 px-4 py-2 text-left pointer-fine:min-h-11";
  return (
    <Group label="换一个 Pupu" inset="org" error={error}>
      {list.orgs.map((org) => (
        <button
          key={org.id}
          type="button"
          disabled={busy !== null}
          aria-current={org.current ? "true" : undefined}
          onClick={() => !org.current && void go(org.id, () => api.switchOrg(org.id))}
          className={`${row} enabled:pointer-fine:hover:bg-line`}
        >
          {/* 自己这个 Pupu 的头像在 state 里；别的 Pupu 只知道预设的猫，上传的图先用自带的猫。 */}
          <PupuAvatar src={org.current ? pupuAvatar : (org.avatar ?? null)} className="size-7" />
          <span className="min-w-0 flex-1 truncate text-body">{org.name}</span>
          <span className="shrink-0 text-subheadline text-ink-muted">{busy === org.id ? "正在切换…" : `${org.members} 人`}</span>
          <CheckIcon className={`shrink-0 text-[16px] ${org.current ? "" : "invisible"}`} aria-label={org.current ? "当前" : undefined} />
        </button>
      ))}
      {list.canOpenOwn &&
        (opening ? (
          <form
            className={row}
            onSubmit={(event) => {
              event.preventDefault();
              void go("own", () => api.openOwnOrg(code));
            }}
          >
            <span className="grid size-7 shrink-0 place-items-center text-[16px]">
              <PlusIcon />
            </span>
            <input
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="邀请码"
              aria-label="邀请码"
              className="min-w-0 flex-1 bg-transparent font-mono text-body outline-none placeholder:text-ink-muted"
            />
            <button type="submit" disabled={busy !== null || code.trim().length < 8} className={`${PILL} h-8 bg-action px-3.5 text-on-action disabled:bg-action-off disabled:text-ink-muted disabled:opacity-100`}>
              {busy === "own" && <Spinner size="sm" color="current" aria-label="正在开" className="size-3.5" />}
              开
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setOpening(true)} className={`${row} pointer-fine:hover:bg-line`}>
            <span className="grid size-7 shrink-0 place-items-center text-[16px]">
              <PlusIcon />
            </span>
            <span className="min-w-0 flex-1 truncate text-body">开自己的 Pupu</span>
          </button>
        ))}
    </Group>
  );
}
