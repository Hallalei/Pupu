import { Button } from "@heroui/react";
import { useEffect, useRef, type RefObject } from "react";
import { ArrowUpIcon, StopIcon } from "./icons";

/** 输入栏最多长到这么高，再多就在框里滚。 */
const MAX_HEIGHT = 160;

/**
 * 底部的输入栏：玻璃胶囊，高 44，随行数长到 160。三个 tab 共用。
 * 手机上回车换行、点按钮发送；电脑上回车发送，Shift+回车换行。输入法选词时不发送。
 */
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  canSend,
  sendLabel = "发送",
  onStop,
  onEscape,
  inputRef
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  canSend: boolean;
  sendLabel?: string;
  /** 有它就把发送换成停止。 */
  onStop?: () => void;
  onEscape?: () => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? own;

  // 字变了、宽度变了都重新量：页面在没显示出来时挂上，量到的宽度是 0，会撑到最高。
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const fit = () => {
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
      node.style.overflowY = node.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
    };
    fit();
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [value, ref]);

  return (
    <form
      className="glass flex min-h-11 items-end gap-2 rounded-composer p-1 pl-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <textarea
        ref={ref}
        value={value}
        rows={1}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && onEscape) {
            onEscape();
            return;
          }
          const touch = window.matchMedia("(pointer: coarse)").matches;
          if (event.key === "Enter" && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSend();
          }
        }}
        className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-[7px] text-body text-foreground outline-none placeholder:text-muted"
      />
      {onStop ? (
        <Button
          isIconOnly
          aria-label="停止"
          onPress={onStop}
          className="size-9 min-w-9 rounded-full bg-foreground text-background"
        >
          <StopIcon />
        </Button>
      ) : (
        <Button
          isIconOnly
          type="submit"
          aria-label={sendLabel}
          isDisabled={!canSend}
          className="size-9 min-w-9 rounded-full bg-foreground text-base text-background"
        >
          <ArrowUpIcon />
        </Button>
      )}
    </form>
  );
}
