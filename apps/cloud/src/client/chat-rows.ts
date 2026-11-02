import type { ApprovalView } from "../bridge/approvals";
import type { ComputerView } from "../bridge/protocol";
import { parseHandoff, parseQuote } from "../messages";
import type { Project } from "../projects";
import type { SessionView, TranscriptMessage, TranscriptPart } from "../protocol";

/**
 * 把一个会话拆成对话里的一行行：正文、项目标签、电脑上的操作。
 * 和 iOS 的 ChatRows.swift 是同一套规则，两边改的时候一起改。
 */

export type StepStatus =
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "denied"
  | "expired"
  | "unfinished";

export type StepIcon = "terminal" | "keyboard" | "file" | "pencil" | "folder" | "screenshot" | "cursor";

/** Pupu 在电脑上做的一步。 */
export type ToolStep = {
  readonly callId: string;
  readonly computer: string | null;
  readonly icon: StepIcon;
  readonly title: string;
  readonly status: StepStatus;
  readonly output: string;
  readonly outputPath: string | null;
  readonly expanded: boolean;
};

export type ChatRow = {
  readonly id: string;
  /** 和上一行的间距：同一条消息里 8，消息之间 12。 */
  readonly gap: 0 | 8 | 12;
} & (
  | { readonly kind: "user"; readonly body: string; readonly quote: string | null }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "typing"; readonly retrying: boolean }
  | { readonly kind: "project-tag"; readonly name: string; readonly projectId: string | null }
  | { readonly kind: "tool"; readonly step: ToolStep }
  | {
      readonly kind: "tool-group";
      readonly title: string;
      readonly status: StepStatus;
      readonly failures: number;
      readonly expanded: boolean;
    }
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "handoff"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }
);

export type RowContext = {
  /** 只有聊天里挂项目标签。 */
  readonly projectTags: boolean;
  readonly projects: ReadonlyMap<string, Project>;
  readonly computers: readonly ComputerView[];
  readonly approvals: readonly ApprovalView[];
  /** 用户点开或收起过的行，和默认状态相反。 */
  readonly toggled: ReadonlySet<string>;
};

type RowView = Pick<SessionView, "messages" | "live" | "running" | "tools" | "retry" | "error">;

type Result = { readonly text: string; readonly details: Record<string, unknown>; readonly error: boolean };

/** 连着这么多步就合成一组。 */
const GROUP_MINIMUM = 3;

type Row = ChatRow;
type WithoutGap<T> = T extends unknown ? Omit<T, "gap"> : never;
/** 还没定间距的一行。 */
type Draft = WithoutGap<Row>;

export function buildRows(view: RowView, context: RowContext): Row[] {
  const results = new Map<string, Result>();
  for (const message of view.messages) {
    if (message.role !== "tool") continue;
    for (const part of message.parts) {
      if (part.type !== "tool-result") continue;
      results.set(part.id, {
        text: part.content.map((item) => (item.type === "text" ? item.text : "")).join(""),
        details: asRecord(part.details),
        error: part.error
      });
    }
  }
  const outputs = new Map(view.tools.map((tool) => [tool.callId, tool.output]));

  const messages = view.messages.filter(isVisible);
  if (view.live && isVisible(view.live)) messages.push(view.live);

  let rows: Row[] = [];
  for (const message of messages) {
    const own: Draft[] = [];
    if (message.role === "user") {
      const text = textOf(message);
      const task = parseHandoff(text);
      if (task !== null) {
        own.push({ id: message.id, kind: "handoff", text: task });
      } else {
        const { quote, body } = parseQuote(text);
        own.push({ id: message.id, kind: "user", body, quote });
      }
    } else if (message.role === "notice") {
      own.push({ id: message.id, kind: "notice", text: textOf(message, " ") });
    } else if (message.role === "assistant") {
      message.parts.forEach((part, index) => {
        if (part.type === "text" && part.text.trim()) {
          own.push({ id: `${message.id}#${index}`, kind: "assistant", text: part.text });
        } else if (part.type === "tool-call") {
          const row = toolRow(part, results.get(part.id), outputs.get(part.id), view.running, context);
          if (row) own.push(row);
        }
      });
      if (message.error?.trim()) {
        own.push({ id: `${message.id}#error`, kind: "error", text: `模型出错：${message.error}` });
      }
    }
    rows.push(...own.map((row, index) => ({ ...row, gap: index === 0 ? 12 : 8 }) as Row));
  }
  rows = grouped(rows, context);
  if (view.running && !hasText(view.live)) {
    rows.push({ id: "typing", gap: 12, kind: "typing", retrying: view.retry !== null });
  }
  if (view.error) rows.push({ id: "session-error", gap: 12, kind: "error", text: `出错了：${view.error}` });
  const seen = new Set<string>();
  return rows
    .filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)))
    .map((row, index) => (index === 0 ? { ...row, gap: 0 } : row));
}

