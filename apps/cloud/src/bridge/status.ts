import {
  FOREGROUND_DEFAULT_MS,
  FOREGROUND_MAX_MS,
  OUTPUT_TAIL_CHARS,
  STALE_MS,
  type ComputerView
} from "./protocol.ts";

export type ComputerCandidate = ComputerView;

const NONE =
  "还没有授权的电脑。在电脑上配对桥之后，才能在上面跑命令、读写文件。";

export function selectComputer(
  computers: readonly ComputerCandidate[],
  requestedId: string | undefined
): { ok: true; computer: ComputerCandidate } | { ok: false; text: string } {
  if (requestedId) {
    const found = computers.find((computer) => computer.id === requestedId);
    if (!found) return { ok: false, text: unknownComputer(requestedId, computers) };
    if (found.online) return { ok: true, computer: found };
    if (found.stale) return { ok: false, text: staleComputer(found.name) };
    return { ok: false, text: offlineComputer(found.name) };
  }
  const online = computers.filter((computer) => computer.online);
  if (online.length === 1) return { ok: true, computer: online[0]! };
  if (online.length > 1) return { ok: false, text: manyComputers(online) };
  if (computers.length === 0) return { ok: false, text: NONE };
  return { ok: false, text: noneOnline(computers) };
}

export function unknownComputer(id: string, computers: readonly ComputerCandidate[]): string {
  const list = computers.map((computer) => `${computer.name}（id: ${computer.id}）`).join("、");
  return `没有 id 为 ${id} 的电脑。已有电脑：${list || "无"}。`;
}

export function offlineComputer(name: string): string {
  return `「${name}」现在没连上。桥要在这台电脑上开着，才能在上面跑命令。等它回来再做。`;
}

export function staleComputer(name: string): string {
  return `「${name}」心跳停了，先当成用不了。等它回来再做。`;
}

export function noneOnline(computers: readonly ComputerCandidate[]): string {
  const names = computers.map((computer) => `「${computer.name}」`).join("、");
  return `你的电脑现在没连上。${names}都离线了。桥要在电脑上开着，才能在上面跑命令、读写文件。等它回来再做。`;
}

export function manyComputers(computers: readonly ComputerCandidate[]): string {
  const list = computers.map((computer) => `${computer.name}（id: ${computer.id}）`).join("、");
  return `有多台电脑在线：${list}。请指定 computer_id。`;
}

export function unavailableComputer(name: string): string {
  return `「${name}」没有回应，先当成用不了。`;
}

export function disconnectedComputer(name: string, outputPath?: string): string {
  const file = outputPath ? `已经产生的输出在文件里：${outputPath}` : "等它回来再做。";
  return `「${name}」刚刚断开了。${file}`;
}

export function foregroundTimeoutMs(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return FOREGROUND_DEFAULT_MS;
  const ms = Math.round(seconds * 1000);
  if (ms < 1000) return 1000;
  if (ms > FOREGROUND_MAX_MS) return FOREGROUND_MAX_MS;
  return ms;
}

export function appendTail(
  current: string,
  chunk: string,
  limit = OUTPUT_TAIL_CHARS
): { text: string; truncated: boolean } {
  const next = current + chunk;
  if (next.length <= limit) return { text: next, truncated: false };
  return { text: next.slice(next.length - limit), truncated: true };
}

/** 前台命令这次调用怎么结束的：到时间转到后台、自己退出了、被停掉了。 */
export type RunEnd =
  | { readonly kind: "detached" }
  | { readonly kind: "exited"; readonly code: number | null }
  | { readonly kind: "stopped"; readonly by: "user" | "cloud" };

export function formatRun(input: {
  name: string;
  commandId: string;
  outputPath: string;
  output: string;
  truncated: boolean;
  end: RunEnd;
}): { ok: boolean; text: string } {
  const head = input.truncated ? "（前面的输出省掉了，完整的在文件里）\n" : "";
  const body = input.output ? `\n\n${head}${input.output}` : "";
  const where = `命令 id：${input.commandId}\n输出文件：${input.outputPath}`;
  switch (input.end.kind) {
    case "detached":
      return {
        ok: true,
        text: `在「${input.name}」上到时间还没结束，命令继续在后台跑。用 read_file 看输出，用 write_stdin 往里写输入。\n${where}${body}`
      };
    case "exited":
      return {
        ok: input.end.code === 0,
        text: `在「${input.name}」上跑完了，退出码 ${input.end.code ?? "无"}。\n${where}${body}`
      };
    case "stopped":
      return {
        ok: false,
        text:
          input.end.by === "user"
            ? `在「${input.name}」上，这条命令被用户在电脑上停掉了。要不要再跑，先问用户。\n${where}${body}`
            : `在「${input.name}」上，这条命令已经停掉了。\n${where}${body}`
      };
  }
}

export function fresh(lastBeatAt: number, now: number): boolean {
  return now - lastBeatAt <= STALE_MS;
}

export function describeComputers(computers: readonly ComputerView[]): string {
  const lines = computers.length
    ? computers
        .map((computer) => {
          const state = computer.online ? "在线" : computer.stale ? "心跳中断" : "离线";
          return `- ${computer.name}（id: ${computer.id}）：${state}`;
        })
        .join("\n")
    : "- 还没有授权的电脑";
  return `当前的电脑（这是实时状态，以它为准）：\n${lines}`;
}
