import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { ROOT_SESSION } from "agents/harness/pi";
import { Type } from "typebox";
import type { ProjectStore } from "./projects";

function text(value: string) {
  return [{ type: "text" as const, text: value }];
}

/**
 * Pupu 在对话里能用的工具。所有会话共用同一套工具，按调用它的会话区分：
 * 建议新建项目只在主对话里可用。
 */
export function createPupuTools(
  store: ProjectStore,
  /** 项目或建议变了，通知所有打开的页面。 */
  changed: () => void
): ToolRegistration[] {
  const listProjects = defineTool({
    name: "list_projects",
    description:
      "列出用户已有的项目：名称、目标和 id。在建议新建项目之前先调用，看有没有相关的已有项目。",
    parameters: Type.Object({}),
    replay: "safe",
    async execute() {
      const projects = store.listProjects();
      const lines = projects.map(
        (project) => `- ${project.name}（id: ${project.id}）：${project.goal}`
      );
      return {
        output: text(projects.length === 0 ? "还没有任何项目。" : lines.join("\n")),
        details: { count: projects.length }
      };
    }
  });

  const proposeProject = defineTool({
    name: "propose_project",
    description:
      "在主对话里给用户展示一张「新建项目」的建议卡片。只用于需要持续推进、要分多次完成的事，并且已经用 list_projects 确认没有合适的已有项目。用户点了确认才会建立。",
    parameters: Type.Object({
      name: Type.String({ description: "项目名，简短，比如「登录改版」" }),
      goal: Type.String({ description: "一句话说明这个项目要达成什么" }),
      background: Type.String({
        description:
          "要带进项目会话的背景：用户在主对话里说过的要求、约束和已经聊定的东西"
      })
    }),
    replay: "safe",
    async execute(args, api) {
      if (String(api.conversationId) !== ROOT_SESSION) {
        return {
          output: text("只能在主对话里建议新建项目。"),
          isError: true
        };
      }
      // 用 tool call id 当建议 id：重放时不会重复建，界面也靠它把卡片和状态对上。
      store.addProposal({ id: api.callId, ...args });
      changed();
      return {
        output: text(
          "已在对话里给用户展示「新建项目」的建议卡片，要等用户点确认才会建立。不要说项目已经建好。"
        ),
        details: { proposalId: api.callId }
      };
    }
  });

  const suggestExistingProject = defineTool({
    name: "suggest_existing_project",
    description:
      "给用户展示一张「去项目里聊」的卡片：用户说的事属于某个已有项目时，建议他转到那个项目的会话里去聊。project_id 来自 list_projects。",
    parameters: Type.Object({
      project_id: Type.String({ description: "已有项目的 id" }),
      reason: Type.String({ description: "为什么建议去那个项目聊，一句话" })
    }),
    replay: "safe",
    async execute(args) {
      const project = store.getProject(args.project_id);
      if (!project) {
        const known = store
          .listProjects()
          .map((item) => `${item.name}（id: ${item.id}）`)
          .join("、");
        return {
          output: text(
            `没有 id 为 ${args.project_id} 的项目。已有项目：${known || "无"}。`
          ),
          isError: true
        };
      }
      return {
        output: text(
          `已给用户展示「去「${project.name}」里聊」的卡片。用户可能会过去，也可能就在这里继续，两种都可以。`
        ),
        details: { projectId: project.id, name: project.name }
      };
    }
  });

  return [listProjects, proposeProject, suggestExistingProject];
}
