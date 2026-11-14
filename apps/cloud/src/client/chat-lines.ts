import { useEffect, useState } from "react";
import type { ChatLine, ChatsView } from "../threads";

/** 输入栏的占位（Composer）：「我的 Pupu」写「给 Pupu 发消息」，空间写「在「X」里说」。 */
export const PRIVATE_HINT = "给 Pupu 发消息";
export function spaceHint(name: string): string {
  return `在「${name}」里说`;
}

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
 * 「我的 Pupu」是自己的私聊；本机开发没登录时没有私聊，退回全员那条。
 * `showing` 是正显示着的那条会话（没在看聊天是 null）：显示着的算看过。
 * 返回私聊（或退回的那条）和全员各自有没有没看过的回复。
 */
export function useChatLines(chats: ChatsView, showing: string | null) {
  const [seen, setSeen] = useState(loadSeen);
  const own: ChatLine = chats.private ?? chats.main;
  const shown = showing === own.session ? own : showing === chats.main.session ? chats.main : null;

  const session = shown?.session;
  const lastAt = shown?.lastAt ?? null;
  useEffect(() => {
    if (!session || lastAt === null) return;
    setSeen((known) => {
      if ((known[session] ?? 0) >= lastAt) return known;
      const next = { ...known, [session]: lastAt };
      saveSeen(next);
      return next;
    });
  }, [session, lastAt]);

  const isNew = (chat: ChatLine) =>
    chat.lastAt !== null && chat.lastAt > (seen[chat.session] ?? 0) && chat.session !== showing;

  return {
    /** 「我的 Pupu」打开的会话。 */
    own: own.session,
    isPrivate: chats.private !== null,
    unread: { own: isNew(own), everyone: chats.private !== null && isNew(chats.main) }
  };
}