/** 工具结果和系统记录不单独显示：项目标签和电脑上的操作已经在工具调用那里画出来了。 */
function isVisible(message: TranscriptMessage): boolean {
  if (message.role === "tool") return false;
  if (message.role === "notice") return message.parts.length > 0;
  return true;
}

function hasText(message: TranscriptMessage | null): boolean {
  return Boolean(message?.parts.some((part) => part.type === "text" && part.text.trim()));
}

function textOf(message: TranscriptMessage, separator = ""): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join(separator);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toolRow(
  part: Extract<TranscriptPart, { type: "tool-call" }>,
  result: Result | undefined,
  output: string | undefined,
  running: boolean,
  context: RowContext
): Draft | null {
  const args = asRecord(part.arguments);
  if (part.name === "create_project") {
    const name = String(args.name ?? "").trim();
    if (!context.projectTags || !name) return null;
    const project = [...context.projects.values()].find((candidate) => candidate.name === name);
    return { id: `tag:${part.id}`, kind: "project-tag", name, projectId: project?.id ?? null };
  }
  if (part.name === "hand_off_to_project") {
    const project = context.projects.get(String(args.project_id ?? ""));
    if (!context.projectTags || !project) return null;
    return { id: `tag:${part.id}`, kind: "project-tag", name: project.name, projectId: project.id };
  }

  const action = describe(part.name, args);
  if (!action) return null;
  const computerId =
    (typeof args.computer_id === "string" ? args.computer_id : null) ??
    (typeof result?.details.computerId === "string" ? result.details.computerId : null);
  const computer =
    context.computers.find((candidate) => candidate.id === computerId) ??
    (context.computers.length === 1 ? context.computers[0] : undefined);

  let status: StepStatus;
  if (result) {
    // 没批准的一步，桥回给模型的话里写着「没有执行」。
    if (result.text.includes("没有执行：")) status = result.text.includes("作废") ? "expired" : "denied";
    else status = result.error ? "failed" : "done";
  } else if (running) {
    const waiting = context.approvals.some((approval) => !computer || approval.computerId === computer.id);
    status = waiting ? "waiting" : "running";
  } else {
    status = "unfinished";
  }

  const place = computer ? `在「${computer.name}」上` : "在电脑上";
  const did = status === "done" || status === "failed";
  const id = `tool:${part.id}`;
  return {
    id,
    kind: "tool",
    step: {
      callId: part.id,
      computer: computer?.name ?? computerId,
      icon: action.icon,
      title: place + action.verb + (did ? "了" : "") + action.object,
      status,
      output: readable((result?.text ?? output ?? "").slice(0, 4000), status),
      outputPath: typeof result?.details.outputPath === "string" ? result.details.outputPath : null,
      expanded: (status === "failed") !== context.toggled.has(id)
    }
  };
}

/**
 * pi-durable 把拦下的调用写成 `<harness>[error] Tool call blocked: …</harness>`，那是给模型看的。
 * 卡片里只留人看得懂的话；没批准的一步只留原因。
 */
