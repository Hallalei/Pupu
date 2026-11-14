import { Spinner } from "@heroui/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { BrowserPlanStep, BrowserTask } from "./chat-rows";
import { CheckIcon, ExpandIcon, StopIcon } from "./icons";

/** 卡片上的一帧画面：电脑 App 发来、云端转过来的，敏感输入框已经涂掉。 */
export type BrowserFrameView = {
  readonly computerId: string;
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
  readonly url: string;
  readonly title: string;
};

/** 画面上的按钮：高 32，触控区补到 44（`hit-44`），surface 底、ink 字、往里收 1pt line 加 shadow-raised。 */
const CHIP = "tap hit-44 relative inline-flex h-8 shrink-0 items-center rounded-full text-footnote whitespace-nowrap";
const ROUND_CHIP = `${CHIP} float-control w-8 justify-center`;
/** 「接手」：action 底、on-action 字、600。 */
const TAKE_OVER = `${CHIP} bg-action px-3 font-semibold text-on-action`;

/**
 * 浏览器任务卡片（规范 BrowserCard）：对话里一张实时画面，右下角「计划」、放大、停止，下面一行状态；
 * 要你登录、输验证码时停下来等你接手；做完了画面退后，只剩一句结果。iOS 的 BrowserCardCell 是同一个样子，两边一起改。
 */
export function BrowserCard({
  task,
  frame,
  onStop,
  onTakeOver
}: {
  task: BrowserTask;
  frame: BrowserFrameView | null;
  /** 这一轮还在跑时，停掉它。 */
  onStop?: () => void;
  /** 在做这件事的电脑就是眼前这台：在主窗口里打开接手的放大视图（真实页面），人来接手。 */
  onTakeOver?: () => void;
}) {
  const [plan, setPlan] = useState(false);
  const [large, setLarge] = useState(false);
  const active = task.state === "live" || task.state === "waiting";
  /** 交给人了，等人接手：没有转圈，画面留着，多一个「接手」。 */
  const holding = task.state === "handover";
  const finished = !active && !holding;
  // 「接手」：电脑 App 上（做这件事的就是这台电脑）打开主窗口里的放大视图，能直接操作；网页和手机上放大看实时画面。
  const takeOver = () => {
    if (onTakeOver) onTakeOver();
    else setLarge(true);
  };

  useEffect(() => {
    if (!large) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLarge(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [large]);

  const ratio = frame ? `${frame.width} / ${frame.height}` : "16 / 10";
  const resultLine = task.result ?? (task.state === "done" ? "浏览器里的事做完了" : task.status);
  const failed = task.state === "failed";

  // 做完了又没留下画面（比如刷新过页面）：只剩一行结果，计划在这一行下面展开。
  if (finished && !frame) {
    return (
      <div className="flex flex-col items-start gap-2" data-browser-card={task.state}>
        <div className="flex max-w-bubble items-center gap-2 rounded-row bg-surface-inset px-3 py-2">
          <ResultMark state={task.state} />
          <span className={`text-subheadline break-words ${failed ? "text-danger-ink" : "text-ink"}`}>{resultLine}</span>
          {task.plan.length > 0 && (
            <button
              type="button"
              aria-expanded={plan}
              onClick={() => setPlan(!plan)}
              className="tap hit-44 relative shrink-0 text-footnote text-ink-muted pointer-fine:hover:text-ink"
            >
              计划
            </button>
          )}
        </div>
        {plan && <PlanList steps={task.plan} />}
      </div>
    );
  }

  const buttons = (
    <>
      {task.plan.length > 0 && (
        <button type="button" aria-expanded={plan} onClick={() => setPlan(!plan)} className={`${CHIP} float-control px-3`}>
          计划
        </button>
      )}
      <button type="button" aria-label="放大" onClick={() => setLarge(true)} className={`${ROUND_CHIP} text-[14px]`}>
        <ExpandIcon />
      </button>
      {holding && (
        <button type="button" onClick={takeOver} className={TAKE_OVER}>
          接手
        </button>
      )}
      {(active || holding) && onStop && (
        <button type="button" aria-label="停止" onClick={onStop} className={`${ROUND_CHIP} text-[19px]`}>
          <StopIcon />
        </button>
      )}
    </>
  );

  return (
    <div className="flex flex-col items-start gap-2" data-browser-card={task.state}>
      <div className="relative w-full max-w-[420px] overflow-hidden rounded-bubble bg-surface-inset shadow-raised">
        <div style={{ aspectRatio: ratio }} className="relative max-h-88 w-full">
          {frame ? (
            <img
              src={`data:image/jpeg;base64,${frame.jpeg}`}
              alt={frame.title || "Pupu 浏览器的画面"}
              className={`absolute inset-0 size-full object-cover object-top ${finished ? "opacity-70" : ""}`}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-footnote text-ink-muted">等电脑传画面…</div>
          )}
        </div>
        {/* 往里收的 1pt line 盖在画面上面，画面贴边时也看得到边。 */}
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] inset-ring inset-ring-line" />
        {active && (
          <span className="float-control absolute top-2 right-2 grid size-7 place-items-center rounded-full">
            <Spinner size="sm" color="current" className="size-3.5" aria-label="在做" />
          </span>
        )}
        <div className="absolute inset-x-2 bottom-2 flex items-center justify-end gap-2">
          {finished && (
            <span className="float-control mr-auto flex h-8 min-w-0 items-center gap-2 rounded-full px-3 text-footnote">
              <ResultMark state={task.state} />
              <span className={`truncate ${failed ? "text-danger-ink" : ""}`}>{resultLine}</span>
            </span>
          )}
          {buttons}
        </div>
        {plan && (
          <div className="absolute right-2 bottom-12 max-w-[calc(100%-16px)]">
            <PlanList steps={task.plan} floating />
          </div>
        )}
      </div>
      {(active || holding) && <StatusLine task={task} />}
      {large &&
        createPortal(
          <LargeView
            task={task}
            frame={frame}
            onClose={() => setLarge(false)}
            onStop={active || holding ? onStop : undefined}
            onTakeOver={
              onTakeOver &&
              (() => {
                setLarge(false);
                onTakeOver();
              })
            }
          />,
          document.body
        )}
    </div>
  );
}

/** 画面下面那一行：surface-inset 胶囊，footnote、ink-muted。等批时前面一个 warning 小胶囊「等你批准」，后面写那一步。 */
function StatusLine({ task }: { task: BrowserTask }) {
  const waiting = task.state === "waiting";
  const step = waiting ? task.status.replace(/^等你批准[：:]?\s*/, "") : task.status;
  return (
    <span role="status" className="flex max-w-full items-center gap-2 rounded-full bg-surface-inset px-3 py-1 text-footnote text-ink-muted">
      {waiting && (
        <span className="shrink-0 rounded-full bg-warning px-2 py-0.5 text-caption font-semibold text-on-warning">等你批准</span>
      )}
      {step && <span className="min-w-0 truncate">{step}</span>}
    </span>
  );
}

/** 放大：整屏看画面，背后压 scrim，下面「计划」「收起」「接手」「取消任务」。电脑上按 Esc 收起。 */
function LargeView({
  task,
  frame,
  onClose,
  onStop,
  onTakeOver
}: {
  task: BrowserTask;
  frame: BrowserFrameView | null;
  onClose: () => void;
  onStop?: () => void;
  onTakeOver?: () => void;
}) {
  const [plan, setPlan] = useState(false);
  const BAR = "tap inline-flex h-control shrink-0 items-center justify-center rounded-full px-4 text-subheadline font-semibold";
  return (
    <div
      role="dialog"
      aria-label="浏览器画面"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-scrim p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-5xl overflow-hidden rounded-bubble bg-surface-inset shadow-card">
        {frame ? (
          <img src={`data:image/jpeg;base64,${frame.jpeg}`} alt={frame.title || "Pupu 浏览器的画面"} className="max-h-[78vh] w-full object-contain" />
        ) : (
          <div className="grid h-[50vh] place-items-center text-footnote text-ink-muted">等电脑传画面…</div>
        )}
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] inset-ring inset-ring-line" />
        {plan && (
          <div className="absolute right-3 bottom-3 max-w-[calc(100%-24px)]">
            <PlanList steps={task.plan} floating />
          </div>
        )}
      </div>
      <span className="max-w-full truncate rounded-full bg-surface px-3 py-1 text-footnote text-ink-muted">{task.result ?? task.status}</span>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {task.plan.length > 0 && (
          <button type="button" aria-expanded={plan} onClick={() => setPlan(!plan)} className={`${BAR} float-control`}>
            计划
          </button>
        )}
        <button type="button" onClick={onClose} className={`${BAR} float-control`}>
          收起
        </button>
        {onTakeOver && (
          <button type="button" onClick={onTakeOver} className={`${BAR} bg-action text-on-action`}>
            接手
          </button>
        )}
        {onStop && (
          <button
            type="button"
            onClick={() => {
              onStop();
              onClose();
            }}
            className={`${BAR} float-control`}
          >
            取消任务
          </button>
        )}
      </div>
    </div>
  );
}

