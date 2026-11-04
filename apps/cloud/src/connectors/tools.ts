import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { ConnectorError, type ActionInfo, type ConnectorClient } from "./client.ts";
import { serviceOf, type ConnectorRow } from "./store.ts";

/** 返回给模型的结果最多这么长，太长的截掉。 */
const OUTPUT_LIMIT = 20_000;
const SCHEMA_LIMIT = 1_500;

function text(value: string) {
  return [{ type: "text" as const, text: value }];
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…（后面截掉了）` : value;
}

/** 工具要用到的、Pupu 这边的状态。 */
export type ConnectorDeps = {
  /** 没部署 open-connector 时是 null，工具照实说。 */
  readonly client: () => ConnectorClient | null;
  readonly accounts: () => readonly ConnectorRow[];
  readonly emailOf: (memberId: string | null) => string | null;
};

export function describeAccount(row: ConnectorRow, emailOf: (memberId: string | null) => string | null): string {
  const name = serviceOf(row.service)?.name ?? row.service;
  const owner = emailOf(row.memberId);
  return `${name}${row.account ? `（${row.account}）` : ""}${owner ? `，${owner} 连的` : ""}`;
}

/** 动作 id 是「服务.动作」，比如 gmail.send_email。 */
export function serviceOfAction(actionId: string): string {
  return actionId.split(".")[0] ?? "";
}

/**
 * 这次调用用哪个账号。`account` 是模型给的：连接 id，或者账号名（邮箱、用户名）。
 * 这个服务只连了一个账号就用它；连了几个又没说，让模型先问用户。
 */
export function pickAccount(
  accounts: readonly ConnectorRow[],
  service: string,
  account: string | undefined
): { ok: true; row: ConnectorRow } | { ok: false; reason: string } {
  const candidates = accounts.filter((row) => row.service === service);
  const name = serviceOf(service)?.name ?? service;
  if (candidates.length === 0) {
    return { ok: false, reason: `还没有连上 ${name}。请用户在手机 App 的「我 → 账户」里连上再说。` };
  }
  const wanted = account?.trim().toLowerCase();
  if (wanted) {
    const row = candidates.find((each) => each.id === account || each.account?.toLowerCase() === wanted);
    if (row) return { ok: true, row };
  }
  if (candidates.length === 1 && !wanted) return { ok: true, row: candidates[0]! };
  const list = candidates.map((row) => `${row.account ?? "未命名"}（account: ${row.id}）`).join("、");
  return { ok: false, reason: `${name} 连了 ${candidates.length} 个账号：${list}。先问用户用哪个，再把 account 填上。` };
}

function describeAction(action: ActionInfo): string {
  const kind = action.operationType === "read" ? "读" : action.operationType === "destructive" ? "删" : "写";
  const schema = action.inputSchema ? clip(JSON.stringify(action.inputSchema), SCHEMA_LIMIT) : "{}";
  return `- ${action.id}（${kind}）：${action.description || action.name}\n  入参：${schema}`;
}

function failure(error: unknown) {
  const message =
    error instanceof ConnectorError
      ? `${error.message}（${error.code}）`
      : error instanceof Error
        ? error.message
        : String(error);
  return { output: text(`连接器出错了：${message}`), isError: true as const };
}

/**
 * 用成员连上的账号做事：先 connector_search 找动作，再 connector_run 跑。
 * 写和删要账号主人在手机上批准，在 beforeTool 里等（见 gate.ts 的 `plan`），不在这里。
 */
export function createConnectorTools(deps: ConnectorDeps): ToolRegistration[] {
  const notReady = () => ({
    output: text("连接器还没开（Pupu 这边没配 open-connector）。照实告诉用户，不要假装连上了。"),
    isError: true as const
  });

  const search = defineTool({
    name: "connector_search",
    description:
      "在成员连上的账号（Gmail、Google 日历、GitHub 等）里找能用的动作，返回动作 id、读还是写、入参的 JSON Schema。要读邮件、看日程、建 issue 这类事，先用它找，再用 connector_run 跑。",
    parameters: Type.Object({
      query: Type.String({ description: "想做的事，用英文关键词效果最好，比如 send email、list events" }),
      service: Type.Optional(Type.String({ description: "只在这个服务里找，比如 gmail、googlecalendar、github" }))
    }),
    replay: "safe",
    async execute(args) {
      const client = deps.client();
      if (!client) return notReady();
      const accounts = deps.accounts();
      const connected = [...new Set(accounts.map((row) => row.service))];
      const services = args.service ? [args.service] : connected;
      if (services.length === 0) {
        return { output: text("还没有人连账号。请用户在手机 App 的「我 → 账户」里连上。") };
      }
      try {
        const found = (await Promise.all(services.map((service) => client.search(args.query, service, 6)))).flat();
        const usable = found.filter((action) => connected.includes(action.service));
        if (usable.length === 0) {
          return {
            output: text(
              `没找到能用的动作。已经连上的：${accounts.map((row) => describeAccount(row, deps.emailOf)).join("；") || "无"}。`
            )
          };
        }
        return { output: text(usable.map(describeAction).join("\n")), details: { count: usable.length } };
      } catch (error) {
        return failure(error);
      }
    }
  });

  const run = defineTool({
    name: "connector_run",
    description:
      "用连上的账号跑一个动作，action_id 来自 connector_search。读的动作直接跑；发邮件、建日程、改 issue 这类写和删，会先等账号主人在手机上批准，工具自己等，不用你另外开口问。",
    parameters: Type.Object({
      action_id: Type.String({ description: "动作 id，比如 gmail.search_messages" }),
      input: Type.Record(Type.String(), Type.Unknown(), { description: "按这个动作的入参 Schema 填" }),
      account: Type.Optional(
        Type.String({ description: "这个服务连了几个账号时，填要用的那个账号（邮箱、用户名或 account id）" })
      )
    }),
    replay: "safe",
    async execute(args, api) {
      const client = deps.client();
      if (!client) return notReady();
      const picked = pickAccount(deps.accounts(), serviceOfAction(args.action_id), args.account);
      if (!picked.ok) return { output: text(picked.reason), isError: true };
      try {
        const result = await client.run(args.action_id, args.input, picked.row.alias, `pupu:${api.callId}`);
        return {
          output: text(clip(JSON.stringify(result ?? null), OUTPUT_LIMIT)),
          details: { actionId: args.action_id, account: picked.row.id }
        };
      } catch (error) {
        return failure(error);
      }
    }
  });

  return [search, run];
}

/** 要请示时的内容。读的动作返回 undefined，直接跑。 */
export type ConnectorAsk = {
  readonly subjectId: string;
  readonly ownerId: string | null;
  readonly title: string;
  readonly detail: string;
  readonly reason: string | null;
};

/**
 * connector_run 要不要先问：动作的读写分类以 open-connector 为准，查不到按写算。
 * 选不出账号时不拦，让工具自己去说明。
 */
export async function planConnectorCall(
  call: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
  deps: ConnectorDeps
): Promise<ConnectorAsk | undefined> {
  if (call.name !== "connector_run") return undefined;
  const client = deps.client();
  if (!client) return undefined;
  const actionId = String(call.arguments.action_id ?? "");
  const picked = pickAccount(
    deps.accounts(),
    serviceOfAction(actionId),
    typeof call.arguments.account === "string" ? call.arguments.account : undefined
  );
  if (!picked.ok) return undefined;
  const action = await client.action(actionId).catch(() => undefined);
  if (action?.operationType === "read") return undefined;
  const input = clip(JSON.stringify(call.arguments.input ?? {}, null, 2), 1_200);
  return {
    subjectId: connectorSubject(picked.row.id),
    ownerId: picked.row.memberId,
    title: `用 ${describeAccount(picked.row, () => null)}${action?.name ? `：${action.name}` : `：${actionId}`}`,
    detail: `${action?.description ? `${action.description}\n` : ""}${input}`,
    reason: action?.operationType === "destructive" ? "会删除或撤销东西，做了收不回来" : null
  };
}

/** 审批表里的 computer_id 一栏，连接器的写成这样，和电脑的分开。 */
export function connectorSubject(connectorId: string): string {
  return `connector:${connectorId}`;
}

export function connectorIdOf(subjectId: string): string | null {
  return subjectId.startsWith("connector:") ? subjectId.slice("connector:".length) : null;
}
