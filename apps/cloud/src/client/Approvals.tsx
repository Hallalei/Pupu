import { Button } from "@heroui/react";
import { useEffect, useState } from "react";
import type { ApprovalView } from "../bridge/approvals";
import { ago } from "./Home";
import { PhoneIcon } from "./icons";

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
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  if (!approval && !error) return null;

  async function decide(id: string, decision: "allow" | "deny") {
    setPending(decision);
    setError(null);
    try {
      await onDecide(id, decision);
      setDecided((current) => new Set([...current, id]));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }

  const minutes = approval ? Math.max(1, Math.round((approval.expiresAt - now) / 60000)) : 0;
  const why = approval
    ? [approval.reason, `${minutes} 分钟内没回应就按拒绝处理。`].filter(Boolean).join("。")
    : "";

  return (
    <div className="relative z-10 mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-3 lg:px-6">
      {approval && (
        <section
          aria-label={`等你批准，${approval.title}`}
          className="strong bubble flex flex-col gap-3 rounded-panel p-4"
        >
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-warning-foreground">
              等你批准
            </span>
            <span className="min-w-0 flex-1 truncate text-caption text-muted">
              {approval.computerName} · {ago(approval.createdAt)}
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
          <p className="m-0 text-subheadline text-muted">{why}</p>
          {!canAllow && !phonePaired && (
            <p className="m-0 text-subheadline text-muted">还没连手机：在设置里生成配对码，用手机 App 扫码。</p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="ghost"
              isPending={pending === "deny"}
              isDisabled={pending !== null}
              onPress={() => void decide(approval.id, "deny")}
              className="glass h-control w-full rounded-full text-body font-semibold text-foreground"
            >
              拒绝
            </Button>
            {canAllow ? (
              <Button
                isPending={pending === "allow"}
                isDisabled={pending !== null}
                onPress={() => void decide(approval.id, "allow")}
                className="h-control w-full rounded-full bg-foreground text-body font-semibold text-background"
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
      )}
      {error && (
        <div className="strong mx-auto rounded-full px-3 py-1 text-caption text-danger-ink">{error}</div>
      )}
    </div>
  );
}
