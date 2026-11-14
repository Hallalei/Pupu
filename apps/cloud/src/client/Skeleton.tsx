import { Fragment } from "react";

/*
 * 骨架（规范 Skeleton）：会话、列表和正文第一次打开、手上还什么都没有时，在内容的位置先画几根不动的圆角条。
 * 不加闪光，宽度写死；拿到过一次内容以后不再换回骨架，那是用的人的事。整块是一个 `role="status"`，读屏念「正在打开」，条都 `aria-hidden`。
 */

/**
 * 列表：一根组标题条、一组三行。`icons` 是 false 时（邀请码、通行密钥）去掉图标位，分隔线从左边 16 画起；
 * 有图标时从图标后面画起（16 + 18 + 12）。
 */
export function ListSkeleton({ icons = true }: { icons?: boolean }) {
  return (
    <div role="status" aria-label="正在打开" className="flex flex-col gap-1">
      <span aria-hidden="true" className="mx-1 my-0.5 h-3.5 w-16 rounded-full bg-surface-inset" />
      <div aria-hidden="true" className="flex flex-col overflow-hidden rounded-row bg-surface-inset">
        {[0.4, 0.55, 0.3].map((width, index) => (
          <Fragment key={width}>
            {index > 0 && <div className={`h-px shrink-0 bg-line ${icons ? "ml-11.5" : "ml-4"}`} />}
            <div className="flex min-h-13 items-center gap-3 px-4 py-2.5">
              {icons && <span className="size-4.5 shrink-0 rounded-[5px] bg-line" />}
              <span className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="h-3 rounded-full bg-line" style={{ width: `${width * 100}%` }} />
                <span className="h-2.5 rounded-full bg-line" style={{ width: `${(width + 0.2) * 100}%` }} />
              </span>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** 正文：标题、说明和三行正文，彼此隔 12。 */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="正在打开" className="flex flex-col gap-3">
      <span aria-hidden="true" className="h-5 w-2/5 rounded-full bg-surface-inset" />
      <span aria-hidden="true" className="h-3.5 w-1/4 rounded-full bg-surface-inset" />
      {[0.92, 0.85, 0.6].map((width) => (
        <span key={width} aria-hidden="true" className="h-4 rounded-full bg-surface-inset" style={{ width: `${width * 100}%` }} />
      ))}
    </div>
  );
}

/**
 * 会话：Pupu 的一段三行回复，靠右一块我的气泡位，再一段两行，彼此隔 12。不画头像、名字和时间。
 * 画在对话列里，左右 16、上面 12 由外面给，和消息开始的地方一样。
 */
export function ChatSkeleton() {
  return (
    <div role="status" aria-label="正在打开" className="flex flex-col gap-3">
      <ChatBar width={92} />
      <ChatBar width={85} />
      <ChatBar width={60} />
      <span aria-hidden="true" className="h-11 w-1/2 self-end rounded-bubble bg-surface-inset" />
      <ChatBar width={92} />
      <ChatBar width={70} />
    </div>
  );
}

function ChatBar({ width }: { width: number }) {
  return <span aria-hidden="true" className="h-4 rounded-full bg-surface-inset" style={{ width: `${width}%` }} />;
}
