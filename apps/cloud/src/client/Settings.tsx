import { Button, Drawer, Modal } from "@heroui/react";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { encode } from "uqr";
import type { ComputerPolicy } from "../bridge/policy";
import type { ComputerView } from "../bridge/protocol";
import { mayChangePolicy, type DeviceView } from "../devices";
import type { InviteList } from "../directory";
import { mayInvite, mayManageInvites, mayRemoveMember, mayRevoke, type Actor, type MemberView } from "../members";
import { ago } from "./ago";
import { api } from "./api";
import { CheckIcon } from "./icons";
import { useDesktopComputer } from "./desktop";
import { addPasskey, Cancelled, confirm, openInBrowser, type ConfirmWhere, type Passkeys } from "./passkey";
import { ThisComputer } from "./ThisComputer";
import { ModelSection } from "./ModelSettings";
import type { PupuState } from "../server";

const POLICIES: readonly (readonly [ComputerPolicy, string, string])[] = [
  ["ask_risky", "高风险的才问", "删除、推送、发布这类先问你；屏幕先批一次，15 分钟不用就失效。"],
  ["ask_all", "每一步都问", "跑命令、写文件、点屏幕，每一步都等你批准。读文件不问。"],
  ["trust", "都放行", "什么都不问。电脑菜单栏上照样能看到 Pupu 在做什么。"]
];

type PairingCode = { readonly code: string; readonly expiresAt: number };

function computerLabel(computer: ComputerView): string {
  if (computer.online) return computer.inUse ? "在线 · 有人在用" : "在线";
  if (computer.stale) return "心跳中断";
  if (computer.lastSeenAt) return `离线 · ${ago(computer.lastSeenAt)}`;
  return "离线";
}

/**
 * 这一版的设置：管已经连上的电脑、手机和浏览器，每台电脑上 Pupu 什么时候要先问你，
 * 成员名单，以及给新设备生成配对码。
 */
