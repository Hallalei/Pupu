import { Button } from "@heroui/react";
import { useEffect, useState } from "react";
import type { ApprovalView } from "../bridge/approvals";
import { ago } from "./ago";
import { PhoneIcon } from "./icons";

export function WaitingChip() {
  return (
    <span className="shrink-0 rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-warning-foreground">
      等你批准
    </span>
  );
}

/** 卡片上点了允许或拒绝：在发，或者没成。跟着那张卡走，卡从列表里没了，没成的原因也就不显示了。 */
type Decision =
  | { readonly id: string; readonly status: "sending"; readonly decision: "allow" | "deny" }
  | { readonly id: string; readonly status: "failed"; readonly error: string };

/**
 * Pupu 在电脑上要做的、等你批准的事。挂在每一屏的顶栏下面，把内容往下挤。
 * 一次只摊开最早的一条，其余的写「还有 N 条」；点了允许或拒绝就换下一条。
 * 允许只认手机 App（见 `mayDecide`）：电脑 App 和浏览器里照常显示，允许换成「去手机上批准」，拒绝还能点。
 */
export function Approvals({
  approvals,
  canAllow,
  phonePaired,
  onDecide
}: {
  approvals: readonly ApprovalView[];
  /** 这台设备是手机 App，或者本机开发没设访问口令。 */
  canAllow: boolean;
  phonePaired: boolean;
  onDecide: (id: string, decision: "allow" | "deny") => Promise<void>;
}) {
  // 点过的先藏起来，等下一次拉状态把它去掉，免得闪回来。
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [request, setRequest] = useState<Decision | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    // 已经不在列表里的，不用再记着。
    setDecided((current) => {
      const live = new Set(approvals.map((approval) => approval.id));
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [approvals]);

  const visible = approvals
    .filter((approval) => !decided.has(approval.id) && approval.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt);
  const approval = visible[0];
  if (!approval) return null;
  const current = request?.id === approval.id ? request : null;
  const pending = current?.status === "sending" ? current.decision : null;

  async function decide(id: string, decision: "allow" | "deny") {
    setRequest({ id, status: "sending", decision });
    try {
      await onDecide(id, decision);
      setDecided((ids) => new Set([...ids, id]));
      setRequest(null);
    } catch (cause) {
      setRequest({ id, status: "failed", error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  return (
    <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-3 lg:px-6">
      <section
        aria-label={`等你批准，${approval.title}`}
        className="strong bubble flex flex-col gap-3 rounded-panel p-4"
      >
        <div className="flex items-center gap-2">
          <WaitingChip />
          <span className="min-w-0 flex-1 truncate text-caption text-muted">
            {approval.title.includes(approval.computerName)
              ? ago(approval.createdAt)
              : `${approval.computerName} · ${ago(approval.createdAt)}`}
          </span>
          {visible.length > 1 && (
            <span className="shrink-0 text-caption text-muted">还有 {visible.length - 1} 条</span>
          )}
        </div>
        <div className="text-headline">{approval.title}</div>
        {approval.detail && approval.kind === "sign_in" && (
          <p className="m-0 text-subheadline whitespace-pre-line">{approval.detail}</p>
        )}
        {approval.detail && approval.kind !== "sign_in" && (
          <pre className="m-0 max-h-40 overflow-auto rounded-tag bg-surface-inset px-3 py-2 font-mono text-code break-all whitespace-pre-wrap">
            {approval.detail}
          </pre>
        )}
        {approval.reason && <p className="m-0 text-subheadline text-muted">{approval.reason}</p>}
        {!canAllow && !phonePaired && (
          <p className="m-0 text-subheadline text-muted">还没连手机：在设置里生成配对码，用手机 App 扫码。</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="ghost"
            isPending={pending === "deny"}
            isDisabled={pending !== null}
            onPress={() => void decide(approval.id, "deny")}
            className="glass lift tap h-control w-full rounded-full text-body font-semibold text-foreground"
          >
            拒绝
          </Button>
          {canAllow ? (
            <Button
              isPending={pending === "allow"}
              isDisabled={pending !== null}
              onPress={() => void decide(approval.id, "allow")}
              className="tap h-control w-full rounded-full bg-foreground text-body font-semibold text-background"
            >
              允许
            </Button>
          ) : (
            <div className="flex h-control items-center justify-center gap-1.5 rounded-full bg-surface-inset text-body font-semibold text-muted">
              <PhoneIcon />
              去手机上批准
            </div>
          )}
        </div>
      </section>
      {current?.status === "failed" && (
        <div className="strong mx-auto rounded-full px-3 py-1 text-caption text-danger-ink">{current.error}</div>
      )}
    </div>
  );
}
