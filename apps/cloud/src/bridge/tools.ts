import type { Context } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
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

const screenX = Type.Number({ description: "截图像素的横坐标，左上角是 0" });
const screenY = Type.Number({ description: "截图像素的纵坐标，左上角是 0" });

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

  const screenshot = defineTool({
    name: "computer_screenshot",
    description:
      "截这台电脑的主屏幕。先看这张图，再用图上的像素坐标去点、拖、滚动。原点在左上角。屏幕变了就重新截。",
    parameters: Type.Object({ computer_id: computerId }),
    replay: "safe",
    async execute(args, api, context) {
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("computer_screenshot", args)
        })
      );
    }
  });

  const click = defineTool({
    name: "computer_click",
    description: "在最近一张截图的像素坐标上点一下。点完会再截一张图。button 可以是 left、right、middle。count 为 2 就是双击。",
    parameters: Type.Object({
      x: screenX,
      y: screenY,
      button: Type.Optional(Type.String({ description: "left、right 或 middle，默认 left" })),
      count: Type.Optional(Type.Number({ description: "点击次数，默认 1" })),
      sensitive,
      computer_id: computerId
    }),
    async execute(args, api, context) {
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("computer_click", args)
        })
      );
    }
  });

  const move = defineTool({
    name: "computer_move",
    description: "把鼠标移到截图上的一个点，不点击。用来露出悬停才会出现的东西。移完会再截一张图。",
    parameters: Type.Object({ x: screenX, y: screenY, computer_id: computerId }),
    async execute(args, api, context) {
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("computer_move", args)
        })
      );
    }
  });

  const drag = defineTool({
    name: "computer_drag",
    description: "从截图上的一个点按住拖到另一个点再松开。拖完会再截一张图。",
    parameters: Type.Object({
      x: screenX,
      y: screenY,
      x2: Type.Number({ description: "终点横坐标" }),
      y2: Type.Number({ description: "终点纵坐标" }),
      sensitive,
      computer_id: computerId
    }),
    async execute(args, api, context) {
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("computer_drag", args)
        })
      );
    }
  });

  const scroll = defineTool({
    name: "computer_scroll",
    description: "在截图上的一个点滚动。delta 为正往上，为负往下。滚完会再截一张图。",
    parameters: Type.Object({
      x: screenX,
      y: screenY,
      delta: Type.Number({ description: "滚动量，正数往上，负数往下" }),
      computer_id: computerId
    }),
    async execute(args, api, context) {
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("computer_scroll", args)
        })
      );
    }
  });

  const typeText = defineTool({
    name: "computer_type",
    description: "往当前焦点输入文字。先点中输入框。打完会再截一张图。",
    parameters: Type.Object({
      text: Type.String({ description: "要输入的文字" }),
      sensitive,
      computer_id: computerId
    }),
    async execute(args, api, context) {
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("computer_type", args)
        })
      );
    }
  });

  const pressKey = defineTool({
    name: "computer_key",
    description: "按一个键或组合键，比如 enter、escape、cmd+c、cmd+shift+space。按完会再截一张图。",
    parameters: Type.Object({
      key: Type.String({ description: "键名，组合用加号连接" }),
      sensitive,
      computer_id: computerId
    }),
    async execute(args, api, context) {
      return finish(
        await bridge.exec({
          requestId: api.callId,
          computerId: args.computer_id,
          signal: abortSignal(context),
          action: actionOf("computer_key", args)
        })
      );
    }
  });

  return [
    listComputers,
    runCommand,
    writeStdin,
    readFile,
    writeFile,
    listDirectory,
    screenshot,
    click,
    move,
    drag,
    scroll,
    typeText,
    pressKey
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
