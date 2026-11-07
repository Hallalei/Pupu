import { MAX_READ_BYTES, type Action } from "./protocol.ts";

type Args = Readonly<Record<string, unknown>>;

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function marked(args: Args): { sensitive?: true } {
  return args.sensitive === true ? { sensitive: true } : {};
}

/** 屏幕输入共用的：哪个窗口、窗口里的哪一处，给人看的名字，要不要切到前面。 */
function aimed(args: Args) {
  return {
    pid: num(args.pid),
    windowId: num(args.window_id),
    ...(str(args.element) ? { element: str(args.element) } : {}),
    x: num(args.x),
    y: num(args.y),
    ...(str(args.label) ? { label: str(args.label) } : {}),
    ...(args.foreground === true ? { foreground: true } : {}),
    ...marked(args)
  };
}

function pressed(args: Args): { button?: "left" | "right" | "middle" } {
  return args.button === "right" || args.button === "middle" || args.button === "left" ? { button: args.button } : {};
}

/** 每个电脑工具的参数对应电脑上的哪个动作。执行和审批共用这一份。 */
const ACTIONS: Readonly<Record<string, (args: Args) => Action>> = {
  run_command: (args) => ({ kind: "run", command: str(args.command).trim(), background: args.background === true }),
  write_stdin: (args) => ({ kind: "stdin", commandId: str(args.command_id), data: str(args.data), eof: args.eof === true }),
  read_file: (args) => ({ kind: "read", path: str(args.path), maxBytes: MAX_READ_BYTES }),
  write_file: (args) => ({ kind: "write", path: str(args.path), content: str(args.content) }),
  list_directory: (args) => ({ kind: "list", path: str(args.path).trim() }),
  computer_windows: (args) => ({ kind: "computer", op: "windows", ...(str(args.app) ? { app: str(args.app) } : {}) }),
  computer_look: (args) => ({
    kind: "computer",
    op: "look",
    pid: num(args.pid),
    windowId: num(args.window_id),
    ...(str(args.query) ? { query: str(args.query) } : {})
  }),
  computer_open: (args) => ({
    kind: "computer",
    op: "open",
    app: str(args.app),
    ...(str(args.path) ? { path: str(args.path) } : {}),
    ...marked(args)
  }),
  computer_click: (args) => ({
    kind: "computer",
    op: "click",
    ...aimed(args),
    ...pressed(args),
    ...(typeof args.count === "number" ? { count: args.count } : {})
  }),
  computer_drag: (args) => ({ kind: "computer", op: "drag", ...aimed(args), ...pressed(args), x2: num(args.x2), y2: num(args.y2) }),
  computer_scroll: (args) => ({
    kind: "computer",
    op: "scroll",
    ...aimed(args),
    ...(args.direction === "up" || args.direction === "down" || args.direction === "left" || args.direction === "right"
      ? { direction: args.direction }
      : {}),
    amount: num(args.amount)
  }),
  computer_type: (args) => ({ kind: "computer", op: "type", ...aimed(args), text: str(args.text) }),
  computer_set: (args) => ({ kind: "computer", op: "set", ...aimed(args), text: str(args.value) }),
  computer_key: (args) => ({ kind: "computer", op: "key", ...aimed(args), key: str(args.key) }),
  computer_menu: (args) => ({
    kind: "computer",
    op: "menu",
    ...aimed(args),
    menu: Array.isArray(args.menu) ? args.menu.filter((item): item is string => typeof item === "string") : []
  })
};

/** 模型调的这个工具要在哪台电脑上做什么。不是电脑上的动作就返回 null。 */
export function actionForCall(
  name: string,
  args: Args
): { readonly action: Action; readonly computerId?: string } | null {
  const build = ACTIONS[name];
  if (!build) return null;
  const computerId = typeof args.computer_id === "string" && args.computer_id ? args.computer_id : undefined;
  return { action: build(args), ...(computerId ? { computerId } : {}) };
}

/** 工具执行时用：名字一定在表里。 */
export function actionOf(name: string, args: Args): Action {
  const build = ACTIONS[name];
  if (!build) throw new Error(`${name} 不是电脑工具`);
  return build(args);
}
