import { Spinner } from "@heroui/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { BrowserPlanStep, BrowserTask } from "./chat-rows";
import { CheckIcon, CloseIcon, CollapseIcon, ExpandIcon, SparkleIcon } from "./icons";

/** 卡片上的一帧画面：电脑 App 发来、云端转过来的，敏感输入框已经涂掉。 */
export type BrowserFrameView = {
  readonly computerId: string;
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
  readonly url: string;
  readonly title: string;
};

/**
 * 浏览器任务卡片，学的是 Hark：对话里一张实时画面，右下角「计划」、放大、停止，下面一行状态；
 * 做完了收起来，只剩一句结果。iOS 的 BrowserCardCell 是同一个样子，两边一起改。
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
  /** 在做这件事的电脑就是眼前这台：把 Pupu 浏览器窗口放到屏幕上，人来接手。 */
  onTakeOver?: () => void;
}) {
  const [plan, setPlan] = useState(false);
  const [large, setLarge] = useState(false);
  const active = task.state === "live" || task.state === "waiting";
  const finished = !active;

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

  // 做完了又没留下画面（比如刷新过页面）：只剩一行结果。
  if (finished && !frame) {
    return (
      <div className="flex flex-col gap-1.5" data-browser-card={task.state}>
        <div className="soft flex w-fit max-w-[85%] items-center gap-2 rounded-row px-3 py-2">
          <ResultMark state={task.state} />
          <span className="text-subheadline break-words">{resultLine}</span>
          {task.plan.length > 0 && (
            <button type="button" onClick={() => setPlan(!plan)} className="tap shrink-0 text-footnote text-muted">
              计划
            </button>
          )}
        </div>
        {plan && <PlanList steps={task.plan} />}
      </div>
    );
  }

  const buttons = (
    <div className="flex items-center gap-1.5">
      {task.plan.length > 0 && (
        <button
          type="button"
          aria-expanded={plan}
          onClick={() => setPlan(!plan)}
          className="tap flex h-8 items-center gap-1 rounded-full bg-black/70 px-3 text-footnote font-medium text-white backdrop-blur"
        >
          <SparkleIcon className="text-[13px]" />
          计划
        </button>
      )}
      <button
        type="button"
        aria-label="放大"
        onClick={() => setLarge(true)}
        className="tap grid size-8 place-items-center rounded-full bg-black/70 text-[14px] text-white backdrop-blur"
      >
        <ExpandIcon />
      </button>
      {active && onStop && (
        <button
          type="button"
          aria-label="停止"
          onClick={onStop}
          className="tap grid size-8 place-items-center rounded-full bg-black/70 text-[14px] text-white backdrop-blur"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col items-start gap-1.5" data-browser-card={task.state}>
      <div className="relative w-full max-w-[420px] overflow-hidden rounded-bubble bg-[#111] shadow-lg">
        <div style={{ aspectRatio: ratio }} className="relative max-h-[22rem] w-full">
          {frame ? (
            <img
              src={`data:image/jpeg;base64,${frame.jpeg}`}
              alt={frame.title || "Pupu 浏览器的画面"}
              className={`absolute inset-0 size-full object-cover object-top ${finished ? "opacity-70" : ""}`}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-footnote text-white/60">等电脑传画面…</div>
          )}
        </div>
        {active && (
          <span className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-full bg-black/60">
            <Spinner size="sm" color="current" className="text-white" aria-label="在做" />
          </span>
        )}
        {finished ? (
          <div className="absolute inset-x-2.5 bottom-2.5 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 rounded-full bg-black/75 px-3 py-1.5 text-footnote text-white backdrop-blur">
              <ResultMark state={task.state} light />
              <span className="truncate">{resultLine}</span>
            </div>
            {buttons}
          </div>
        ) : (
          <div className="absolute right-2.5 bottom-2.5">{buttons}</div>
        )}
        {plan && (
          <div className="absolute right-2.5 bottom-12 left-2.5 sm:left-auto sm:w-64">
            <PlanList steps={task.plan} dark />
          </div>
        )}
      </div>
      {active && (
        <span className="soft rounded-full px-3 py-1 text-footnote text-muted" role="status">
          {task.status}
        </span>
      )}
      {large &&
        createPortal(
          <LargeView
            task={task}
            frame={frame}
            onClose={() => setLarge(false)}
            onStop={active ? onStop : undefined}
            onTakeOver={onTakeOver}
          />,
          document.body
        )}
    </div>
  );
}

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
  return (
    <div
      role="dialog"
      aria-label="浏览器画面"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/40 p-4 backdrop-blur-xl"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-5xl overflow-hidden rounded-bubble bg-[#111] shadow-2xl">
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame.jpeg}`}
            alt={frame.title || "Pupu 浏览器的画面"}
            className="max-h-[78vh] w-full object-contain"
          />
        ) : (
          <div className="grid h-[50vh] place-items-center text-footnote text-white/60">等电脑传画面…</div>
        )}
        {plan && (
          <div className="absolute right-3 bottom-3 w-72">
            <PlanList steps={task.plan} dark />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {task.plan.length > 0 && (
          <button
            type="button"
            onClick={() => setPlan(!plan)}
            className="glass tap flex h-10 items-center gap-1.5 rounded-full px-4 text-subheadline"
          >
            <SparkleIcon />
            计划
          </button>
        )}
        <button type="button" aria-label="收起" onClick={onClose} className="glass tap grid size-10 place-items-center rounded-full">
          <CollapseIcon />
        </button>
        {onTakeOver && (
          <button type="button" onClick={onTakeOver} className="glass tap h-10 rounded-full px-4 text-subheadline">
            在电脑上接手
          </button>
        )}
        {onStop && (
          <button
            type="button"
            onClick={() => {
              onStop();
              onClose();
            }}
            className="glass tap h-10 rounded-full px-4 text-subheadline"
          >
            取消任务
          </button>
        )}
      </div>
      <span className="text-footnote text-white/80">{task.result ?? task.status}</span>
    </div>
  );
}

function PlanList({ steps, dark = false }: { steps: readonly BrowserPlanStep[]; dark?: boolean }) {
  return (
    <ol
      aria-label="计划"
      className={`flex flex-col gap-1.5 rounded-row px-3 py-2.5 text-footnote ${
        dark ? "bg-black/80 text-white backdrop-blur" : "soft"
      }`}
    >
      {steps.map((step, index) => (
        <li key={`${index}:${step.text}`} className="flex items-start gap-2">
          <span
            className={`mt-px grid size-4 shrink-0 place-items-center rounded-full border text-[10px] ${
              step.done ? "border-transparent bg-success text-white" : dark ? "border-white/50" : "border-muted"
            }`}
          >
            {step.done && <CheckIcon />}
          </span>
          <span className={step.done ? "opacity-70" : ""}>{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

function ResultMark({ state, light = false }: { state: BrowserTask["state"]; light?: boolean }) {
  if (state === "done") return <CheckIcon className={`shrink-0 ${light ? "text-[#5ad17a]" : "text-success"}`} />;
  return <span className={`shrink-0 ${light ? "text-white/70" : "text-muted"}`}>•</span>;
}
