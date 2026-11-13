/**
 * 两种特殊的用户消息，服务端和网页都要认：
 * - 聊天交给项目的事，以用户消息的身份进入项目会话，开头带 `HANDOFF_MARK`；
 * - 用户引用某条消息回复，被引用的内容放在开头，写成 Markdown 引用块。
 * 都是纯文本，模型直接读得懂，网页再按格式画成对应的样子。
 *
 * 发送者不走这条路：正文是人打的字，放在文字里就能被冒充。服务端把它记在 pi 的 entry 上，见 `sentInput`。
 */

import type { InputEntry, UserInput } from "@earendil-works/pi-durable";

export const HANDOFF_MARK = "[[pupu:handoff]]";

export function handoffMessage(task: string): string {
  return `${HANDOFF_MARK}\n${task}`;
}

/**
 * Pupu 自己送进对话的消息：电脑那边晚些才有的结果，比如后台命令跑完了、离线的电脑连上了（见 bridge/followups.ts）。
 * 以用户消息的身份进去，好叫醒这条对话；模型看开头认得出不是人说的，界面画成居中的一行。
 */
export const NOTICE_MARK = "[[pupu:notice]]";

export function noticeMessage(text: string): string {
  return `${NOTICE_MARK}\n${text}`;
}

export function parseNotice(text: string): string | null {
  return text.startsWith(NOTICE_MARK) ? text.slice(NOTICE_MARK.length).trim() : null;
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

/** 发这条消息的成员。名字是发的时候的名字，人走了或者改名了，老消息照旧。 */
export type Sender = { readonly id: string; readonly name: string };

/** 成员发的消息在 pi 里的 entry 种类，代替 `pi.user`。 */
export const SENT_ENTRY = "pupu.sent";

/** 模型看到的第一行的开头。 */
const SENDER_HEADER = "【发送者：";

/** 成员自己打的字里写同样的抬头，给模型看的时候改掉，不让他冒充别人。界面上还是原话。 */
function defused(text: string): string {
  return text.replaceAll(SENDER_HEADER, "[发送者：");
}

/**
 * 给成员发的消息署名，做法见 earendil-works/pi#10407：模型看第一行的抬头，界面看 entry 上的
 * `sender` 和原话 `input`，不用从正文里解析。名字是服务端按设备查出来的，客户端带不进来。
 */
export function sentInput(input: UserInput, sender: Sender): { content: UserInput; entry: InputEntry } {
  const header = `${SENDER_HEADER}${sender.name}】`;
  return {
    content:
      typeof input === "string"
        ? `${header}\n${defused(input)}`
        : [
            { type: "text", text: header },
            ...input.map((part) => (part.type === "text" ? { ...part, text: defused(part.text) } : part))
          ],
    entry: { kind: SENT_ENTRY, data: { sender, input } as unknown as InputEntry["data"] }
  };
}

/**
 * 电脑前的人在 Pupu 主窗口里接手完浏览器、收起了放大视图时，叫醒对话的那句系统消息。界面上只显示第一行。
 */
export function handbackNotice(computer: string): string {
  return [
    `「${computer}」前的人在 Pupu 里接手完浏览器，收起了放大视图。`,
    "接着做刚才的浏览器任务：先看一眼页面现在的样子（比如是不是已经登录了），再往下做。还没弄好（比如没登录上）就在对话里说一声，等他回话，不要马上再交给他一次；已经不需要了就不用做。"
  ].join("\n");
}

/** 人在卡片或电脑上接手的放大视图里点了「取消任务」、这一轮已经停着时，替人发的这句话。卡片认它算「已停下」。 */
export const BROWSER_CANCEL_TEXT = "不用继续了，取消这个浏览器任务。";
