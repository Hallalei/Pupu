import { Button } from "@heroui/react";
import { useEffect, useState } from "react";
import type { ApprovalView } from "../bridge/approvals";

function minutesLeft(expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60000));
  return minutes <= 1 ? "1 分钟内不处理就不做了" : `${minutes} 分钟内不处理就不做了`;
}

/**
 * Pupu 在电脑上要做的、等你批准的事。挂在每一屏的顶部，点了允许或拒绝就收起来。
 */
export function Approvals({
  approvals,
  onDecide
}: {
  approvals: readonly ApprovalView[];
  onDecide: (id: string, decision: "allow" | "deny") => Promise<void>;
}) {
  // 点过的先藏起来，等下一次拉状态把它去掉，免得闪回来。
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<string | null>(null);
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

  const visible = approvals.filter((approval) => !decided.has(approval.id) && approval.expiresAt > now);
  if (visible.length === 0 && !error) return null;

  async function decide(id: string, decision: "allow" | "deny") {
    setPending(id);
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

  return (
    <div className="relative z-10 mx-auto flex max-h-[55dvh] w-full max-w-2xl flex-col gap-2 overflow-y-auto px-4 pb-2">
      {visible.map((approval) => (
        <section
          key={approval.id}
          aria-label="Pupu 的请示"
          className="glass-strong bubble flex flex-col gap-2 rounded-[24px] p-4"
        >
          <div className="text-xs text-muted">Pupu 请示</div>
          <div className="text-[15px] leading-6 font-medium">{approval.title}</div>
          {approval.reason && (
            <div className="text-sm leading-6 text-danger">高风险：{approval.reason}</div>
          )}
          {approval.detail && (
            <pre className="max-h-40 overflow-auto rounded-xl bg-default px-3 py-2 text-xs leading-5 break-all whitespace-pre-wrap">
              {approval.detail}
            </pre>
          )}
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 text-xs text-muted">
              {minutesLeft(approval.expiresAt, Date.now())}
            </div>
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={pending !== null}
              onPress={() => void decide(approval.id, "deny")}
            >
              拒绝
            </Button>
            <Button
              size="sm"
              variant="primary"
              isPending={pending === approval.id}
              isDisabled={pending !== null && pending !== approval.id}
              onPress={() => void decide(approval.id, "allow")}
            >
              允许
            </Button>
          </div>
        </section>
      ))}
      {error && (
        <div className="mx-auto rounded-full bg-danger px-3 py-1 text-xs text-danger-foreground">
          {error}
        </div>
      )}
    </div>
  );
}
