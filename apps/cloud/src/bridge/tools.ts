import type { Context } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type, type TSchema } from "typebox";
import { actionOf } from "./calls.ts";
import type { ComputerBridge } from "./hub.ts";
import {
  MAX_STDIN_CHARS,
  MAX_WRITE_CHARS,
  type Action
} from "./protocol.ts";
import { foregroundTimeoutMs } from "./status.ts";

function text(value: string) {
  return [{ type: "text" as const, text: value }];
}

const pid = Type.Number({ description: "窗口所属进程的 pid，来自 computer_windows 或 computer_look" });
const windowId = Type.Number({ description: "窗口的 window_id，来自 computer_windows 或 computer_look" });
const element = Type.Optional(
  Type.String({ description: "computer_look 给的控件编号，写法是 <snapshot_id>:<行号>。优先用它，它比坐标准" })
);
const windowX = Type.Optional(Type.Number({ description: "窗口截图上的横坐标，窗口左上角是 0。没有控件编号时才用" }));
const windowY = Type.Optional(Type.Number({ description: "窗口截图上的纵坐标，窗口左上角是 0。没有控件编号时才用" }));
const label = Type.Optional(Type.String({ description: "这一步操作的东西叫什么，比如「发送」按钮。显示给用户看" }));
const foreground = Type.Optional(
  Type.Boolean({ description: "后台做不到时才设为 true：短暂切到前面，做完切回去。用户正在用电脑时会被拒绝" })
);

const computerId = Type.Optional(
  Type.String({
    description: "哪台电脑的 id，来自 list_computers。只有一台在线时可以不填"
  })
);

const sensitive = Type.Optional(
  Type.Boolean({
    description:
      "这一步会发消息、付款、提交表单或删除东西时设为 true。会先请用户在手机或网页上批准这一步"
  })
);

/**
 * 在授权电脑上执行的工具。跑命令和写文件不能重放：
 * 断线后这次调用作废，桥上按 requestId 也不会再跑一遍。
 */