/** 计划：每步一行 footnote，彼此 8。做完的 checkmark.circle（online）、字 ink-muted；没做的 circle（ink-faint）。 */
function PlanList({ steps, floating = false }: { steps: readonly BrowserPlanStep[]; floating?: boolean }) {
  return (
    <ol
      aria-label="计划"
      className={`m-0 flex list-none flex-col gap-2 rounded-row px-3 py-2.5 text-footnote ${floating ? "float-control" : "bg-surface-inset text-ink"}`}
    >
      {steps.map((step, index) => (
        <li key={`${index}:${step.text}`} className={`flex items-start gap-2 ${step.done ? "text-ink-muted" : ""}`}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className={`mt-0.5 shrink-0 ${step.done ? "text-online" : "text-ink-faint"}`}>
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            {step.done && <path d="M5.3 8.2l1.8 1.8 3.6-3.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />}
          </svg>
          <span>
            {step.done && <span className="sr-only">做完了：</span>}
            {step.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 结果前面的记号：做完了 online 对勾；停下了、等你回话、交给你接手了是 ink-muted 的 8pt 圆点；没做完是 danger 圆点。 */
function ResultMark({ state }: { state: BrowserTask["state"] }) {
  if (state === "done") return <CheckIcon aria-hidden="true" className="shrink-0 text-[13px] text-online" />;
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${state === "failed" ? "bg-danger" : "bg-ink-muted"}`} />;
}
