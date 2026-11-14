import { Modal } from "@heroui/react";
import type { ReactNode } from "react";
import { CloseIcon } from "./icons";
import { useWide } from "./layout";

/**
 * 浮层（规范三层结构的第三层）：手机布局是底部 sheet，离屏幕边 6，上角 32、下角 41，顶上一个把手；
 * 宽屏是居中的弹窗，圆角 12。底是 surface-sheet，背后压 scrim，不模糊。
 * 焦点留在里面、Esc 和点背后关闭，都是 HeroUI Modal 自带的。
 */
export function Sheet({
  isOpen,
  onClose,
  label,
  children,
  width = "w-[min(92vw,420px)]"
}: {
  isOpen: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  /** 宽屏弹窗的宽度。 */
  width?: string;
}) {
  const wide = useWide();
  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
        <Modal.Container
          placement={wide ? "center" : "bottom"}
          className={wide ? "" : "w-full p-frame-gap pt-10 sm:w-full sm:p-frame-gap sm:pt-10"}
        >
          <Modal.Dialog aria-label={label} className={`layer-sheet max-w-none gap-0 p-0 ${wide ? width : "w-full"}`}>
            {!wide && <span aria-hidden="true" className="mx-auto mt-2 block h-1.25 w-9 shrink-0 rounded-full bg-ink-faint opacity-60" />}
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** sheet 顶上的关闭：34 的圆，surface-inset 底。 */
export function SheetClose({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="关闭"
      onClick={onClose}
      className="tap grid size-8.5 shrink-0 place-items-center rounded-full bg-surface-inset text-body text-ink pointer-fine:size-control-sm"
    >
      <CloseIcon />
    </button>
  );
}