export function Settings({
  isOpen,
  onOpenChange,
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
  onPasskeysChanged
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  computers: readonly ComputerView[];
  /** 老的云端没有这一项。 */
  model: PupuState["model"] | null;
  onModelSaved: () => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onSetPolicy: (id: string, policy: ComputerPolicy, proof?: AuthenticationResponseJSON) => Promise<void>;
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
}) {
  const origin = window.location.origin;
  const thisComputer = useDesktopComputer();
  const wide = useWide();
  const emails = new Map(members.map((member) => [member.id, member.email]));

  const body = (
    <>
      {thisComputer && <ThisComputer computer={thisComputer} />}
      {model && <ModelSection model={model} computers={computers} onSaved={onModelSaved} />}
      <section className="flex flex-col gap-2">
        <h3 className="m-0 px-1 text-footnote text-muted">电脑</h3>
        {computers.length === 0 ? (
          <p className="m-0 text-subheadline text-muted">还没有授权的电脑。</p>
        ) : (
          computers.map((computer) => (
            <ComputerRow
              key={computer.id}
              computer={computer}
              here={computer.id === thisComputer?.computerId}
              owner={computer.ownerId ? (emails.get(computer.ownerId) ?? null) : null}
              actor={actor}
              confirmBy={confirmBy}
              passkeys={passkeys}
              onRevoke={() => onRevoke(computer.id)}
              onSetPolicy={(policy, proof) => onSetPolicy(computer.id, policy, proof)}
            />
          ))
        )}
      </section>

      <Members
        members={members}
        actor={actor}
        confirmBy={confirmBy}
        passkeys={passkeys}
        onRemove={onRemoveMember}
        onInvite={onInviteMember}
      />

      {mayManageInvites(actor) && <Invites isOpen={isOpen} />}

      <section className="flex flex-col gap-2">
        <h3 className="m-0 px-1 text-footnote text-muted">手机、浏览器和电脑 App</h3>
        {devices.length === 0 ? (
          <p className="m-0 text-subheadline text-muted">还没有配对的手机、浏览器或电脑 App。</p>
        ) : (
          devices.map((device) => (
            <DeviceRow key={device.id} device={device} actor={actor} onRevoke={() => onRevokeDevice(device.id)} />
          ))
        )}
      </section>

      {passkeys && (confirmBy === "passkey" || confirmBy === "browser") && (
        <PasskeyList passkeys={passkeys} confirmBy={confirmBy} onChanged={onPasskeysChanged} />
      )}

      <PairNew
        origin={origin}
        connected={[...devices, ...computers]}
        onCreate={onCreatePairingCode}
      />
    </>
  );

  // 电脑上是居中的弹窗，宽 520；手机上是从右边滑出的抽屉。
  if (wide) {
    return (
      <Modal>
        <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
          <Modal.Container placement="center" scroll="inside">
            <Modal.Dialog className="max-h-[85dvh] w-[min(92vw,520px)] rounded-panel">
              <Modal.CloseTrigger aria-label="关闭" />
              <Modal.Header>
                <Modal.Heading className="text-title">设置</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-6 pt-3">{body}</Modal.Body>
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
          <Drawer.Dialog className="w-[min(88vw,380px)]">
            <Drawer.Header>
              <Drawer.Heading className="text-title">设置</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="flex flex-col gap-6">{body}</Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
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

function ComputerRow({
  computer,
  here,
  owner,
  actor,
  confirmBy,
  passkeys,
  onRevoke,
  onSetPolicy
}: {
  computer: ComputerView;
  /** 就是打开设置的这台电脑 App。 */
  here: boolean;
  /** 主人的邮箱。 */
  owner: string | null;
  actor: Actor | null | undefined;
  confirmBy: ConfirmWhere;
  passkeys: Passkeys | null;
  onRevoke: () => Promise<void>;
  onSetPolicy: (policy: ComputerPolicy, proof?: AuthenticationResponseJSON) => Promise<void>;
}) {
  const row = useRowAction();
  /** 往宽里改：主人用通行密钥确认过就能改（`mayChangePolicy` 的 proven），别人和有手机的人去手机上。 */
  function howTo(policy: ComputerPolicy): "now" | "passkey" | "browser" | "phone" {
    if (mayChangePolicy(computer.policy, policy, actor, computer.ownerId)) return "now";
    const proven = actor?.memberId ?? null;
    if (!passkeys || !mayChangePolicy(computer.policy, policy, actor, computer.ownerId, proven)) return "phone";
    return confirmBy === "passkey" || confirmBy === "browser" ? confirmBy : "phone";
  }
  return (
    <div className="flex flex-col gap-2 rounded-row bg-default px-3 py-3">
      <div className="flex items-center gap-3">
        <span
          className={`size-2 shrink-0 rounded-full ${computer.online ? "bg-online" : "bg-offline"}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium">
            {computer.name}
            {here && <span className="font-normal text-muted"> · 这台电脑</span>}
          </div>
          <div className="truncate text-subheadline text-muted">
            {computerLabel(computer)}
            {owner ? ` · ${owner}` : ""}
            {computer.screen ? " · 屏幕已授权" : ""}
          </div>
        </div>
        {!row.confirming && mayRevoke(actor, computer.ownerId) && (
          <button
            type="button"
            className="shrink-0 text-subheadline text-danger-ink hover:opacity-75"
            onClick={row.confirm}
          >
            吊销
          </button>
        )}
      </div>
      <div role="radiogroup" aria-label={`「${computer.name}」上什么时候先问你`} className="flex flex-col">
        {POLICIES.map(([policy, label, hint]) => {
          const selected = computer.policy === policy;
          const how = howTo(policy);
          const locked = how === "phone";
          return (
            <button
              key={policy}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={row.sending || locked}
              onClick={() => {
                if (selected) return;
                if (how === "browser") openInBrowser();
                else if (how === "passkey" && passkeys)
                  void row.run(async () =>
                    onSetPolicy(policy, await confirm({ kind: "policy", computerId: computer.id, policy }, passkeys))
                  );
                else void row.run(() => onSetPolicy(policy));
              }}
              className={`flex min-h-control items-center gap-2 rounded-tag px-2 py-1 text-left enabled:hover:bg-foreground/6 ${
                locked ? "opacity-60" : ""
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-subheadline font-medium">
                  {label}
                  {locked && <span className="font-normal text-muted"> · 去主人的手机上改</span>}
                  {how === "browser" && <span className="font-normal text-muted"> · 在浏览器里改</span>}
                </span>
                {selected && <span className="block text-caption text-muted">{hint}</span>}
              </span>
              {selected && <CheckIcon className="shrink-0 text-[14px]" />}
            </button>
          );
        })}
      </div>
      {row.confirming && (
        <ConfirmPanel
          text={`吊销后「${computer.name}」会断开。要再用，就在那台电脑上重新配对。`}
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
    <div className="flex flex-col gap-2 rounded-row bg-default px-3 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium">
            {device.name}
            {device.current && (
              <span className="font-normal text-muted">{device.kind === "desktop" ? " · 这个窗口" : " · 这个浏览器"}</span>
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
    <div className="flex flex-col gap-2 rounded-row bg-default px-3 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium">
            {member.email}
            {member.current && <span className="font-normal text-muted"> · 你</span>}
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
  if (members.length === 0) return null;
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
    <section className="flex flex-col gap-2">
      <h3 className="m-0 px-1 text-footnote text-muted">成员</h3>
      {members.map((member) => (
        <MemberRow key={member.id} member={member} actor={actor} onRemove={() => onRemove(member.id)} />
      ))}
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
            className="min-w-0 flex-1 rounded-tag bg-default px-3 py-1.5 text-subheadline"
          />
          <Button size="sm" type="submit" isPending={inviting} isDisabled={!email.trim()}>
            邀请
          </Button>
        </form>
      ) : how === "browser" ? (
        <Button size="sm" variant="secondary" className="self-start" onPress={openInBrowser}>
          在浏览器里邀请
        </Button>
      ) : (
        actor?.role === "creator" && (
          <p className="m-0 text-subheadline text-muted">邀请成员要在手机 App 的设置里做。</p>
        )
      )}
      {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
    </section>
  );
}

/** 发给新用户开 Pupu 的码。别的 Pupu 的创建者，接口回 403，这里什么都不显示。 */
function Invites({ isOpen }: { isOpen: boolean }) {
  const [list, setList] = useState<InviteList | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.invites().then(setList), []);

  useEffect(() => {
    if (isOpen) load().catch(() => setList(null));
  }, [isOpen, load]);

  if (!list) return null;

  async function change(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
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
    <section className="flex flex-col gap-2">
      <h3 className="m-0 flex justify-between px-1 text-footnote text-muted">
        <span>邀请码</span>
        <span>还能生成 {list.left} 个</span>
      </h3>
      {list.invites.map((invite) => (
        <div key={invite.code} className="flex items-center gap-3 rounded-row bg-default px-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-body font-medium">{invite.code}</div>
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
      <Button size="sm" isPending={creating} isDisabled={list.left === 0} onPress={() => void create()}>
        生成邀请码
      </Button>
      {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
    </section>
  );
}

/** 比如「手机 · a@gmail.com · 3 分钟前用过」。邮箱是这台设备属于的成员。 */
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
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 px-1 text-footnote text-muted">通行密钥</h3>
      {passkeys.keys.length === 0 ? (
        <p className="m-0 text-subheadline text-muted">
          没有手机时，允许 Pupu 的请示、放宽电脑权限、邀请成员，都用通行密钥确认：按指纹或输电脑密码。
        </p>
      ) : (
        passkeys.keys.map((key) => (
          <div key={key.id} className="flex flex-col rounded-row bg-default px-3 py-3">
            <div className="truncate text-body font-medium">{key.name}</div>
            <div className="truncate text-subheadline text-muted">
              {key.lastUsedAt ? `${ago(key.lastUsedAt)}用过` : `${ago(key.createdAt)}加的`}
            </div>
          </div>
        ))
      )}
      {confirmBy === "browser" ? (
        <Button size="sm" variant="secondary" className="self-start" onPress={openInBrowser}>
          在浏览器里加
        </Button>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          isPending={row.sending}
          onPress={() =>
            void row.run(async () => {
              await addPasskey(passkeys);
              await onChanged();
            })
          }
        >
          加一把通行密钥
        </Button>
      )}
      <RowError error={row.error} />
    </section>
  );
}

function deviceLabel(device: DeviceView): string {
  const seen = device.lastSeenAt ? `${ago(device.lastSeenAt)}用过` : null;
  return [DEVICE_KINDS[device.kind], device.member, seen].filter(Boolean).join(" · ");
}

/**
 * 连接新设备：生成一个配对码，手机扫二维码或者填码，浏览器和电脑 App 填码。
 * 连过手机以后，网页生成的码配不了新手机（见 `mayPair`），要在旧手机上生成。
 * 用这个码的设备连上了，或者码过期了，就收起来。
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

  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 px-1 text-footnote text-muted">连接新设备</h3>
      {pairing && left > 0 ? (
        <div className="flex flex-col gap-3 rounded-row bg-default px-3 py-3">
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
      ) : (
        <div className="flex flex-col items-start gap-2 px-1">
          {(joined || pairing) && (
            <p className="m-0 text-subheadline text-muted">{joined ? `「${joined}」连上了。` : "配对码过期了，再生成一个。"}</p>
          )}
          <Button size="sm" variant="secondary" isPending={busy} onPress={() => void create()}>
            {joined || pairing ? "再生成一个" : "生成配对码"}
          </Button>
        </div>
      )}
      {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
    </section>
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
