import { useEffect, useState } from "react";
import type { ChatLine, ChatsView } from "../threads";

export type LineKey = "main" | "private";

export const LINE_NAMES: Record<LineKey, string> = { main: "大家", private: "私聊" };

export const LINE_HINTS: Record<LineKey, string> = { main: "发给大家和 Pupu", private: "只发给 Pupu" };

const SEEN_KEY = "pupu:chat-seen";

/** 每条聊天看到了哪一次回复。只记在本机，不做服务端已读。浏览器存储可能不可用，失败就只记在这一页。 */
function loadSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function saveSeen(seen: Record<string, number>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // 不记也能用。
  }
}

/**
 * 当前是大家还是私聊，以及没在显示的那条有没有新消息。打开时总在大家。
 * `onScreen` 是聊天页正显示着：显示着的那条算看过。
 */
export function useChatLines(chats: ChatsView, onScreen: boolean) {
  const [picked, setPicked] = useState<LineKey>("main");
  const [seen, setSeen] = useState(loadSeen);
  const own = chats.private;
  const line: LineKey = own ? picked : "main";
  const current: ChatLine = own && line === "private" ? own : chats.main;

  const { session, lastAt } = current;
  useEffect(() => {
    if (!onScreen || lastAt === null) return;
    setSeen((known) => {
      if ((known[session] ?? 0) >= lastAt) return known;
      const next = { ...known, [session]: lastAt };
      saveSeen(next);
      return next;
    });
  }, [onScreen, session, lastAt]);

  const isNew = (chat: ChatLine | null) =>
    chat !== null &&
    chat.lastAt !== null &&
    chat.lastAt > (seen[chat.session] ?? 0) &&
    !(onScreen && chat.session === session);

  return {
    line,
    session,
    canSwitch: own !== null,
    pick: setPicked,
    unread: { main: isNew(chats.main), private: isNew(own) } satisfies Record<LineKey, boolean>
  };
}
