/**
 * 两种特殊的用户消息，服务端和网页都要认：
 * - 聊天交给项目的事，以用户消息的身份进入项目会话，开头带 `HANDOFF_MARK`；
 * - 用户引用某条消息回复，被引用的内容放在开头，写成 Markdown 引用块。
 * 都是纯文本，模型直接读得懂，网页再按格式画成对应的样子。
 */

export const HANDOFF_MARK = "[[pupu:handoff]]";

export function handoffMessage(task: string): string {
  return `${HANDOFF_MARK}\n${task}`;
}

/** 是转交消息就返回要做的事，不是就返回 null。 */
export function parseHandoff(text: string): string | null {
  return text.startsWith(HANDOFF_MARK)
    ? text.slice(HANDOFF_MARK.length).trim()
    : null;
}

/** 引用太长时截断：模型知道在回哪句就够了。 */
const QUOTE_LIMIT = 300;

export function quotedMessage(quote: string, reply: string): string {
  const clipped =
    quote.length > QUOTE_LIMIT ? `${quote.slice(0, QUOTE_LIMIT)}…` : quote;
  const block = clipped
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${block}\n\n${reply}`;
}

/** 拆出开头的引用块。没有引用时 quote 为 null。 */
export function parseQuote(text: string): { quote: string | null; body: string } {
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length && lines[index].startsWith(">")) index++;
  if (index === 0) return { quote: null, body: text };
  const quote = lines
    .slice(0, index)
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n");
  return { quote, body: lines.slice(index).join("\n").trim() };
}
