// 改编自 Cloudflare agents 仓库的 examples/next/harnesses/pi（MIT 协议，见 licenses/）。
import { useAgent } from "agents/react";
import { useCallback, useRef, useState } from "react";
import type { ClientMessage, ServerMessage, SessionView } from "../protocol";
import { EMPTY_VIEW, reduceEvents } from "../view";

export type ConnectionStatus = "connecting" | "open" | "closed";

type State = SessionView & { readonly status: ConnectionStatus };

/**
 * 通过 WebSocket 跟随 Pupu 的一个 pi 会话。服务端发 pi 自己的事件，这里用
 * `reduceEvents` 折叠成界面状态。重连时会拿到新快照，所以不需要续传。
 * 换会话时请给使用它的组件换 `key`，让连接整个重建。
 */
export function usePiSession(session: string, onProjectsChanged: () => void) {
  const [state, setState] = useState<State>({
    ...EMPTY_VIEW,
    status: "connecting"
  });
  const changed = useRef(onProjectsChanged);
  changed.current = onProjectsChanged;

  const agent = useAgent({
    agent: "pupu",
    name: "me",
    query: { session },
    onOpen: () => setState((current) => ({ ...current, status: "open" })),
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
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
            ...reduceEvents(current, message.events)
          }));
          return;
        case "projects_changed":
        case "computers_changed":
          changed.current();
          return;
        case "error":
          setState((current) => ({ ...current, error: message.message }));
          return;
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

  /** 空闲时开始一轮；忙的时候排在后面，或者插进正在进行的这一轮。 */
  const submit = useCallback(
    (text: string, whenBusy: "followUp" | "steer" = "followUp") =>
      send({ type: "submit", id: crypto.randomUUID(), input: text, whenBusy }),
    [send]
  );

  const abort = useCallback(
    () => send({ type: "abort", id: crypto.randomUUID() }),
    [send]
  );

  return { ...state, submit, abort };
}
