/**
 * 输入框里的一条消息，从发出到服务端收下。写进 socket 不算发出去：服务端可能拒（比如到了每日额度），
 * 连接也可能在回话之前断掉。没收下就把字和引用放回输入框，原因写在输入框上面。
 */
export type Sent = { readonly id: string; readonly draft: string; readonly quote: string | null };

export type Outbox =
  | { readonly status: "idle" }
  | { readonly status: "sending"; readonly sent: Sent }
  | { readonly status: "failed"; readonly sent: Sent; readonly error: string };

export const IDLE: Outbox = { status: "idle" };

/**
 * 开始发一条；还在等上一条的回话时不发。重发没改过的那条沿用它的 id：id 也是 pi 的 operationId，
 * 连接断在回话之前、其实已经收下的那条，重发不会多出一条。
 */
export function begin(
  outbox: Outbox,
  draft: string,
  quote: string | null,
  newId: () => string
): Extract<Outbox, { status: "sending" }> | null {
  if (outbox.status === "sending") return null;
  const same = outbox.status === "failed" && outbox.sent.draft === draft && outbox.sent.quote === quote;
  return { status: "sending", sent: { id: same ? outbox.sent.id : newId(), draft, quote } };
}

/** 服务端回话了（`error` 是 null 就是收下了），或者连接断了。只认正在等的那条。 */
export function settle(outbox: Outbox, id: string, error: string | null): Outbox {
  if (outbox.status !== "sending" || outbox.sent.id !== id) return outbox;
  return error === null ? IDLE : { status: "failed", sent: outbox.sent, error };
}

/** 没发出去的字放回输入框。等回话时又打了字，接在原来那条后面。 */
export function restoreDraft(current: string, sent: Sent): string {
  return current.trim() ? `${sent.draft}\n${current}` : sent.draft;
}
