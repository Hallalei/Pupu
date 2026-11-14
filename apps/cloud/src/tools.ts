import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Project, ProjectStore } from "./projects.ts";
import { mayRead } from "./access.ts";
import type { Thread } from "./threads.ts";
import { isSpaceIcon, SPACE_ICONS, type SpaceIcon } from "./space-look.ts";

function text(value: string) {
  return [{ type: "text" as const, text: value }];
}

/** 工具要用到的、Pupu 自己的动作。 */
export type PupuActions = {
  readonly store: ProjectStore;
  threadOf(session: string): Thread | undefined;
  createProject(input: {
    name: string;
    goal: string;
    background: string;
    /** 没给就按名字挑。 */
    icon?: SpaceIcon;
  }): Promise<Project>;
  /** 把一件事交给项目会话去做，`origin` 是从哪条聊天转来的。同一个 operationId 只交一次。 */
  handOff(project: Project, task: string, operationId: string, origin: string): Promise<void>;
};

function onlyInChat(thread: Thread | undefined) {
  return thread?.kind === "main" || thread?.kind === "private"
    ? null
    : { output: text("只能在全员或私聊里用。"), isError: true as const };
}

/**
 * Pupu 在对话里能用的工具。所有会话共用同一套工具，按调用它的会话区分：
 * 建项目和转交只在聊天里可用。
 */
export function createPupuTools(actions: PupuActions): ToolRegistration[] {
  const { store } = actions;

  const listProjects = defineTool({
    name: "list_projects",
    description: "列出用户已有的项目：名称、目标和 id。",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api) {
      const from = actions.threadOf(String(api.conversationId));
      const projects = from ? store.listProjects().filter((project) => mayRead(from, project)) : [];
      const lines = projects.map(
        (project) => `- ${project.name}（id: ${project.id}）：${project.goal}`
      );
      return {
        output: text(projects.length === 0 ? "还没有任何项目。" : lines.join("\n")),
        details: { count: projects.length }
      };
    }
  });

  const createProject = defineTool({
    name: "create_project",
    description:
      "建一个新项目：一段持续运行的项目会话，专门推进一件事。只在用户同意建项目之后调用（你先用一句话问过，他说好），或者用户自己明确要求建项目。",
    parameters: Type.Object({
      name: Type.String({ description: "项目名，简短，比如「AI 账号整理」" }),
      goal: Type.String({ description: "一句话说明这个项目要达成什么" }),
      background: Type.String({
        description:
          "要带进项目的背景：用户在聊天里说过的要求、约束和已经聊定的东西。项目大家都看得到，在私聊里只写这件事需要的，不带无关的私事"
      }),
      task: Type.Optional(
        Type.String({
          description:
            "建好后要马上在项目里做的第一件事，写清楚。在大家那里带上用户的原话；在私聊里只写这件事需要的内容，不抄原话，不带无关的私事。没有就省略"
        })
      ),
      icon: Type.Optional(
        Type.String({
          description: `项目名前面的像素图标，按名字挑一个最贴的，比如「官网改版」用 globe。只能是这些之一：${SPACE_ICONS.join("、")}`
        })
      )
    }),
    replay: "safe",
    async execute(args, api) {
      const origin = String(api.conversationId);
      const refused = onlyInChat(actions.threadOf(origin));
      if (refused) return refused;
      // 用 tool call id 去重：重放时不会建出第二个项目。
      const key = `create_project:${api.callId}`;
      const known = store.meta(key);
      const project =
        (known && store.getProject(known)) ||
        (await actions.createProject({
          name: args.name,
          goal: args.goal,
          background: args.background,
          icon: isSpaceIcon(args.icon) ? args.icon : undefined
        }));
      store.setMeta(key, project.id);
      const task =
        args.task?.trim() ||
        "项目刚建好。用两三句话说说这个项目接下来怎么推进、需要用户提供什么。";
      await actions.handOff(project, task, `kickoff:${api.callId}`, origin);
      return {
        output: text(
          `项目「${project.name}」建好了，已经在那边开始推进。用一两句话告诉用户项目建好了、接下来在那边做什么；不要把 id 告诉用户。`
        ),
        details: { projectId: project.id, name: project.name }
      };
    }
  });

  const handOffToProject = defineTool({
    name: "hand_off_to_project",
    description:
      "把用户的一件事交给已有项目去做。项目会在自己的会话里接着做，做完、卡住或出错时报回聊天。project_id 来自「当前的项目」。",
    parameters: Type.Object({
      project_id: Type.String({ description: "已有项目的 id" }),
      task: Type.String({
        description:
          "要项目做的事，写清楚、能独立看懂。在大家那里带上用户的原话和链接；在私聊里只写这件事需要的内容，不抄原话，不带无关的私事"
      })
    }),
    replay: "safe",
    async execute(args, api) {
      const origin = String(api.conversationId);
      const from = actions.threadOf(origin);
      const refused = onlyInChat(from);
      if (refused || !from) return refused!;
      // 交过去的事和报回来的结果会留在这条聊天里，这条聊天的全部受众都得看得到那个空间。
      const found = store.getProject(args.project_id);
      const project = found && mayRead(from, found) ? found : undefined;
      if (!project) {
        const known = store
          .listProjects()
          .filter((item) => mayRead(from, item))
          .map((item) => `${item.name}（id: ${item.id}）`)
          .join("、");
        return {
          output: text(
            `没有 id 为 ${args.project_id} 的项目。已有项目：${known || "无"}。`
          ),
          isError: true
        };
      }
      await actions.handOff(project, args.task, `handoff:${api.callId}`, origin);
      return {
        output: text(
          `已经交给「${project.name}」，它会在那个项目里做，做完会报回聊天。用一两句话告诉用户已经交给「${project.name}」在做了，不要在聊天里自己再做一遍。`
        ),
        details: { projectId: project.id, name: project.name }
      };
    }
  });

  return [listProjects, createProject, handOffToProject];
}
