import { Button, Drawer, Modal } from "@heroui/react";
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
import { ThisComputer } from "./ThisComputer";

const POLICIES: readonly (readonly [ComputerPolicy, string, string])[] = [
  ["ask_risky", "高风险的才问", "删除、推送、发布这类先问你；屏幕先批一次，15 分钟不用就失效。"],
  ["ask_all", "每一步都问", "跑命令、写文件、点屏幕，每一步都等你批准。读文件不问。"],
  ["trust", "都放行", "什么都不问。电脑菜单栏上照样能看到 Pupu 在做什么。"]
];

type PairingCode = { readonly code: string; readonly expiresAt: number };

function computerLabel(computer: ComputerView): string {
  if (computer.online) return "在线";
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
  onRevoke,
  onSetPolicy,
  devices,
  members,
  actor,
  onRevokeDevice,
  onInviteMember,
  onRemoveMember,
  onCreatePairingCode
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  computers: readonly ComputerView[];
  onRevoke: (id: string) => Promise<void>;
  onSetPolicy: (id: string, policy: ComputerPolicy) => Promise<void>;
  devices: readonly DeviceView[];
  members: readonly MemberView[];
  /** 发请求的是谁（见 members.ts 的 `actorOf`），按钮灰不灰和接口的规则对得上；本机开发没设访问口令时是 null。 */
  actor: Actor | null | undefined;
  onRevokeDevice: (id: string) => Promise<void>;
  onInviteMember: (email: string) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  onCreatePairingCode: () => Promise<PairingCode>;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const origin = window.location.origin;
  const thisComputer = useDesktopComputer();
  const wide = useWide();

  async function setPolicy(id: string, policy: ComputerPolicy) {
    setPendingId(id);
    setError(null);
    try {
      await onSetPolicy(id, policy);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingId(null);
    }
  }

  const emails = new Map(members.map((member) => [member.id, member.email]));

  async function revoke(id: string, kind: "computer" | "device" | "member") {
    setPendingId(id);
    setError(null);
    try {
      await (kind === "computer" ? onRevoke(id) : kind === "device" ? onRevokeDevice(id) : onRemoveMember(id));
      setConfirmId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingId(null);
    }
  }

  const body = (
    <>
      {thisComputer && <ThisComputer computer={thisComputer} />}
      <section className="flex flex-col gap-2">
        <h3 className="m-0 px-1 text-footnote text-muted">电脑</h3>
        {computers.length === 0 ? (
          <p className="m-0 text-subheadline text-muted">还没有授权的电脑。</p>
        ) : (
          computers.map((computer) => (
            <div
              key={computer.id}
              className="flex flex-col gap-2 rounded-row bg-default px-3 py-3"
            >
              <div className="flex items-center gap-3">
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    computer.online ? "bg-online" : "bg-offline"
                  }`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium">
                    {computer.name}
                    {computer.id === thisComputer?.computerId && (
                      <span className="font-normal text-muted"> · 这台电脑</span>
                    )}
                  </div>
                  <div className="truncate text-subheadline text-muted">
                    {computerLabel(computer)}
                    {computer.ownerId && emails.has(computer.ownerId) ? ` · ${emails.get(computer.ownerId)}` : ""}
                    {computer.screen ? " · 屏幕已授权" : ""}
                  </div>
                </div>
                {confirmId !== computer.id && mayRevoke(actor, computer.ownerId) && (
                  <button
                    type="button"
                    className="shrink-0 text-subheadline text-danger-ink hover:opacity-75"
                    onClick={() => {
                      setError(null);
                      setConfirmId(computer.id);
                    }}
                  >
                    吊销
                  </button>
                )}
              </div>
              <div role="radiogroup" aria-label={`「${computer.name}」上什么时候先问你`} className="flex flex-col">
                {POLICIES.map(([policy, label, hint]) => {
                  const selected = computer.policy === policy;
                  const locked = !mayChangePolicy(computer.policy, policy, actor, computer.ownerId);
                  return (
                    <button
                      key={policy}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={pendingId === computer.id || locked}
                      onClick={() => {
                        if (!selected) void setPolicy(computer.id, policy);
                      }}
                      className={`flex min-h-control items-center gap-2 rounded-tag px-2 py-1 text-left enabled:hover:bg-foreground/6 ${
                        locked ? "opacity-60" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-subheadline font-medium">
                          {label}
                          {locked && <span className="font-normal text-muted"> · 去主人的手机上改</span>}
                        </span>
                        {selected && <span className="block text-caption text-muted">{hint}</span>}
                      </span>
                      {selected && <CheckIcon className="shrink-0 text-[14px]" />}
                    </button>
                  );
                })}
              </div>
              {confirmId === computer.id && (
                <div className="flex flex-col gap-2">
                  <p className="m-0 text-subheadline text-muted">
                    吊销后「{computer.name}」会断开。要再用，就在那台电脑上重新配对。
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="tertiary"
                      onPress={() => setConfirmId(null)}
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      isPending={pendingId === computer.id}
                      onPress={() => void revoke(computer.id, "computer")}
                    >
                      吊销
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
        {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
      </section>

      <Members
        members={members}
        actor={actor}
        confirmId={confirmId}
        pendingId={pendingId}
        onConfirm={(id) => {
          setError(null);
          setConfirmId(id);
        }}
        onRemove={(id) => void revoke(id, "member")}
        onInvite={onInviteMember}
      />

      {mayManageInvites(actor) && <Invites isOpen={isOpen} />}

      <section className="flex flex-col gap-2">
        <h3 className="m-0 px-1 text-footnote text-muted">手机、浏览器和电脑 App</h3>
        {devices.length === 0 ? (
          <p className="m-0 text-subheadline text-muted">还没有配对的手机、浏览器或电脑 App。</p>
        ) : (
          devices.map((device) => (
            <div
              key={device.id}
              className="flex flex-col gap-2 rounded-row bg-default px-3 py-3"
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium">
                    {device.name}
                    {device.current && (
                      <span className="font-normal text-muted">
                        {device.kind === "desktop" ? " · 这个窗口" : " · 这个浏览器"}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-subheadline text-muted">{deviceLabel(device)}</div>
                </div>
                {confirmId !== device.id && mayRevoke(actor, device.memberId) && (
                  <button
                    type="button"
                    className="shrink-0 text-subheadline text-danger-ink hover:opacity-75"
                    onClick={() => {
                      setError(null);
                      setConfirmId(device.id);
                    }}
                  >
                    吊销
                  </button>
                )}
              </div>
              {confirmId === device.id && (
                <div className="flex flex-col gap-2">
                  <p className="m-0 text-subheadline text-muted">
                    {device.current
                      ? device.kind === "desktop"
                        ? "吊销后这个窗口马上退出，要再用就在 App 里重新配对。"
                        : "吊销后这个浏览器马上退出，要再用就重新配对。"
                      : `吊销后「${device.name}」马上断开。要再用，就在那台设备上重新配对。`}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="tertiary" onPress={() => setConfirmId(null)}>
                      取消
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      isPending={pendingId === device.id}
                      onPress={() => void revoke(device.id, "device")}
                    >
                      吊销
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </section>

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

const DEVICE_KINDS: Record<DeviceView["kind"], string> = { phone: "手机", browser: "浏览器", desktop: "电脑 App" };

/**
 * 成员名单：创建者在前。创建者能移除别人；邀请要在手机 App 上做（加人等于放宽权限，见 `mayInvite`），
 * 所以网页上只有本机开发没带凭据时才有邀请框。
 */
function Members({
  members,
  actor,
  confirmId,
  pendingId,
  onConfirm,
  onRemove,
  onInvite
}: {
  members: readonly MemberView[];
  actor: Actor | null | undefined;
  confirmId: string | null;
  pendingId: string | null;
  onConfirm: (id: string | null) => void;
  onRemove: (id: string) => void;
  onInvite: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (members.length === 0) return null;

  async function invite() {
    setInviting(true);
    setError(null);
    try {
      await onInvite(email.trim());
      setEmail("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInviting(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 px-1 text-footnote text-muted">成员</h3>
      {members.map((member) => (
        <div key={member.id} className="flex flex-col gap-2 rounded-row bg-default px-3 py-3">
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
            {confirmId !== member.id && mayRemoveMember(actor, member) && (
              <button type="button" className="shrink-0 text-subheadline text-danger-ink hover:opacity-75" onClick={() => onConfirm(member.id)}>
                移除
              </button>
            )}
          </div>
          {confirmId === member.id && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-subheadline text-muted">
                移除后 {member.email} 不能再登录，他名下的手机、浏览器、电脑 App 和电脑马上断开。
              </p>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="tertiary" onPress={() => onConfirm(null)}>
                  取消
                </Button>
                <Button size="sm" variant="danger" isPending={pendingId === member.id} onPress={() => onRemove(member.id)}>
                  移除
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
      {mayInvite(actor) ? (
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
