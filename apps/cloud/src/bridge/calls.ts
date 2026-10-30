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

/** 每个电脑工具的参数对应电脑上的哪个动作。执行和审批共用这一份。 */
const ACTIONS: Readonly<Record<string, (args: Args) => Action>> = {
  run_command: (args) => ({ kind: "run", command: str(args.command).trim(), background: args.background === true }),
  write_stdin: (args) => ({ kind: "stdin", commandId: str(args.command_id), data: str(args.data), eof: args.eof === true }),
  read_file: (args) => ({ kind: "read", path: str(args.path), maxBytes: MAX_READ_BYTES }),
  write_file: (args) => ({ kind: "write", path: str(args.path), content: str(args.content) }),
  list_directory: (args) => ({ kind: "list", path: str(args.path).trim() }),
  computer_screenshot: () => ({ kind: "computer", op: "screenshot" }),
  computer_click: (args) => ({
    kind: "computer",
    op: "click",
    x: num(args.x),
    y: num(args.y),
    ...(args.button === "right" || args.button === "middle" || args.button === "left" ? { button: args.button } : {}),
    ...(typeof args.count === "number" ? { count: args.count } : {}),
    ...marked(args)
  }),
  computer_move: (args) => ({ kind: "computer", op: "move", x: num(args.x), y: num(args.y) }),
  computer_drag: (args) => ({
    kind: "computer",
    op: "drag",
    x: num(args.x),
    y: num(args.y),
    x2: num(args.x2),
    y2: num(args.y2),
    ...marked(args)
  }),
  computer_scroll: (args) => ({ kind: "computer", op: "scroll", x: num(args.x), y: num(args.y), delta: num(args.delta) }),
  computer_type: (args) => ({ kind: "computer", op: "type", text: str(args.text), ...marked(args) }),
  computer_key: (args) => ({ kind: "computer", op: "key", key: str(args.key), ...marked(args) })
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