export function createComputerTools(bridge: ComputerBridge): ToolRegistration[] {
  const listComputers = defineTool({
    name: "list_computers",
    description: "列出授权给用户的电脑，以及每台现在在不在线。",
    parameters: Type.Object({}),
    replay: "safe",
    async execute() {
      const computers = bridge.list();
      if (computers.length === 0) {
        return { output: text("还没有授权的电脑。"), details: { count: 0 } };
      }
      const lines = computers.map((computer) => {
        const state = computer.online ? "在线" : computer.stale ? "心跳中断" : "离线";
        return `- ${computer.name}（id: ${computer.id}）：${state}`;
      });
      return { output: text(lines.join("\n")), details: { count: computers.length } };
    }
  });

  const runCommand = defineTool({
    name: "run_command",
    description:
      "在授权电脑上跑一条命令。短命令等它结束；要跑很久就设 background 为 true，输出写在文件里，再用 read_file 看。到时间还没结束的命令会继续在后台跑，不会被杀掉。",
    parameters: Type.Object({
      command: Type.String({ description: "要执行的命令，交给这台电脑的登录 shell" }),
      computer_id: computerId,
      background: Type.Optional(
        Type.Boolean({ description: "true 表示放到后台，马上返回输出文件的路径。默认 false" })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "前台最多等多少秒，默认 30，最长 120。到点后命令继续在后台跑"
        })
      )
    }),
    replay: "unsafe",
    async execute(args, api, context) {
      const command = args.command.trim();
      if (!command) return { output: text("命令不能是空的。"), isError: true };
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          timeoutMs: foregroundTimeoutMs(args.timeout_seconds),
          signal: abortSignal(context),
          onOutput: (chunk) => {
            try {
              api.output(chunk);
            } catch {
              // 这次调用已经结束，输出不再往对话里补。
            }
          },
          action: actionOf("run_command", args)
        })
      );
    }
  });

  const writeStdin = defineTool({
    name: "write_stdin",
    description: "往一台电脑上还在跑的命令写输入。command_id 来自 run_command 的结果。",
    parameters: Type.Object({
      command_id: Type.String({ description: "正在跑的命令 id" }),
      data: Type.String({ description: "写到标准输入的文本" }),
      eof: Type.Optional(Type.Boolean({ description: "写完后关掉标准输入" })),
      computer_id: computerId
    }),
    replay: "unsafe",
    async execute(args, api, context) {
      if (args.data.length > MAX_STDIN_CHARS) {
        return { output: text("一次写进标准输入的内容太长了。"), isError: true };
      }
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("write_stdin", args)
        })
      );
    }
  });

  const readFile = defineTool({
    name: "read_file",
    description:
      "读授权电脑上的文本文件。只能读这台电脑用户主目录里的路径。命令的输出文件也用它看。",
    parameters: Type.Object({
      path: Type.String({ description: "文件路径，相对主目录或绝对路径" }),
      computer_id: computerId
    }),
    replay: "safe",
    async execute(args, api, context) {
      if (!args.path.trim()) return { output: text("路径不能是空的。"), isError: true };
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("read_file", args)
        })
      );
    }
  });

  const writeFile = defineTool({
    name: "write_file",
    description:
      "往授权电脑上写一个文本文件，父目录不存在会建出来。只能写这台电脑用户主目录里的路径。一次最多大约 20 万字，再大就用 run_command。",
    parameters: Type.Object({
      path: Type.String({ description: "文件路径，相对主目录或绝对路径" }),
      content: Type.String({ description: "文件的全部文本内容" }),
      computer_id: computerId
    }),
    replay: "unsafe",
    async execute(args, api, context) {
      if (!args.path.trim()) return { output: text("路径不能是空的。"), isError: true };
      if (args.content.length > MAX_WRITE_CHARS) {
        return {
          output: text("内容太长了，一次最多写大约 20 万字。更大的文件用 run_command 写。"),
          isError: true
        };
      }
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("write_file", args)
        })
      );
    }
  });

  const listDirectory = defineTool({
    name: "list_directory",
    description: "列授权电脑上的一个目录。只能列这台电脑用户主目录里的路径。不填 path 就是主目录。",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "目录路径。不填就是用户主目录" })),
      computer_id: computerId
    }),
    replay: "safe",
    async execute(args, api, context) {
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("list_directory", args)
        })
      );
    }
  });

  /** 电脑上的窗口操作都一个样：参数换成动作，交给桥。 */
  const computerTool = (
    name: string,
    description: string,
    parameters: Record<string, TSchema>,
    replay?: "safe"
  ) =>
    defineTool({
      name,
      description,
      parameters: Type.Object({ ...parameters, computer_id: computerId }),
      ...(replay ? { replay } : {}),
      async execute(args, api, context) {
        const { computer_id: chosen } = args as { computer_id?: string };
        return finish(
          await bridge.exec({
            requestId: api.callId,
            computerId: chosen,
            signal: abortSignal(context),
            action: actionOf(name, args as Record<string, unknown>)
          })
        );
      }
    });

  const screenTools = [
    computerTool(
      "computer_windows",
      "列出这台电脑上开着的窗口，拿到 pid 和 window_id。标着 off-screen 的在别的桌面空间或者最小化了。",
      { app: Type.Optional(Type.String({ description: "只看名字里带这段文字的应用" })) },
      "safe"
    ),
    computerTool(
      "computer_look",
      "看一个窗口：控件列表和截图。不填 pid 就看最前面的窗口。窗口被挡住也能看。控件编号看一次换一批。",
      {
        pid: Type.Optional(pid),
        window_id: Type.Optional(windowId),
        query: Type.Optional(Type.String({ description: "只看名字里带这段文字的控件。窗口很大时先用它缩小范围" }))
      },
      "safe"
    ),
    computerTool("computer_open", "在后台打开一个应用，不抢用户的前台。打开后会看一眼它的窗口。", {
      app: Type.String({ description: "应用名、bundle id 或者 .app 的路径" }),
      path: Type.Optional(Type.String({ description: "用这个应用打开的文件或网址" })),
      sensitive
    }),
    computerTool(
      "computer_click",
      "点窗口里的一处。不动用户的鼠标。button 可以是 left、right、middle。count 为 2 就是双击。点完会再看一眼窗口。",
      {
        pid,
        window_id: windowId,
        element,
        x: windowX,
        y: windowY,
        button: Type.Optional(Type.String({ description: "left、right 或 middle，默认 left" })),
        count: Type.Optional(Type.Number({ description: "点击次数，默认 1" })),
        label,
        foreground,
        sensitive
      }
    ),
    computerTool("computer_drag", "在窗口里从一个点按住拖到另一个点再松开。拖完会再看一眼窗口。", {
      pid,
      window_id: windowId,
      x: Type.Number({ description: "起点横坐标，窗口截图上的像素" }),
      y: Type.Number({ description: "起点纵坐标，窗口截图上的像素" }),
      x2: Type.Number({ description: "终点横坐标" }),
      y2: Type.Number({ description: "终点纵坐标" }),
      label,
      foreground,
      sensitive
    }),
    computerTool("computer_scroll", "滚动窗口里的一处。滚完会再看一眼窗口。", {
      pid,
      window_id: windowId,
      direction: Type.String({ description: "up、down、left 或 right" }),
      amount: Type.Optional(Type.Number({ description: "滚几格，默认 3" })),
      element,
      x: windowX,
      y: windowY,
      foreground
    }),
    computerTool(
      "computer_type",
      "往窗口里输入文字。给 element 就输到那个控件，不给就输到这个窗口的焦点。不按回车，回车用 computer_key。后台打字被拒时，原生输入框改用 computer_set。打完会再看一眼窗口。",
      {
        pid,
        window_id: windowId,
        text: Type.String({ description: "要输入的文字" }),
        element,
        x: windowX,
        y: windowY,
        label,
        foreground,
        sensitive
      }
    ),
    computerTool("computer_set", "直接设控件的值：填原生输入框、选下拉框的一项、拖滑块、填日期。网页里的输入框不要用它。设完会再看一眼窗口。", {
      pid,
      window_id: windowId,
      element: Type.String({ description: "computer_look 给的控件编号" }),
      value: Type.String({ description: "要设的值。下拉框写选项的名字" }),
      label,
      sensitive
    }),
    computerTool("computer_key", "在窗口里按一个键或组合键，比如 return、escape、cmd+c、cmd+shift+s。按完会再看一眼窗口。", {
      pid,
      window_id: windowId,
      key: Type.String({ description: "键名，组合用加号连接" }),
      element,
      foreground,
      sensitive
    }),
    computerTool("computer_menu", "点应用菜单栏里的一项。不用把应用切到前面。点完会再看一眼窗口。", {
      pid,
      window_id: windowId,
      menu: Type.Array(Type.String(), { description: "菜单路径，比如 [\"文件\", \"存储…\"]，用应用里显示的文字" }),
      sensitive
    })
  ];

  return [
    listComputers,
    runCommand,
    writeStdin,
    readFile,
    writeFile,
    listDirectory,
    ...screenTools
  ];
}

function abortSignal(context: Context): AbortSignal | undefined {
  return context.abortSignal;
}

function finish(result: {
  ok: boolean;
  text: string;
  computerId?: string;
  commandId?: string;
  outputPath?: string;
  image?: { data: string; mimeType: string };
}) {
  return {
    output: [
      { type: "text" as const, text: result.text },
      ...(result.image
        ? [{ type: "image" as const, data: result.image.data, mimeType: result.image.mimeType }]
        : [])
    ],
    isError: !result.ok,
    details: {
      ...(result.computerId ? { computerId: result.computerId } : {}),
      ...(result.commandId ? { commandId: result.commandId } : {}),
      ...(result.outputPath ? { outputPath: result.outputPath } : {})
    }
  };
}

export type { Action };
