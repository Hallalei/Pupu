import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktop } from "./desktop";
import { CollapseIcon } from "./icons";

/**
 * 电脑 App 里人来接手 Pupu 浏览器（登录、验证码）的放大视图，学的是 Hark：盖住对话区，中间是真实页面，人直接点、直接输。
 * 页面本身是电脑 App 挂上来的 WebContentsView（原生的，压在所有网页内容上面），这里只画一个占位框告诉它放哪儿，
 * 按钮都放在占位框外面。收起时页面回到后台，任务接着做。网页和手机上没有这个，放大看的是实时画面。
 */

/** 正在做浏览器任务的那段对话登记的「取消任务」。只有一段对话在跑浏览器任务时才有。 */
let cancelTask: (() => void) | null = null;
const cancelListeners = new Set<() => void>();

/** 对话里有正在做的浏览器任务时登记取消的办法，返回撤销登记的函数。 */
export function offerBrowserCancel(cancel: () => void): () => void {
  cancelTask = cancel;
  cancelListeners.forEach((listener) => listener());
  return () => {
    if (cancelTask !== cancel) return;
    cancelTask = null;
    cancelListeners.forEach((listener) => listener());
  };
}

function useCancel(): (() => void) | null {
  const [cancel, setCancel] = useState(() => cancelTask);
  useEffect(() => {
    const update = () => setCancel(() => cancelTask);
    cancelListeners.add(update);
    update();
    return () => {
      cancelListeners.delete(update);
    };
  }, []);
  return cancel;
}

export function BrowserTakeover() {
  const [open, setOpen] = useState(false);
  const cancel = useCancel();

  useEffect(() => {
    const app = desktop();
    if (!app?.browserTakeover || !app.onBrowserTakeover) return;
    let alive = true;
    const off = app.onBrowserTakeover((value) => setOpen(value));
    void app.browserTakeover().then((value) => {
      if (alive) setOpen(value);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!open) return null;
  return <TakeoverView cancel={cancel} />;
}

function TakeoverView({ cancel }: { cancel: (() => void) | null }) {
  const slot = useRef<HTMLDivElement>(null);
  const close = () => void desktop()?.detachBrowser?.();

  // 占位框在哪、多大，告诉电脑 App；窗口一变就再说一次。
  useLayoutEffect(() => {
    const node = slot.current;
    const app = desktop();
    if (!node || !app?.attachBrowser) return;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        void app.attachBrowser?.({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }).catch(() => undefined);
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      role="dialog"
      aria-label="在电脑上接手"
      data-browser-takeover
      className="fixed inset-0 z-[60] flex flex-col gap-3 bg-black/40 p-4 pt-12 backdrop-blur-xl"
    >
      <div ref={slot} data-browser-slot className="min-h-0 flex-1 overflow-hidden rounded-bubble bg-white shadow-2xl" />
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button type="button" aria-label="收起" onClick={close} className="glass tap grid size-10 place-items-center rounded-full">
          <CollapseIcon />
        </button>
        {cancel && (
          <button
            type="button"
            onClick={() => {
              cancel();
              close();
            }}
            className="glass tap h-10 rounded-full px-4 text-subheadline"
          >
            取消任务
          </button>
        )}
      </div>
    </div>
  );
}
