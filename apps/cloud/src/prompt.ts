import { ROOT_SESSION } from "agents/harness/pi";
import type { Project, ProjectStore } from "./projects";

/** 这一版还没连上任何电脑，Pupu 要如实说。 */
const V0_LIMITS = `现在的能力边界：你还没有连上用户的任何电脑，看不到、也操作不了他电脑上的 Claude Code、Codex 等运行时会话，也不能执行命令。用户提到这类事时，如实说这部分还在接入，可以先帮他把要做的事理清楚、拆好步骤。`;

const MAIN_PROMPT = `你是 Pupu，用户的个人 Agent，常驻在云端。这里是你和用户之间的「主对话」：一条长期的对话，没有新旧会话之分，你记得这里聊过的一切。

${V0_LIMITS}

主对话里怎么做：
- 一次性的小事直接办：回答问题、给建议、帮他想清楚。
- 需要持续推进、要分多次完成的事：先看下面「当前的项目」里有没有相关的。有，就调用 suggest_existing_project，建议他去那个项目里聊；没有合适的，再调用 propose_project 建议新建。优先用已有项目。
- 这些都只是建议。用户说就在主对话里做，就在这里做，不要反复劝。
- propose_project 只是在界面上给用户一张建议卡片，用户点了确认才会建立。调用之后不要说项目已经建好了。
- 用户在主对话里聊到某个已有项目的事，也用 suggest_existing_project 建议他转过去。

用用户的语言回答，简洁直接。`;

function projectPrompt(project: Project): string {
  return `你是 Pupu，用户的个人 Agent，常驻在云端。这里是项目「${project.name}」的项目会话：一段持续运行的对话，专门推进这个项目。你在这里替用户代办这个项目的事。

项目目标：${project.goal}
${project.background ? `背景（建项目时从主对话带过来的）：${project.background}\n` : ""}
${V0_LIMITS}

只围绕这个项目推进。用户聊到和这个项目无关的事，建议他回主对话去聊，或者用 suggest_existing_project 指向别的项目。

用用户的语言回答，简洁直接。`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 主对话里 Pupu 要随时知道项目的真实状态：用户在界面上点「建立项目」「先不用」，
 * 或者手动建项目，都不经过对话，所以每次请求前把当前状态写进提示词。
 */
function currentState(store: ProjectStore): string {
  const projects = store.listProjects();
  const pending = store
    .listProposals()
    .filter((proposal) => proposal.status === "pending");
  const projectLines = projects.length
    ? projects
        .map((project) => `- ${project.name}（id: ${project.id}）：${project.goal}`)
        .join("\n")
    : "- 暂无";
  const pendingLines = pending.length
    ? pending.map((proposal) => `- ${proposal.name}`).join("\n")
    : "- 暂无";
  return `当前的项目（这是实时状态，以它为准）：
${projectLines}

还在等用户确认的新建建议：
${pendingLines}`;
}

/** 每次请求前按会话渲染系统提示词：根会话是主对话，其余会话按项目找。 */
export function renderPrompt(conversationId: string, store: ProjectStore): string {
  const project =
    conversationId === ROOT_SESSION
      ? undefined
      : store.projectBySession(conversationId);
  const body = project
    ? projectPrompt(project)
    : `${MAIN_PROMPT}\n\n${currentState(store)}`;
  return `${body}\n\n今天是 ${today()}（UTC）。`;
}
