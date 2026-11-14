import { Label, Switch } from "@heroui/react";
import { Fragment, useEffect, useState, type ReactNode, type SVGProps } from "react";
import type { Level } from "../access";
import type { MemberView } from "../members";
import type { SpaceMode } from "../projects";
import type { ChildView, ProjectView } from "../server";
import { SPACE_COLORS, SPACE_ICONS, type SpaceColor, type SpaceIcon } from "../space-look";
import type { SpaceChange } from "../spaces";
import { ago } from "./ago";
import { MemberAvatar, PUPU_AVATAR } from "./Avatar";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, FileIcon, MenuIcon, PlusIcon } from "./icons";
import { Sheet, SheetClose } from "./Sheet";
import { SPACE_ICON_PATHS } from "./space-icons";

/**
 * 空间出现的地方：电脑的侧栏（SpaceSidebar）、手机的切换 sheet（SpaceSwitcher）、手机顶栏（SpaceHeader）、
 * 电脑主卡片的头一行、空间设置（SpaceSettings）。空间名前面都是 SpaceMark。照设计规范的同名组件。
 */

export function BuildingIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="4" y="3" width="12" height="15" rx="1.5" />
      <path d="M8 7h1M11 7h1M8 10h1M11 10h1M9 18v-3h2v3" />
    </svg>
  );
}

export function isOpenLevel(level: Level): boolean {
  return level === "L1" || level === "L2";
}

/** 这个人是不是空间的主人。老项目没有主人。 */
export function ownsSpace(space: ProjectView, me: MemberView | undefined): boolean {
  return me !== undefined && space.ownerId === me.id;
}

type ChildState = "waiting" | "working" | "done" | "idle";

export function childState(child: ChildView): ChildState {
  if (child.waiting) return "waiting";
  if (child.busy) return "working";
  return child.reportedAt === null ? "idle" : "done";
}

const CHILD_LABELS: Record<ChildState, string> = { waiting: "等你批准", working: "正在做", done: "做完了", idle: "还没开始" };

export function childLabel(child: ChildView): string {
  return CHILD_LABELS[childState(child)];
}

