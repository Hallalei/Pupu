// 改编自 Cloudflare agents 仓库的 examples/next/harnesses/pi（MIT 协议，见 licenses/）。
import { useAgent } from "agents/react";
import { useCallback, useRef, useState } from "react";
import type { ComputerActivity } from "../bridge/activity";
import { REVOKED_CLOSE_CODE, type ClientMessage, type ServerMessage, type SessionView } from "../protocol";
import { EMPTY_VIEW, reduceEvents } from "../view";

export type ConnectionStatus = "connecting" | "open" | "closed";

type State = SessionView & {
  readonly status: ConnectionStatus;
  /** 这条聊天的内容到了。没到时不知道它是不是空的。 */
  readonly synced: boolean;
};

/** 发出去、还没等到回话的消息：服务端回 `result` 算收下，回 `error` 或者连接断了算没收下。 */
type Reply = { readonly resolve: () => void; readonly reject: (error: Error) => void };

/**
 * 通过 WebSocket 跟随 Pupu 的一个 pi 会话。服务端发 pi 自己的事件，这里用
 * `reduceEvents` 折叠成界面状态。重连时会拿到新快照，所以不需要续传。
 * 换会话时请给使用它的组件换 `key`，让连接整个重建。
 */
export function usePiSession(
  session: string,
  onProjectsChanged: () => void,
  onActivity?: (activity: readonly ComputerActivity[]) => void
) {
  const [state, setState] = useState<State>({
    ...EMPTY_VIEW,
    status: "connecting",
    synced: false
  });
  const changed = useRef(onProjectsChanged);
  changed.current = onProjectsChanged;
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const replies = useRef(new Map<string, Reply>());
  const takeReply = (id: string | undefined) => {
    const reply = id === undefined ? undefined : replies.current.get(id);
    if (id !== undefined) replies.current.delete(id);
    return reply;
  };

  const agent = useAgent({
    agent: "pupu",
    name: "me",
    query: { session },
    onOpen: () => setState((current) => ({ ...current, status: "open" })),
    onClose: (event) => {
      setState((current) => ({ ...current, status: "closed" }));
      // 回话跟着连接走：连接断了就等不到了，那几条按没发出去处理，重发时服务端按 operationId 去重。
      for (const reply of replies.current.values()) reply.reject(new Error("连接断了，这条没发出去。"));
      replies.current.clear();
      // 这个浏览器被吊销了：马上重新拉一次状态，拿到 401 就换成登录页，不用等轮询。
      if (event.code === REVOKED_CLOSE_CODE) changed.current();
    },
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case "events":
          setState((current) => ({
            ...current,
            ...reduceEvents(current, message.events),
            synced: true
          }));
          return;
        case "projects_changed":
        case "computers_changed":
        case "approvals_changed":
        case "devices_changed":
          changed.current();
          return;
        case "activity":
          activity.current?.(message.activity);
          return;
        case "result":
          takeReply(message.id)?.resolve();
          return;
        case "error": {
          const reply = takeReply(message.id);
          if (reply) reply.reject(new Error(message.message));
          else setState((current) => ({ ...current, error: message.message }));
          return;
        }
        default:
          return;
      }
    }
  });

  const send = useCallback(
    (message: ClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
        return true;
      }
      return false;
    },
    [agent]
  );

  /**
   * 空闲时开始一轮；忙的时候排在后面。服务端收下了才 resolve，拒了或者连接断了就 reject。
   * `id` 同时是 pi 的 operationId：同一个 id 发两次，服务端只收一次。
   */
  const submit = useCallback(
    (text: string, id: string) =>
      new Promise<void>((resolve, reject) => {
        replies.current.set(id, { resolve, reject });
        if (!send({ type: "submit", id, operationId: id, input: text, whenBusy: "followUp" })) {
          replies.current.delete(id);
          reject(new Error("还没连上 Pupu，这条没发出去。"));
        }
      }),
    [send]
  );

  const abort = useCallback(
    () => send({ type: "abort", id: crypto.randomUUID() }),
    [send]
  );

  return { ...state, submit, abort };
}
