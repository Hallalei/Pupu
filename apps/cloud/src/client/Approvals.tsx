import { Button } from "@heroui/react";
import { useEffect, useState } from "react";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import type { ApprovalView } from "../bridge/approvals";
import { ago } from "./ago";
import { HandIcon, PhoneIcon } from "./icons";
import { Cancelled, confirm, openInBrowser, type ConfirmWhere, type Passkeys } from "./passkey";

export function WaitingChip() {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-on-warning">
      <HandIcon className="text-[1.1em]" />
      等你批准
    </span>
  );
}

/** 卡片上说明的那一句：Pupu 给的理由，加上多久不回就当拒绝。 */
function whyText(reason: string | null | undefined, expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.floor((expiresAt - now) / 60_000));
  const timeout = `${minutes} 分钟内没回应就按拒绝处理。`;
  const why = reason?.trim().replace(/[。.]$/, "");
  return why ? `${why}。${timeout}` : timeout;
}

/** 卡片上点了允许或拒绝：在发，或者没成。跟着那张卡走，卡从列表里没了，没成的原因也就不显示了。 */
type Decision =
  | { readonly id: string; readonly status: "sending"; readonly decision: "allow" | "deny" }
  | { readonly id: string; readonly status: "failed"; readonly error: string };

/**
 * Pupu 在电脑上要做的、等你批准的事。挂在每一屏的顶栏下面，把内容往下挤。
 * 一次只摊开最早的一条，其余的写「还有 N 条」；点了允许或拒绝就换下一条。
 * 允许要电脑主人亲手确认（见 `mayDecide`）：手机上直接点，浏览器里用通行密钥，电脑 App 交给浏览器，
 * 有手机的人去手机上点。拒绝哪儿都能点。
 */
export function Approvals({
  approvals,
  where,
  passkeys,
  phonePaired,
  onDecide
}: {
  approvals: readonly ApprovalView[];
  /** 这一条在这台设备上怎么允许，见 passkey.ts 的 `confirmWhere`。 */
  where: (approval: ApprovalView) => ConfirmWhere;
  passkeys: Passkeys | null;
  phonePaired: boolean;
  onDecide: (id: string, decision: "allow" | "deny", proof?: AuthenticationResponseJSON) => Promise<void>;
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
  const how = where(approval);

  async function decide(id: string, decision: "allow" | "deny") {
    setRequest({ id, status: "sending", decision });
    try {
      const proof =
        decision === "allow" && how === "passkey" && passkeys ? await confirm({ kind: "approval", id }, passkeys) : undefined;
      await onDecide(id, decision, proof);
      setDecided((ids) => new Set([...ids, id]));
      setRequest(null);
    } catch (cause) {
      if (cause instanceof Cancelled) setRequest(null);
      else setRequest({ id, status: "failed", error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  return (
    <div className="relative z-10 mx-auto flex w-full max-w-column flex-col gap-2 px-4 pt-3">
      <section
        aria-label={`等你批准，${approval.title}`}
        className="bg-surface rounded-row-outer flex flex-col gap-3 p-4 inset-ring inset-ring-line"
      >
        <div className="flex items-center gap-2">
          <WaitingChip />
          <span className="min-w-0 flex-1 truncate text-caption text-ink-muted">
            {[approval.computerName, ago(approval.createdAt)].filter(Boolean).join(" · ")}
          </span>
          {visible.length > 1 && (
            <span className="shrink-0 text-caption text-ink-muted">还有 {visible.length - 1} 条</span>
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
        <p className="m-0 text-subheadline text-ink-muted">{whyText(approval.reason, approval.expiresAt, now)}</p>
        {/* 没批成：照对话里的出错提示写在卡上，按钮还能再点。 */}
        {current?.status === "failed" && <p className="m-0 text-subheadline text-danger-ink">{current.error}</p>}
        {how === "phone" && !phonePaired && (
          <p className="m-0 text-subheadline text-ink-muted">还没连手机：在设置里生成配对码，用手机 App 扫码。</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="ghost"
            isPending={pending === "deny"}
            isDisabled={pending !== null}
            onPress={() => void decide(approval.id, "deny")}
            className="bg-surface-inset tap h-control w-full rounded-full text-body font-semibold text-ink"
          >
            拒绝
          </Button>
          {how === "here" || how === "passkey" ? (
            <Button
              isPending={pending === "allow"}
              isDisabled={pending !== null}
              onPress={() => void decide(approval.id, "allow")}
              className="tap h-control w-full rounded-full bg-action text-body font-semibold text-on-action"
            >
              允许
            </Button>
          ) : how === "browser" ? (
            <Button
              onPress={openInBrowser}
              className="tap h-control w-full rounded-full bg-action text-body font-semibold text-on-action"
            >
              在浏览器里允许
            </Button>
          ) : (
            <div className="flex h-control items-center justify-center gap-1.5 rounded-full bg-action-off text-body font-semibold text-ink-muted">
              <PhoneIcon />
              去手机上批准
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
