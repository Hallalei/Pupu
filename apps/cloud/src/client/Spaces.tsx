import { Button, Modal } from "@heroui/react";
import { useState, type SVGProps } from "react";
import type { Level } from "../access";
import type { MemberView } from "../members";
import type { ChildView, ProjectView } from "../server";
import { WaitingChip } from "./Approvals";
import { MemberAvatar, PUPU_AVATAR } from "./Avatar";
import { ChevronRightIcon, CloseIcon, FileIcon, FolderIcon, PlusIcon } from "./icons";

/** 空间列表、空间顶上的成员、邀请和密级、主会话里的任务卡。照协作版原型（Design 画布 LZboTdB1BsShjQQY7rDuUH）。 */

export function BuildingIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
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

export function ChildDot({ child, className = "" }: { child: ChildView; className?: string }) {
  const color = { waiting: "bg-warning", working: "bg-foreground", done: "bg-online", idle: "bg-offline" }[childState(child)];
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${color} ${className}`} />;
}

/** 叠起来的成员头像，最多三个。 */
export function AvatarStack({ ids, members, size = "size-5.5" }: { ids: readonly string[]; members: readonly MemberView[]; size?: string }) {
  const shown = ids.map((id) => members.find((member) => member.id === id)).filter((member) => member !== undefined).slice(0, 3);
  return (
    <span className="flex shrink-0" aria-hidden="true">
      {shown.map((member, index) => (
        <MemberAvatar
          key={member.id}
          name={member.name}
          src={member.avatar}
          className={`${size} strong text-[11px] font-semibold outline-2 -outline-offset-1 outline-surface-strong ${index > 0 ? "-ml-1.5" : ""}`}
        />
      ))}
    </span>
  );
}

/** 一行空间后面的记号：全组织的是楼，其余是成员头像。 */
function SpaceMark({ space, members }: { space: ProjectView; members: readonly MemberView[] }) {
  if (isOpenLevel(space.level)) return <BuildingIcon role="img" aria-label="全组织" className="shrink-0 text-[18px] text-muted" />;
  return <AvatarStack ids={space.members} members={members} />;
}

/**
 * 「我的 Pupu」加空间列表。宽屏是侧栏，窄屏是 ≡ 打开的整页。当前空间展开它的子会话。
 */
export function SpaceList({
  spaces,
  members,
  waiting,
  current,
  currentChild,
  pupuAvatar,
  onPupu,
  docs,
  onDocs,
  onOpen,
  onOpenChild,
  onCreate,
  wide
}: {
  spaces: readonly ProjectView[];
  members: readonly MemberView[];
  waiting: ReadonlySet<string>;
  current: string | undefined;
  currentChild: string | undefined;
  pupuAvatar: string | null;
  onPupu: () => void;
  docs: boolean;
  onDocs: () => void;
  onOpen: (id: string) => void;
  onOpenChild: (id: string, session: string) => void;
  onCreate: () => void;
  wide: boolean;
}) {
  const row = wide
    ? "flex min-h-control w-full shrink-0 items-center gap-2 rounded-tag px-2.5 text-left text-body"
    : "flex min-h-13 w-full items-center gap-3 px-4 text-left text-body text-foreground active:bg-foreground/10";
  const hover = wide ? "hover:bg-foreground/6" : "";
  return (
    <nav aria-label="空间" className="flex flex-col gap-0.5">
      <button type="button" onClick={onPupu} className={`${row} ${hover} font-semibold`}>
        <MemberAvatar name="Pupu" src={pupuAvatar ?? PUPU_AVATAR} className="size-6.5" />
        我的 Pupu
      </button>
      <button
        type="button"
        onClick={onDocs}
        aria-current={docs ? "page" : undefined}
        className={`${row} ${docs ? (wide ? "bg-nav-current font-semibold" : "font-semibold") : hover}`}
      >
        <FileIcon className="shrink-0 text-[16px] text-muted" />
        资料
      </button>
      <div className={`mt-3 flex items-center justify-between ${wide ? "px-2.5" : "px-4"}`}>
        <span className="text-footnote font-medium text-muted">空间</span>
        <button
          type="button"
          aria-label="新空间"
          onClick={onCreate}
          className="tap grid size-8 place-items-center rounded-full text-[16px] hover:bg-foreground/6"
        >
          <PlusIcon />
        </button>
      </div>
      {spaces.map((space) => {
        const selected = space.id === current;
        return (
          <div key={space.id} className="flex flex-col">
            <button
              type="button"
              onClick={() => onOpen(space.id)}
              aria-current={selected && !currentChild ? "page" : undefined}
              className={`${row} ${selected ? (wide ? "bg-nav-current font-semibold" : "font-semibold") : hover}`}
            >
              <FolderIcon className="shrink-0 text-[16px] text-muted" />
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              {waiting.has(space.id) && <WaitingChip />}
              <SpaceMark space={space} members={members} />
            </button>
            {selected &&
              space.children.map((child) => (
                <button
                  key={child.session}
                  type="button"
                  onClick={() => onOpenChild(space.id, child.session)}
                  aria-current={child.session === currentChild ? "page" : undefined}
                  className={`flex min-h-8 w-full items-center gap-2 rounded-tag pr-2.5 text-left text-subheadline ${wide ? "pl-8" : "pl-12"} ${child.session === currentChild ? "bg-nav-current font-semibold" : hover}`}
                >
                  <ChildDot child={child} />
                  <span className="min-w-0 flex-1 truncate">{child.title}</span>
                  <span className="shrink-0 text-caption text-muted">{childLabel(child)}</span>
                </button>
              ))}
          </div>
        );
      })}
    </nav>
  );
}

/** 空间顶上那颗胶囊：名字、成员头像，主人多一个「邀请」。点头像看成员。 */
export function SpaceHeader({
  space,
  members,
  mine,
  onMembers
}: {
  space: ProjectView;
  members: readonly MemberView[];
  mine: boolean;
  onMembers: () => void;
}) {
  const managed = space.ownerId !== null;
  return (
    <span className="glass pointer-events-auto flex h-8 max-w-full items-center gap-2 rounded-full pr-1 pl-3 text-footnote text-foreground">
      <span className="truncate font-semibold">{space.name}</span>
      {managed && !isOpenLevel(space.level) && (
        <button type="button" aria-label="成员" onClick={onMembers} className="tap flex rounded-full">
          <AvatarStack ids={space.members} members={members} />
        </button>
      )}
      {managed && isOpenLevel(space.level) && <BuildingIcon role="img" aria-label="全组织" className="shrink-0 text-[16px] text-muted" />}
      {mine ? (
        <button
          type="button"
          onClick={onMembers}
          className="tap h-6 rounded-full bg-foreground/8 px-2.5 text-caption font-semibold hover:bg-foreground/12"
        >
          邀请
        </button>
      ) : (
        <span className="w-2" />
      )}
    </span>
  );
}

const LEVEL_OPTIONS: readonly { level: Level; name: string; detail: string }[] = [
  { level: "L3", name: "只有成员", detail: "成员在自己的 Pupu 里也问得到" },
  { level: "L2", name: "全组织", detail: "组织里谁都能进来看" },
  { level: "L4", name: "机密", detail: "只在这个空间里说，Pupu 不往外带" }
];

/** 邀请和谁看得到。只有主人能拉人、移人、改密级；别人只看成员名单。 */
export function InviteSheet({
  space,
  members,
  mine,
  onClose,
  onChange
}: {
  space: ProjectView | undefined;
  members: readonly MemberView[];
  mine: boolean;
  onClose: () => void;
  onChange: (change: { kind: "add" | "remove"; memberId: string } | { kind: "level"; level: Level }) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, change: Parameters<typeof onChange>[0]) {
    setBusy(key);
    setError(null);
    try {
      await onChange(change);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const inSpace = new Set(space?.members ?? []);
  const needle = query.trim().toLowerCase();
  const people = members
    .filter((member) => mine || inSpace.has(member.id))
    .filter((member) => !needle || member.name.toLowerCase().includes(needle) || member.email.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.id === space?.ownerId) - Number(a.id === space?.ownerId) || Number(inSpace.has(b.id)) - Number(inSpace.has(a.id)));
  const chip = "tap h-8 shrink-0 rounded-full px-3.5 text-subheadline font-semibold";

  return (
    <Modal>
      <Modal.Backdrop isOpen={space !== undefined} onOpenChange={(open) => !open && onClose()}>
        <Modal.Container placement="center">
          <Modal.Dialog aria-label="邀请" className="w-[min(92vw,420px)] rounded-panel">
            <Modal.Header className="flex flex-row items-center justify-between">
              <Modal.Heading className="text-title">{space?.name}</Modal.Heading>
              <button type="button" aria-label="关闭" onClick={onClose} className="tap grid size-9 place-items-center rounded-full bg-surface-inset">
                <CloseIcon />
              </button>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4">
              {mine && (
                <input
                  type="search"
                  aria-label="找人"
                  placeholder="组织里的人"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-11 rounded-tag bg-surface-inset px-3.5 text-body outline-none"
                />
              )}
              <ul className="flex flex-col overflow-hidden rounded-row bg-surface-inset">
                {people.map((member) => {
                  const owner = member.id === space?.ownerId;
                  const joined = inSpace.has(member.id);
                  return (
                    <li key={member.id} className="flex min-h-14 items-center gap-3 border-b border-black/5 px-4 last:border-0">
                      <MemberAvatar name={member.name} src={member.avatar} className="strong size-8 text-footnote font-semibold" />
                      <span className="min-w-0 flex-1 truncate text-body">{member.name}</span>
                      {owner ? (
                        <span className="text-subheadline text-muted">建的人</span>
                      ) : !mine ? null : joined ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void run(member.id, { kind: "remove", memberId: member.id })}
                          className={`${chip} text-muted hover:bg-foreground/6`}
                        >
                          移出
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void run(member.id, { kind: "add", memberId: member.id })}
                          className={`${chip} bg-foreground text-background`}
                        >
                          邀请
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {mine && space && (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 px-1 text-footnote font-medium text-muted">谁看得到</legend>
                  <div className="flex flex-col overflow-hidden rounded-row bg-surface-inset">
                    {LEVEL_OPTIONS.map((option) => (
                      <label key={option.level} className="flex min-h-14 cursor-pointer items-center gap-3 border-b border-black/5 px-4 py-2 last:border-0">
                        <input
                          type="radio"
                          name="level"
                          checked={space.level === option.level}
                          disabled={busy !== null}
                          onChange={() => void run(option.level, { kind: "level", level: option.level })}
                          className="size-5 accent-foreground"
                        />
                        <span className="flex flex-col gap-0.5">
                          <span className="text-body">{option.name}</span>
                          <span className="text-subheadline text-muted">{option.detail}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {error && <div className="text-subheadline text-danger-ink">{error}</div>}
            </Modal.Body>
            <Modal.Footer className="hidden">
              <Button slot="close">关闭</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
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
      className="strong lift flex w-full max-w-[85%] items-center gap-3 rounded-row px-4 py-3 text-left sm:max-w-120"
    >
      {child ? <ChildDot child={child} /> : <span className="size-2 shrink-0 rounded-full bg-offline" />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-semibold">{title}</span>
        <span className="truncate text-subheadline text-muted">{detail}</span>
      </span>
      <ChevronRightIcon className="shrink-0 text-[14px] text-muted" />
    </button>
  );
}
