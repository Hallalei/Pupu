import { Button } from "@heroui/react";
import { useEffect, useRef, type RefObject } from "react";
import { ArrowUpIcon, StopIcon } from "./icons";

/** 输入栏最多长到这么高，再多就在框里滚。 */
const MAX_HEIGHT = 160;

/**
 * 会话卡片底部的输入栏（Composer）：surface-inset 实色胶囊，高 control，随行数长到 160，再多在框里滚。
 * 按钮是 control-sm 的圆，离上、下、右各 4；没字时 action-off 底、ink-faint 图标。
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
      className="bg-surface-inset flex min-h-control items-end gap-2 rounded-composer p-1 pl-4"
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
        className="max-h-40 min-h-control-sm flex-1 resize-none bg-transparent py-[7px] text-body text-ink outline-none placeholder:text-ink-muted pointer-fine:py-[3px]"
      />
      {onStop ? (
        <Button
          isIconOnly
          aria-label="停止"
          onPress={onStop}
          className="tap size-control-sm min-w-control-sm rounded-full bg-action text-on-action"
        >
          <StopIcon />
        </Button>
      ) : (
        <Button
          isIconOnly
          type="submit"
          aria-label={sendLabel}
          isDisabled={!canSend}
          className="tap size-control-sm min-w-control-sm rounded-full bg-action text-[16px] text-on-action disabled:bg-action-off disabled:text-ink-faint disabled:opacity-100"
        >
          <ArrowUpIcon />
        </Button>
      )}
    </form>
  );
}
