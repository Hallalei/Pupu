import { Button, Drawer } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import type { ComputerPolicy } from "../bridge/policy";
import type { ComputerView } from "../bridge/protocol";
import type { DeviceView } from "../devices";
import { useDesktopComputer } from "./desktop";
import { ago, computerLabel } from "./Home";
import { ThisComputer } from "./ThisComputer";

const POLICIES: readonly (readonly [ComputerPolicy, string, string])[] = [
  ["ask_risky", "高风险的才问", "删除、推送、发布这类先问你；屏幕先批一次，15 分钟不用就失效。"],
  ["ask_all", "每一步都问", "跑命令、写文件、点屏幕，每一步都等你批准。读文件不问。"],
  ["trust", "都放行", "什么都不问。电脑菜单栏上照样能看到 Pupu 在做什么。"]
];

type PairingCode = { readonly code: string; readonly expiresAt: number };

/**
 * 这一版的设置：管已经连上的电脑、手机和浏览器，每台电脑上 Pupu 什么时候要先问你，
 * 以及给新设备生成配对码。
 */
export function Settings({
  isOpen,
  onOpenChange,
  computers,
  onRevoke,
  onSetPolicy,
  devices,
  onRevokeDevice,
  onCreatePairingCode
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  computers: readonly ComputerView[];
  onRevoke: (id: string) => Promise<void>;
  onSetPolicy: (id: string, policy: ComputerPolicy) => Promise<void>;
  devices: readonly DeviceView[];
  onRevokeDevice: (id: string) => Promise<void>;
  onCreatePairingCode: () => Promise<PairingCode>;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const origin = window.location.origin;
  const thisComputer = useDesktopComputer();

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

  async function revoke(id: string, kind: "computer" | "device") {
    setPendingId(id);
    setError(null);
    try {
      await (kind === "computer" ? onRevoke(id) : onRevokeDevice(id));
      setConfirmId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Drawer>
      <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="w-[min(88vw,380px)]">
            <Drawer.Header>
              <Drawer.Heading>设置</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="flex flex-col gap-6">
              {thisComputer && <ThisComputer computer={thisComputer} />}
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-muted">电脑</h3>
                {computers.length === 0 ? (
                  <p className="text-sm leading-6 text-muted">还没有授权的电脑。</p>
                ) : (
                  computers.map((computer) => (
                    <div
                      key={computer.id}
                      className="flex flex-col gap-2 rounded-2xl bg-default px-3 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`size-2 shrink-0 rounded-full ${
                            computer.online ? "bg-emerald-600" : "bg-foreground/25"
                          }`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {computer.name}
                            {computer.id === thisComputer?.computerId && (
                              <span className="font-normal text-muted"> · 这台电脑</span>
                            )}
                          </div>
                          <div className="text-sm text-muted">
                            {computerLabel(computer)}
                            {computer.screen ? " · 屏幕已授权" : ""}
                          </div>
                        </div>
                        {confirmId !== computer.id && (
                          <button
                            type="button"
                            className="shrink-0 text-sm text-danger"
                            onClick={() => {
                              setError(null);
                              setConfirmId(computer.id);
                            }}
                          >
                            吊销
                          </button>
                        )}
                      </div>
                      <div role="radiogroup" aria-label={`「${computer.name}」上什么时候先问你`} className="flex flex-col gap-1">
                        {POLICIES.map(([policy, label, hint]) => {
                          const selected = computer.policy === policy;
                          return (
                            <button
                              key={policy}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              disabled={pendingId === computer.id}
                              onClick={() => {
                                if (!selected) void setPolicy(computer.id, policy);
                              }}
                              className={`flex items-start gap-2.5 rounded-xl px-2.5 py-2 text-left ${
                                selected ? "bg-background" : ""
                              }`}
                            >
                              <span
                                aria-hidden="true"
                                className={`mt-1 size-3.5 shrink-0 rounded-full border-2 ${
                                  selected ? "border-foreground bg-foreground" : "border-foreground/30"
                                }`}
                              />
                              <span className="min-w-0">
                                <span className="block text-sm font-medium">{label}</span>
                                <span className="block text-xs leading-5 text-muted">{hint}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {confirmId === computer.id && (
                        <div className="flex flex-col gap-2">
                          <p className="text-sm leading-6 text-muted">
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
                {error && <p className="text-sm text-danger">{error}</p>}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-muted">这台电脑能做的</h3>
                <p className="text-sm leading-6">
                  跑命令，读写主目录里的文件，列目录。也能看主屏幕、点鼠标、打字。第一次操作屏幕前，要在那台电脑的系统设置里给 Pupu 电脑 App 开屏幕录制和辅助功能（开发版叫 Electron）。
                </p>
                <p className="text-sm leading-6 text-muted">
                  电脑菜单栏上有 Pupu 的图标：能看到它在跑什么、是不是在操作屏幕，一键收回屏幕控制，也能在那台电脑上关掉跑命令或操作屏幕。在电脑上关掉的，批准了也不做。
                </p>
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-muted">手机、浏览器和电脑 App</h3>
                {devices.length === 0 ? (
                  <p className="text-sm leading-6 text-muted">还没有配对的手机、浏览器或电脑 App。</p>
                ) : (
                  devices.map((device) => (
                    <div
                      key={device.id}
                      className="flex flex-col gap-2 rounded-2xl bg-default px-3 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {device.name}
                            {device.current && (
                              <span className="font-normal text-muted">
                                {device.kind === "desktop" ? " · 这个窗口" : " · 这个浏览器"}
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-muted">{deviceLabel(device)}</div>
                        </div>
                        {confirmId !== device.id && (
                          <button
                            type="button"
                            className="shrink-0 text-sm text-danger"
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
                          <p className="text-sm leading-6 text-muted">
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
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}

const DEVICE_KINDS: Record<DeviceView["kind"], string> = { phone: "手机", browser: "浏览器", desktop: "电脑 App" };

function deviceLabel(device: DeviceView): string {
  const kind = DEVICE_KINDS[device.kind];
  return device.lastSeenAt ? `${kind} · ${ago(device.lastSeenAt)}用过` : kind;
}

/**
 * 连接新设备：生成一个配对码，手机扫二维码或者填码，浏览器和电脑填码。
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
      <h3 className="text-sm font-medium text-muted">连接新设备</h3>
      {pairing && left > 0 ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-default px-3 py-3">
          <div className="flex items-center gap-3">
            <QrCode text={link} label="配对二维码，用 iPhone 相机扫" />
            <div className="flex min-w-0 flex-col gap-1">
              <div className="font-mono text-xl font-semibold tracking-wider" aria-label="配对码">
                {pairing.code}
              </div>
              <div className="text-sm text-muted" aria-live="polite">
                {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} 后过期
              </div>
            </div>
          </div>
          <ul className="flex flex-col gap-1.5 text-sm leading-6">
            <li>手机：用相机扫二维码，在 Pupu App 里打开；或者在 App 的连接页填这个码。</li>
            <li>浏览器：打开 {origin}，填这个码。</li>
            <li>电脑：打开 Pupu 电脑 App，填这个码。还没装 App 的，在 apps/cloud 目录里运行</li>
          </ul>
          <pre className="overflow-x-auto rounded-xl bg-background px-3 py-2 text-xs leading-5">
            {`npm run bridge -- pair --url ${origin} --code ${pairing.code}\nnpm run bridge -- install`}
          </pre>
          <div className="flex justify-end">
            <Button size="sm" variant="tertiary" onPress={() => setPairing(null)}>
              不用了
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm leading-6 text-muted">
            {joined
              ? `「${joined}」连上了。`
              : pairing
                ? "配对码过期了，再生成一个。"
                : "手机、浏览器和电脑都用配对码连。码 10 分钟内有效，用一次就作废。"}
          </p>
          <Button size="sm" variant="secondary" isPending={busy} onPress={() => void create()}>
            {joined || pairing ? "再生成一个" : "生成配对码"}
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
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
    <div className="shrink-0 rounded-xl bg-white p-2">
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