export function readable(text: string, status: StepStatus): string {
  const lines: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "<harness>") {
      inside = true;
      continue;
    }
    if (trimmed === "</harness>") {
      inside = false;
      continue;
    }
    const close = line.indexOf("]");
    if (!inside || !line.startsWith("[") || close < 0) {
      lines.push(line);
      continue;
    }
    lines.push(line.slice(close + 1).trim().replace(/^Tool call blocked: /, ""));
  }
  const result = lines.join("\n").trim();
  const cut = result.indexOf("，没有执行：");
  if ((status === "denied" || status === "expired") && cut >= 0) {
    return `${result.slice(0, cut)}，这一步没有做。`;
  }
  return result;
}

/** 连着的几步合成一组，点开再看每一步。 */
function grouped(rows: readonly Row[], context: RowContext): Row[] {
  const result: Row[] = [];
  let run: Row[] = [];

  function flush() {
    const steps = run.flatMap((row) => (row.kind === "tool" ? [row.step] : []));
    if (steps.length < GROUP_MINIMUM) {
      result.push(...run);
      run = [];
      return;
    }
    const id = `group:${steps[0]!.callId}`;
    const expanded = context.toggled.has(id);
    const names = new Set(steps.flatMap((step) => (step.computer ? [step.computer] : [])));
    const place = names.size === 1 ? `在「${[...names][0]}」上` : "在电脑上";
    const failures = steps.filter((step) => ["failed", "denied", "expired"].includes(step.status)).length;
    const status: StepStatus = steps.some((step) => step.status === "waiting")
      ? "waiting"
      : steps.some((step) => step.status === "running")
        ? "running"
        : failures > 0
          ? "failed"
          : steps.some((step) => step.status === "unfinished")
            ? "unfinished"
            : "done";
    result.push({
      id,
      gap: run[0]!.gap,
      kind: "tool-group",
      title: `${place}做了 ${steps.length} 件事`,
      status,
      failures,
      expanded
    });
    if (expanded) result.push(...run.map((row) => ({ ...row, gap: 8 as const })));
    run = [];
  }

  for (const row of rows) {
    if (row.kind === "tool") {
      run.push(row);
    } else {
      flush();
      result.push(row);
    }
  }
  flush();
  return result;
}

/** 电脑上的一步，画成「在「mbpro」上跑了 npm test」。动词后面的英文和路径前面带空格。 */
function describe(
  name: string,
  args: Record<string, unknown>
): { icon: StepIcon; verb: string; object: string } | null {
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  const point = (x: string, y: string) => ` (${number(args[x])}, ${number(args[y])})`;
  switch (name) {
    case "run_command":
      return { icon: "terminal", verb: "跑", object: ` ${clip(text("command"))}` };
    case "write_stdin":
      return { icon: "keyboard", verb: "往命令里输入", object: `「${clip(text("data"))}」` };
    case "read_file":
      return { icon: "file", verb: "读", object: ` ${text("path")}` };
    case "write_file":
      return { icon: "pencil", verb: "写", object: ` ${text("path")}` };
    case "list_directory": {
      const path = text("path").trim();
      return { icon: "folder", verb: "看", object: path ? ` ${path}` : "主目录" };
    }
    case "computer_screenshot":
      return { icon: "screenshot", verb: "截", object: "屏" };
    case "computer_click":
      return {
        icon: "cursor",
        verb: Number(args.count ?? 1) >= 2 ? "双击" : "点",
        object: point("x", "y")
      };
    case "computer_move":
      return { icon: "cursor", verb: "把鼠标移到", object: point("x", "y") };
    case "computer_drag":
      return { icon: "cursor", verb: "拖", object: `${point("x", "y")} →${point("x2", "y2")}` };
    case "computer_scroll":
      return { icon: "cursor", verb: "滚动", object: "屏幕" };
    case "computer_type":
      return { icon: "keyboard", verb: "输入", object: `「${clip(text("text"))}」` };
    case "computer_key":
      return { icon: "keyboard", verb: "按", object: ` ${text("key")}` };
    default:
      return null;
  }
}

function clip(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.length > 0) ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function number(value: unknown): string {
  if (typeof value !== "number") return "?";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