/** 状态圆点：正在做是墨色，等你批准是 warning，做完了是 online。旁边一定写字。 */
export function ChildDot({ child, className = "" }: { child: ChildView; className?: string }) {
  const color = { waiting: "bg-warning", working: "bg-action", done: "bg-online", idle: "bg-offline" }[childState(child)];
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${color} ${className}`} />;
}

export const COLOR_NAMES: Record<SpaceColor, string> = {
  mist: "雾蓝",
  sage: "鼠尾草",
  apricot: "杏",
  lilac: "丁香",
  lemon: "柠檬",
  graphite: "石墨"
};

export const ICON_NAMES: Record<SpaceIcon, string> = {
  folder: "文件夹",
  rocket: "火箭",
  house: "房子",
  book: "书",
  briefcase: "公文包",
  code: "代码",
  chart: "图表",
  palette: "调色板",
  music: "音符",
  camera: "相机",
  leaf: "叶子",
  globe: "地球",
  heart: "爱心",
  star: "星星",
  coffee: "咖啡",
  gift: "礼物",
  bulb: "灯泡",
  flag: "旗子",
  chat: "对话",
  paw: "爪印"
};

/** Tailwind 只认写全的类名，颜色 id 不能拼进类名里。 */
const MARK_BG: Record<SpaceColor, string> = {
  mist: "bg-mark-mist",
  sage: "bg-mark-sage",
  apricot: "bg-mark-apricot",
  lilac: "bg-mark-lilac",
  lemon: "bg-mark-lemon",
  graphite: "bg-mark-graphite"
};
const SWATCH_BG: Record<SpaceColor, string> = {
  mist: "bg-space-mist",
  sage: "bg-space-sage",
  apricot: "bg-space-apricot",
  lilac: "bg-space-lilac",
  lemon: "bg-space-lemon",
  graphite: "bg-space-graphite"
};

/** 空间的样子。部署之后头几分钟老 DO 发来的状态里可能没有颜色和图标，按雾蓝、没图标画。 */
type Look = { readonly name: string; readonly color?: SpaceColor; readonly icon?: SpaceIcon | null };

export function colorOf(space: Look): SpaceColor {
  return space.color && space.color in MARK_BG ? space.color : "mist";
}

function iconOf(space: Look): SpaceIcon | null {
  return space.icon && space.icon in SPACE_ICON_PATHS ? space.icon : null;
}

function PixelIcon({ icon }: { icon: SpaceIcon }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={SPACE_ICON_PATHS[icon]} />
    </svg>
  );
}

/** SpaceMark：空间原色的方块里一个像素图标，没图标写名字的第一个字。不单独读，和空间名合成一个元素。 */
export function SpaceMark({ space, large = false }: { space: Look; large?: boolean }) {
  const icon = iconOf(space);
  return (
    <span aria-hidden="true" className={`${large ? "space-mark-lg" : "space-mark"} ${MARK_BG[colorOf(space)]}`}>
      {icon ? <PixelIcon icon={icon} /> : Array.from(space.name)[0]}
    </span>
  );
}

/** 叠起来的成员头像，最多三个，彼此压 7，外描一圈 2 的底色（`ring` 给出底色）。 */
export function AvatarStack({
  ids,
  members,
  size = "size-avatar-sm",
  ring,
  fill = "bg-surface-inset"
}: {
  ids: readonly string[];
  members: readonly MemberView[];
  size?: string;
  ring: string;
  /** 没换头像的写首字，垫一个和底色分得开的圆。 */
  fill?: string;
}) {
  const shown = ids.map((id) => members.find((member) => member.id === id)).filter((member) => member !== undefined).slice(0, 3);
  return (
    <span className="flex shrink-0" aria-hidden="true">
      {shown.map((member, index) => (
        <MemberAvatar
          key={member.id}
          name={member.name}
          src={member.avatar}
          className={`${size} ${fill} text-[11px] font-semibold ring-2 ${ring} ${index > 0 ? "-ml-1.75" : ""}`}
        />
      ))}
    </span>
  );
}

/** 空间名后面的成员：全组织可见的是楼，其余是成员头像。 */
function Members({ space, members, ring, size, fill }: { space: ProjectView; members: readonly MemberView[]; ring: string; size?: string; fill?: string }) {
  if (isOpenLevel(space.level)) return <BuildingIcon role="img" aria-label="全组织" className="shrink-0 text-[1.25em] text-ink-muted" />;
  return <AvatarStack ids={space.members} members={members} ring={ring} size={size} fill={fill} />;
}

/** 未读：6 的墨色圆点，跟着加粗的名字。 */
function UnreadDot() {
  return <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-ink" />;
}

/** 侧栏和切换列表都要的：现在在哪、有没有未读。 */
export type Place = "pupu" | "docs" | string;

type NavProps = {
  /** 全员在前的空间列表。 */
  spaces: readonly ProjectView[];
  members: readonly MemberView[];
  me: MemberView | undefined;
  pupuAvatar: string | null;
  current: Place | null;
  unread: { readonly pupu: boolean; readonly spaces: ReadonlySet<string> };
  onPupu: () => void;
  onDocs: () => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onSettings: () => void;
};

/**
 * 电脑上的左侧栏，直接画在窗框上，没有自己的底。红绿灯那一行留空；「我的 Pupu」、「资料」，
 * 「空间」组标题和「+」，每个空间一行，最下面是自己（点开设置）。子会话不进侧栏。
 */
export function SpaceSidebar({ spaces, members, me, pupuAvatar, current, unread, onPupu, onDocs, onOpen, onCreate, onSettings }: NavProps) {
  const row = (selected: boolean, bold = false) =>
    `flex h-control w-full shrink-0 items-center gap-2 rounded-selected-pointer px-2.5 text-left text-body ${selected ? "bg-selected shadow-selected" : "hover:bg-selected/50"} ${bold ? "font-semibold" : ""}`;
  return (
    <nav aria-label="空间" className="sidebar hidden w-sidebar shrink-0 flex-col gap-0.5 overflow-y-auto px-2 pb-3 lg:flex">
      <button type="button" onClick={onPupu} aria-current={current === "pupu" ? "page" : undefined} className={row(current === "pupu", unread.pupu)}>
        <MemberAvatar name="Pupu" src={pupuAvatar ?? PUPU_AVATAR} className="size-mark" />
        <span className="min-w-0 flex-1 truncate">我的 Pupu</span>
        {unread.pupu && <UnreadDot />}
      </button>
      <button type="button" onClick={onDocs} aria-current={current === "docs" ? "page" : undefined} className={row(current === "docs")}>
        <span className="grid size-mark shrink-0 place-items-center text-[16px] text-ink-muted">
          <FileIcon />
        </span>
        <span className="min-w-0 flex-1 truncate">资料</span>
      </button>
      <div className="flex items-center justify-between pt-3.5 pb-1 pl-2.5 text-footnote text-ink-muted">
        <span>空间</span>
        <button
          type="button"
          aria-label="新空间"
          onClick={onCreate}
          className="tap grid size-control-sm place-items-center rounded-full text-[14px] hover:bg-selected/50"
        >
          <PlusIcon />
        </button>
      </div>
      {spaces.map((space) => {
        const selected = space.id === current;
        const fresh = unread.spaces.has(space.id);
        return (
          <button
            key={space.id}
            type="button"
            onClick={() => onOpen(space.id)}
            aria-current={selected ? "page" : undefined}
            aria-label={fresh ? `${space.name}，有新消息` : space.name}
            className={row(selected, selected || fresh)}
          >
            <SpaceMark space={space} />
            <span className="min-w-0 flex-1 truncate">{space.name}</span>
            <Members space={space} members={members} ring={selected ? "ring-surface" : "ring-frame"} size="size-4.5" />
            {fresh && <UnreadDot />}
          </button>
        );
      })}
      <button type="button" onClick={onSettings} aria-label="设置" className={`${row(false)} mt-auto`}>
        <MemberAvatar name={me?.name ?? "我"} src={me?.avatar ?? null} className="size-avatar-sm bg-surface-inset text-[11px] font-semibold" />
        <span className="min-w-0 flex-1 truncate">{me?.name ?? "设置"}</span>
      </button>
    </nav>
  );
}

/** 切换列表里的一行：高 52，左右 16。 */
function SwitchRow({
  onClick,
  selected,
  label,
  children
}: {
  onClick: () => void;
  selected?: boolean;
  label?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "page" : undefined}
      aria-label={label}
      className="flex min-h-13 w-full items-center gap-3 px-4 text-left active:bg-ink/5 pointer-fine:hover:bg-ink/4"
    >
      {children}
    </button>
  );
}

/** 分组里行和行之间的线，从左边 48 开始。 */
function Divider({ inset = "ml-12" }: { inset?: string }) {
  return <div aria-hidden="true" className={`${inset} h-px bg-line`} />;
}

function Current({ on }: { on: boolean }) {
  return on ? <CheckIcon role="img" aria-label="当前" className="shrink-0 text-[16px] text-ink" /> : <span className="w-4 shrink-0" />;
}

/**
 * 手机上切换会话的 sheet：「我的 Pupu」和资料一组，空间一组，每个空间下面挂着正在做和等你批准的子会话。
 * 点一行就切过去，sheet 收起。设置在最底下，从自己的头像进。
 */
export function SpaceSwitcher({
  isOpen,
  onClose,
  onOpenChild,
  ...nav
}: NavProps & { isOpen: boolean; onClose: () => void; onOpenChild: (id: string, session: string) => void }) {
  const { spaces, members, me, pupuAvatar, current, unread } = nav;
  return (
    <Sheet isOpen={isOpen} onClose={onClose} label="切换">
      <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-3.5 pt-2 pb-6">
        <div className="overflow-hidden rounded-row bg-surface-inset">
          <SwitchRow onClick={nav.onPupu} selected={current === "pupu"} label={unread.pupu ? "我的 Pupu，有新消息" : undefined}>
            <MemberAvatar name="Pupu" src={pupuAvatar ?? PUPU_AVATAR} className="size-7.5" />
            <span className="min-w-0 flex-1 truncate text-headline">我的 Pupu</span>
            {unread.pupu && <UnreadDot />}
            <Current on={current === "pupu"} />
          </SwitchRow>
          <Divider inset="ml-15.5" />
          <SwitchRow onClick={nav.onDocs} selected={current === "docs"}>
            <span className="grid size-7.5 shrink-0 place-items-center text-[20px] text-ink-muted">
              <FileIcon />
            </span>
            <span className="min-w-0 flex-1 truncate text-body">资料</span>
            <Current on={current === "docs"} />
          </SwitchRow>
        </div>
        <div className="flex items-center justify-between px-1">
          <span className="text-footnote text-ink-muted">空间</span>
          <button type="button" onClick={nav.onCreate} className="tap flex h-control items-center gap-1 text-subheadline font-semibold">
            <PlusIcon className="text-[14px]" />
            新空间
          </button>
        </div>
        <div className="overflow-hidden rounded-row bg-surface-inset">
          {spaces.map((space, index) => {
            const selected = space.id === current;
            const fresh = unread.spaces.has(space.id);
            const going = space.children.filter((child) => child.busy || child.waiting);
            return (
              <Fragment key={space.id}>
                {index > 0 && <Divider />}
                <SwitchRow onClick={() => nav.onOpen(space.id)} selected={selected} label={fresh ? `${space.name}，有新消息` : undefined}>
                  <SpaceMark space={space} />
                  <span className={`min-w-0 flex-1 truncate text-body ${selected || fresh ? "font-semibold" : ""}`}>{space.name}</span>
                  {fresh && <UnreadDot />}
                  <Members space={space} members={members} ring="ring-surface-inset" fill="bg-surface" />
                  <Current on={selected} />
                </SwitchRow>
                {going.map((child) => (
                  <button
                    key={child.session}
                    type="button"
                    onClick={() => onOpenChild(space.id, child.session)}
                    className="flex h-10 w-full items-center gap-2.5 pr-4 pl-12 text-left text-subheadline active:bg-ink/5 pointer-fine:hover:bg-ink/4"
                  >
                    <ChildDot child={child} />
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                    <span className="shrink-0 text-footnote text-ink-muted">{childLabel(child)}</span>
                  </button>
                ))}
              </Fragment>
            );
          })}
        </div>
        <div className="overflow-hidden rounded-row bg-surface-inset">
          <SwitchRow onClick={nav.onSettings} label="设置">
            <MemberAvatar name={me?.name ?? "我"} src={me?.avatar ?? null} className="size-7.5 bg-surface text-footnote font-semibold" />
            <span className="min-w-0 flex-1 truncate text-body">{me?.name ?? "设置"}</span>
            <ChevronRightIcon className="shrink-0 text-[14px] text-ink-faint" />
          </SwitchRow>
        </div>
      </div>
    </Sheet>
  );
}

/** 顶栏左右的圆按钮：40，selected 底加 shadow-selected，实色，不用玻璃。 */
const BAR_BUTTON = "tap relative grid size-10 shrink-0 place-items-center rounded-full bg-selected text-[17px] text-ink shadow-selected";

/** 手机顶栏左边的切换按钮。别处有新消息时右上角一个墨色小点。 */
export function SwitchButton({ onPress, unread, expanded }: { onPress: () => void; unread: boolean; expanded: boolean }) {
  return (
    <button
      type="button"
      aria-label={unread ? "切换，有新消息" : "切换"}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onPress}
      className={BAR_BUTTON}
    >
      <MenuIcon />
      {unread && <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-ink" />}
    </button>
  );
}

export function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onPress} className={BAR_BUTTON}>
      <ChevronLeftIcon />
    </button>
  );
}

/**
 * 手机上会话顶部的导航，直接画在窗框上，没有自己的底：左边一个圆按钮，中间是在哪，右边成员胶囊（可以没有）。
 * 电脑的窄窗口也用它，给红绿灯让出左边。
 */
export function SpaceHeader({ leading, children, trailing, child = false }: { leading: ReactNode; children?: ReactNode; trailing?: ReactNode; child?: boolean }) {
  return (
    <header className="pt-safe shrink-0 lg:hidden">
      <div className="titlebar-lead flex h-13 items-center gap-2 px-3.5">
        {leading}
        {/* 子会话的两行字靠左跟着返回，右边空着；别的居中，右边没有成员时留一个按钮的位置。 */}
        <div className={`flex min-w-0 flex-1 items-center gap-2 ${child ? "" : "justify-center"}`}>{children}</div>
        {!child && (trailing ?? <span aria-hidden="true" className="size-10 shrink-0" />)}
      </div>
    </header>
  );
}

/** 顶栏中间、电脑卡片头：标记方块（或 Pupu 头像）加名字，合成一个元素读。 */
export function PlaceTitle({ space, pupuAvatar, docs = false }: { space?: ProjectView; pupuAvatar?: string | null; docs?: boolean }) {
  if (space) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <SpaceMark space={space} />
        <span className="truncate text-headline">{space.name}</span>
      </span>
    );
  }
  if (docs) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <span className="grid size-mark shrink-0 place-items-center text-[16px] text-ink-muted">
          <FileIcon />
        </span>
        <span className="truncate text-headline">资料</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <MemberAvatar name="Pupu" src={pupuAvatar ?? PUPU_AVATAR} className="size-6.5 pointer-fine:size-mark" />
      <span className="truncate text-headline">我的 Pupu</span>
    </span>
  );
}

/** 子会话的标题：名字，下面状态圆点加状态词和时间。 */
export function ChildTitle({ child }: { child: ChildView }) {
  const when = child.reportedAt ?? child.createdAt;
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-px">
      <span className="truncate text-headline">{child.title}</span>
      <span className="flex items-center gap-1.5 text-footnote text-ink-muted">
        <ChildDot child={child} />
        <span className="truncate">
          {childLabel(child)} · {ago(when)}
        </span>
      </span>
    </span>
  );
}

/** 顶栏右边的成员胶囊（selected 底），点开空间设置。 */
export function MembersCapsule({ space, members, onPress }: { space: ProjectView; members: readonly MemberView[]; onPress?: () => void }) {
  const count = isOpenLevel(space.level) ? "全组织" : `成员 ${space.members.length} 人`;
  const look = "flex h-10 shrink-0 items-center rounded-full bg-selected px-2.25 text-[16px] shadow-selected";
  // 没什么可设的（全员，自己又不是创建者）时只是一块标识，不能点。
  if (!onPress) {
    return (
      <span role="img" aria-label={count} className={look}>
        <Members space={space} members={members} ring="ring-selected" />
      </span>
    );
  }
  return (
    <button type="button" aria-label={`${count}，空间设置`} onClick={onPress} className={`tap ${look}`}>
      <Members space={space} members={members} ring="ring-selected" />
    </button>
  );
}

/**
 * 电脑主卡片的头一行：在哪（标记和名字）、成员、「邀请」。点成员或「邀请」打开空间设置。
 * 子会话卡另有自己的头。
 */
export function CardHead({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="hidden h-12 shrink-0 items-center gap-2 px-4 lg:flex">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {trailing}
    </div>
  );
}

export function CardMembers({ space, members, mine, onPress }: { space: ProjectView; members: readonly MemberView[]; mine: boolean; onPress?: () => void }) {
  const count = isOpenLevel(space.level) ? "全组织" : `成员 ${space.members.length} 人`;
  return (
    <>
      {onPress ? (
        <button type="button" aria-label={`${count}，空间设置`} onClick={onPress} className="tap flex shrink-0 items-center rounded-full p-1 text-[14px] hover:bg-ink/4">
          <Members space={space} members={members} ring="ring-surface" />
        </button>
      ) : (
        <span role="img" aria-label={count} className="flex shrink-0 items-center p-1 text-[14px]">
          <Members space={space} members={members} ring="ring-surface" />
        </span>
      )}
      {mine && onPress && (
        <button type="button" onClick={onPress} className="tap h-control shrink-0 rounded-full bg-surface-inset px-3 text-body font-semibold">
          邀请
        </button>
      )}
    </>
  );
}

const LEVEL_OPTIONS: readonly { level: Level; name: string; detail: string }[] = [
  { level: "L3", name: "只有成员", detail: "成员在自己的 Pupu 里也问得到" },
  { level: "L2", name: "全组织", detail: "组织里谁都能进来看" },
  { level: "L4", name: "机密", detail: "只在这个空间里说，Pupu 不往外带" }
];

/** 只派活：Pupu 不自己动手，把事交给子会话去做。默认关。规范没画，放在一组里。 */
function ModeSwitch({ mode, busy, detail, onChange }: { mode: SpaceMode; busy: boolean; detail: string; onChange: (mode: SpaceMode) => void }) {
  return (
    <div className="rounded-row bg-surface-inset px-4 py-3">
      <Switch isSelected={mode === "coordinator"} isDisabled={busy} onChange={(on) => onChange(on ? "coordinator" : "direct")}>
        <Switch.Content className="flex w-full items-center gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Label className="text-body text-ink">只派活</Label>
            <span className="text-subheadline text-ink-muted">{detail}</span>
          </span>
          <Switch.Control className="shrink-0">
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
    </div>
  );
}

/**
 * 一个空间的设置：标题（大号标记）、颜色、图标、成员和邀请、谁看得到。手机上点顶栏的成员胶囊，电脑上点卡片头的「邀请」。
 * 能改颜色和图标的是空间的主人，全员是组织的创建者；拉人、移人、改范围只有主人。全员没有成员和范围（全组织都在）。
 */
export function SpaceSettings({
  space,
  members,
  mine,
  mayLook,
  everyone,
  onClose,
  onChange
}: {
  space: ProjectView | undefined;
  members: readonly MemberView[];
  /** 是空间的主人（全员时是组织创建者）：能拉人、移人、改范围和模式。 */
  mine: boolean;
  /** 能换颜色和图标。 */
  mayLook: boolean;
  everyone: boolean;
  onClose: () => void;
  onChange: (change: SpaceChange) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 点了颜色和图标马上换上，不等云端回来。
  const [picked, setPicked] = useState<{ color?: SpaceColor; icon?: SpaceIcon }>({});
  const id = space?.id;
  useEffect(() => {
    setPicked({});
    setQuery("");
    setError(null);
  }, [id]);

  async function run(key: string, change: SpaceChange) {
    setBusy(key);
    setError(null);
    try {
      await onChange(change);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPicked({});
    } finally {
      setBusy(null);
    }
  }

  const look = space ? { name: space.name, color: picked.color ?? colorOf(space), icon: picked.icon ?? iconOf(space) } : null;
  const inSpace = new Set(space?.members ?? []);
  const needle = query.trim().toLowerCase();
  const people = members
    .filter((member) => mine || inSpace.has(member.id))
    .filter((member) => !needle || member.name.toLowerCase().includes(needle) || member.email.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.id === space?.ownerId) - Number(a.id === space?.ownerId) || Number(inSpace.has(b.id)) - Number(inSpace.has(a.id)));
  const chip = "tap h-8 shrink-0 rounded-full px-3.5 text-subheadline font-semibold";

  return (
    <Sheet isOpen={space !== undefined} onClose={onClose} label={space?.name ?? "空间设置"}>
      {space && look && (
        <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-3.5 pt-2 pb-6 lg:p-5">
          <div className="flex items-center gap-2.5">
            <SpaceMark space={look} large />
            <h2 className="m-0 min-w-0 flex-1 truncate text-title">{space.name}</h2>
            <SheetClose onClose={onClose} />
          </div>
          {mayLook && (
            <fieldset className="m-0 flex min-w-0 justify-between border-0 px-2 py-1.5">
              <legend className="sr-only">空间颜色</legend>
              {SPACE_COLORS.map((color) => (
                <label key={color} className="relative grid size-7.5 cursor-pointer place-items-center">
                  <input
                    type="radio"
                    name="space-color"
                    aria-label={COLOR_NAMES[color]}
                    checked={look.color === color}
                    disabled={busy !== null}
                    onChange={() => {
                      setPicked((current) => ({ ...current, color }));
                      void run("color", { kind: "color", color });
                    }}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className={`size-7.5 rounded-full ${SWATCH_BG[color]} ${look.color === color ? "swatch-on" : "swatch-edge"} peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-ink`}
                  />
                </label>
              ))}
            </fieldset>
          )}
          {mayLook && (
            <fieldset className="icon-strip m-0 flex min-w-0 gap-2.5 overflow-x-auto border-0 px-2 py-1">
              <legend className="sr-only">空间图标</legend>
              {SPACE_ICONS.map((icon) => (
                <label key={icon} className="relative grid size-9 shrink-0 cursor-pointer place-items-center">
                  <input
                    type="radio"
                    name="space-icon"
                    aria-label={ICON_NAMES[icon]}
                    checked={look.icon === icon}
                    disabled={busy !== null}
                    onChange={() => {
                      setPicked((current) => ({ ...current, icon }));
                      void run("icon", { kind: "icon", icon });
                    }}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className={`grid size-9 place-items-center rounded-full peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-ink [&_svg]:size-4 [&_svg]:[shape-rendering:crispEdges] ${look.icon === icon ? `${MARK_BG[look.color]} swatch-on text-on-mark` : "bg-surface-inset text-ink"}`}
                  >
                    <PixelIcon icon={icon} />
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {!everyone && mine && (
            <input
              type="search"
              aria-label="找人"
              placeholder="组织里的人"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-11 rounded-xl bg-surface-inset px-3.5 text-body text-ink outline-none placeholder:text-ink-muted"
            />
          )}
          {!everyone && people.length > 0 && (
            <ul className="m-0 flex list-none flex-col overflow-hidden rounded-row bg-surface-inset p-0">
              {people.map((member, index) => {
                const owner = member.id === space.ownerId;
                const joined = inSpace.has(member.id);
                return (
                  <li key={member.id} className="flex flex-col">
                    {index > 0 && <Divider inset="ml-15" />}
                    <div className="flex min-h-13 items-center gap-3 px-4">
                      <MemberAvatar name={member.name} src={member.avatar} className="size-8 bg-surface text-footnote font-semibold" />
                      <span className="min-w-0 flex-1 truncate text-body">{member.name}</span>
                      {owner ? (
                        <span className="text-subheadline text-ink-muted">建的人</span>
                      ) : !mine ? null : joined ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void run(member.id, { kind: "remove", memberId: member.id })}
                          className={`${chip} text-ink-muted hover:bg-ink/4`}
                        >
                          移出
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void run(member.id, { kind: "add", memberId: member.id })}
                          className={`${chip} bg-action text-on-action`}
                        >
                          邀请
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {!everyone && mine && (
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="mb-2 px-1 text-footnote text-ink-muted">谁看得到</legend>
              <div className="flex flex-col overflow-hidden rounded-row bg-surface-inset">
                {LEVEL_OPTIONS.map((option, index) => (
                  <Fragment key={option.level}>
                    {index > 0 && <Divider />}
                    <label className="flex cursor-pointer items-center gap-3 px-4 py-2.25">
                      <input
                        type="radio"
                        name="level"
                        checked={space.level === option.level}
                        disabled={busy !== null}
                        onChange={() => void run(option.level, { kind: "level", level: option.level })}
                        className="m-0 size-5 shrink-0 accent-ink"
                      />
                      <span className="flex flex-col gap-0.5">
                        <span className="text-body">{option.name}</span>
                        <span className="text-subheadline text-ink-muted">{option.detail}</span>
                      </span>
                    </label>
                  </Fragment>
                ))}
              </div>
            </fieldset>
          )}
          {mine && (
            <ModeSwitch
              mode={space.mode}
              busy={busy !== null}
              detail={everyone ? "Pupu 不自己动手，事情交给各个空间去做" : "Pupu 不自己动手，事情交给子会话去做"}
              onChange={(mode) => void run("mode", { kind: "mode", mode })}
            />
          )}
          {error && <div className="text-subheadline text-danger-ink">{error}</div>}
        </div>
      )}
    </Sheet>
  );
}

/** 主会话里派出去的一件事：状态点、标题、状态和结果一句，点进子会话。 */
export function TaskCard({ title, child, onOpen }: { title: string; child: ChildView | undefined; onOpen?: () => void }) {
  const detail = !child ? "正在派" : child.summary && childState(child) === "done" ? `${childLabel(child)} · ${child.summary}` : childLabel(child);
  return (
    <button
      type="button"
      disabled={!child || !onOpen}
      onClick={onOpen}
      className="bg-surface-inset flex w-full max-w-[85%] items-center gap-3 rounded-row px-4 py-3 text-left sm:max-w-120"
    >
      {child ? <ChildDot child={child} /> : <span className="size-2 shrink-0 rounded-full bg-offline" />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-semibold">{title}</span>
        <span className="truncate text-subheadline text-ink-muted">{detail}</span>
      </span>
      <ChevronRightIcon className="shrink-0 text-[14px] text-ink-muted" />
    </button>
  );
}
