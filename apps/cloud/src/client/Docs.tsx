import { Input, Label, Modal, Spinner, Switch, TextArea } from "@heroui/react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { looksLikePage, PAGE_SANDBOX, type DocMeta } from "../docs";
import type { DocPlace, DocView, DocsView } from "../server";
import { api } from "./api";
import { ChevronDownIcon, ChevronLeftIcon, CodeIcon, FileIcon, PlusIcon, TrashIcon } from "./icons";
import { PILL_ACTION, PILL_SECONDARY } from "./settings-ui";
import { BuildingIcon, SpaceMark } from "./Spaces";

/** 列表打不开时上传只能放组织层。 */
const ORG_ONLY: readonly DocPlace[] = [{ id: null, name: "组织" }];

/** 返回和删除：control-sm 的圆（手机 36，电脑 28），surface-inset 底。 */
const ROUND = "tap grid size-control-sm shrink-0 place-items-center rounded-full bg-surface-inset text-body";

/** 弹窗里的小胶囊（「选文件」「放在哪」）：surface-inset 底，高 32，subheadline。 */
const SMALL_PILL = "tap inline-flex h-8 shrink-0 items-center rounded-full bg-surface-inset text-subheadline text-ink";

/**
 * Artifacts（规范 Docs）：文字、skill 和页面，组织层和看得到的空间里的，按地方分组。点开读正文，页面在沙箱 iframe 里跑。
 * 上传放文字或一页 HTML，图片和多文件的页面以后再说。画在会话卡片上，内容列居中、最宽 column-max；窗框是 canvas（不属于哪个空间）。
 */
export function Docs({ version, open, onOpen }: { version: unknown; open: string | undefined; onOpen: (id: string | undefined) => void }) {
  const [view, setView] = useState<DocsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const load = useCallback(() => {
    api.docs().then(
      (value) => {
        setView(value);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))
    );
  }, []);
  // 空间变了（拉人、移人、改密级）看得到的也跟着变，重新拿一次。
  useEffect(load, [load, version]);

  if (open) {
    return (
      <DocPage
        id={open}
        onBack={() => onOpen(undefined)}
        onDeleted={() => {
          load();
          onOpen(undefined);
        }}
      />
    );
  }
  const groups = view
    ? view.places
        .map((place) => ({
          place,
          docs: view.docs.filter((doc) => doc.spaceId === place.id)
        }))
        .filter((group) => group.docs.length > 0)
    : [];
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-column flex-col gap-5 px-4 pb-6">
        <div className="flex justify-end">
          <button type="button" onClick={() => setUploading(true)} className={PILL_SECONDARY}>
            <PlusIcon className="text-[16px]" />
            上传
          </button>
        </div>
        {!view && (error ? <p className="m-0 px-1 text-subheadline text-danger-ink">{error}</p> : <ListSkeleton />)}
        {view && groups.length === 0 && (
          <div className="flex flex-col items-center gap-2 pt-12 text-center">
            <p className="m-0 text-message text-ink">还没有 Artifacts</p>
            <p className="m-0 max-w-90 text-subheadline text-ink-muted">
              组织和你看得到的空间里的文字、skill 和页面会列在这里。让 Pupu 在聊天里记下来，或者点「上传」放一份文字或一页 HTML。
            </p>
          </div>
        )}
        {groups.map(({ place, docs }) => (
          <section key={place.id ?? "org"} aria-label={place.name} className="flex flex-col gap-1">
            <h2 className="m-0 flex items-center gap-2 px-1 text-footnote text-ink-muted">
              {place.id === null ? <BuildingIcon aria-hidden="true" className="shrink-0 text-[20px]" /> : <SpaceMark space={place} />}
              <span className="truncate">{place.name}</span>
            </h2>
            <div className="flex flex-col overflow-hidden rounded-row bg-surface-inset">
              {docs.map((doc, index) => (
                <Fragment key={doc.id}>
                  {index > 0 && <Separator />}
                  <DocRow doc={doc} onOpen={() => onOpen(doc.id)} />
                </Fragment>
              ))}
            </div>
          </section>
        ))}
      </div>
      <Upload
        isOpen={uploading}
        onOpenChange={setUploading}
        places={view?.places ?? ORG_ONLY}
        onDone={(meta) => {
          load();
          onOpen(meta.id);
        }}
      />
    </div>
  );
}

/** 行之间 1pt 的线，从图标后面画起：左边距 16 + 图标 18 + 间隔 12。 */
function Separator() {
  return <div aria-hidden="true" className="ml-11.5 h-px shrink-0 bg-line" />;
}

function DocRow({ doc, onOpen }: { doc: DocMeta; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="tap flex min-h-13 w-full items-center gap-3 px-4 py-2.5 text-left pointer-fine:hover:bg-line"
    >
      {doc.kind === "page" ? (
        <CodeIcon className="shrink-0 text-[18px] text-ink-muted" />
      ) : (
        <FileIcon className="shrink-0 text-[18px] text-ink-muted" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body font-medium text-ink">{doc.title}</span>
          {doc.kind === "skill" && <span className="shrink-0 rounded-full bg-surface px-2 text-caption text-ink-muted">skill</span>}
        </span>
        {doc.summary && <span className="truncate text-subheadline text-ink-muted">{doc.summary}</span>}
      </span>
    </button>
  );
}

/** 第一次打开先画骨架，不放转圈：一个组标题、一组三行。 */
function ListSkeleton() {
  return (
    <div role="status" aria-label="正在打开" className="flex flex-col gap-1">
      <span aria-hidden="true" className="mx-1 my-0.5 h-3.5 w-16 rounded-full bg-surface-inset" />
      <div aria-hidden="true" className="flex flex-col overflow-hidden rounded-row bg-surface-inset">
        {[0.4, 0.55, 0.3].map((width, index) => (
          <Fragment key={width}>
            {index > 0 && <Separator />}
            <div className="flex min-h-13 items-center gap-3 px-4 py-2.5">
              <span className="size-4.5 shrink-0 rounded-[5px] bg-line" />
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

/** 确认框里的「删掉」：和「取消」一样的次要胶囊，字用 danger-ink（README：danger 不做按钮底）。 */
const PILL_DESTRUCTIVE =
  "tap inline-flex h-control shrink-0 items-center justify-center gap-1.5 rounded-full bg-surface-inset px-4 text-body font-semibold text-danger-ink";

/**
 * 删之前先问一句（规范 Docs「删除」）：字和 iOS 的 UIAlertController 一样。浏览器自带的确认框改不了按钮上的字，
 * 所以用 App 里的居中弹窗，照「新空间」弹窗的样子排。
 */
function ConfirmDelete({
  title,
  isOpen,
  onOpenChange,
  onConfirm
}: {
  title: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container placement="center">
          <Modal.Dialog className="layer-dialog w-[min(92vw,420px)] max-w-none gap-3 p-4">
            <Modal.Heading className="m-0 px-1 pt-1 text-title break-words text-ink">删掉「{title}」？</Modal.Heading>
            <p className="m-0 px-1 text-subheadline text-ink-muted">组织里的人都看不到了，删了找不回来。</p>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => onOpenChange(false)} className={`${PILL_SECONDARY} flex-1`}>
                取消
              </button>
              <button type="button" onClick={onConfirm} className={`${PILL_DESTRUCTIVE} flex-1`}>
                删掉
              </button>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** 正文页：返回、标题、说明、正文。正文是 Markdown，直接写在卡片上，不再套面板。删除先问一句。 */
function DocPage({ id, onBack, onDeleted }: { id: string; onBack: () => void; onDeleted: () => void }) {
  const [doc, setDoc] = useState<DocView | null | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDoc(undefined);
    setError(null);
    api.doc(id).then(setDoc, () => setDoc(null));
  }, [id]);

  async function remove() {
    setAsking(false);
    setDeleting(true);
    setError(null);
    try {
      await api.deleteDoc(id);
      onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDeleting(false);
    }
  }

  const bar = (
    <>
      <div className="flex items-center justify-between gap-3">
        <button type="button" aria-label="回到 Artifacts" onClick={onBack} className={`${ROUND} text-ink`}>
          <ChevronLeftIcon />
        </button>
        {doc?.kind === "page" && <h1 className="m-0 min-w-0 flex-1 truncate text-headline text-ink">{doc.title}</h1>}
        {doc?.mayDelete && (
          <button
            type="button"
            aria-label="删除"
            aria-disabled={deleting || undefined}
            onClick={() => !deleting && setAsking(true)}
            className={`${ROUND} text-danger-ink`}
          >
            {deleting ? <Spinner size="sm" color="current" aria-label="正在删除" className="size-3.5" /> : <TrashIcon />}
          </button>
        )}
      </div>
      {doc?.mayDelete && <ConfirmDelete title={doc.title} isOpen={asking} onOpenChange={setAsking} onConfirm={() => void remove()} />}
    </>
  );

  // 页面占满卡片，标题写在返回键旁边。
  if (doc?.kind === "page") {
    return (
      <div className="flex h-full flex-col gap-3 px-4 pb-4">
        {bar}
        {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
        <PageFrame title={doc.title} html={doc.body} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <article className="mx-auto flex max-w-column flex-col gap-3 px-4 pb-6 text-ink">
        {bar}
        {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
        {doc === undefined && <PageSkeleton />}
        {doc === null && <p className="m-0 text-message text-ink">没有这一份</p>}
        {doc && (
          <div className="flex flex-col gap-2">
            <h1 className="m-0 text-title text-ink">{doc.title}</h1>
            {doc.summary && <p className="m-0 text-subheadline text-ink-muted">{doc.summary}</p>}
            <Streamdown className="sd-theme text-message" controls={false}>
              {doc.body}
            </Streamdown>
          </div>
        )}
      </article>
    </div>
  );
}

/**
 * 一页 HTML 放进沙箱 iframe（`PAGE_SANDBOX`）。srcdoc 的页面是不透明源：拿不到 App 的 cookie、存储和 DOM，
 * 往 App 发请求带 Origin: null，云端不认。白底，和 Claude 的 Artifacts 一样，页面自己管深色。
 * 规范没画：画框圆角 radius-row，白卡片上靠 1pt line 外圈认出边。
 */
function PageFrame({ title, html }: { title: string; html: string }) {
  return (
    <iframe
      title={title}
      srcDoc={html}
      sandbox={PAGE_SANDBOX}
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 rounded-row bg-white ring-1 ring-line"
    />
  );
}

/** 页面的标题：<title> 里的。 */
function pageTitle(html: string): string {
  return /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
}

function PageSkeleton() {
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
 * 上传（规范 Docs「上传」）：居中弹窗，宽 520，窄屏占 92%。从上到下各项隔 12：标题、说明、正文、选文件和放在哪、skill 开关，
 * 最下面「取消」「上传」并排等宽。选一个 .md / .txt / .html，或者直接贴进来；贴的是一整页 HTML 就存成页面，skill 开关换成一句话。
 */
function Upload({
  isOpen,
  onOpenChange,
  places,
  onDone
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  places: readonly DocPlace[];
  onDone: (meta: DocMeta) => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [place, setPlace] = useState("org");
  const [skill, setSkill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  // 同一次上传点两下、网络重试，云端按它去重。
  const operation = useRef(crypto.randomUUID());
  const ready = title.trim() !== "" && body.trim() !== "";

  async function pick(chosen: File | undefined) {
    if (!chosen) return;
    const text = await chosen.text();
    setBody(text);
    if (!title.trim()) setTitle((looksLikePage(text) && pageTitle(text)) || chosen.name.replace(/\.(md|markdown|txt|html?)$/i, ""));
  }
  const page = looksLikePage(body);

  async function save() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const meta = await api.uploadDoc({
        title: title.trim(),
        summary: summary.trim(),
        body,
        kind: page ? "page" : skill ? "skill" : "doc",
        spaceId: place === "org" ? null : place,
        operation: operation.current
      });
      operation.current = crypto.randomUUID();
      setTitle("");
      setSummary("");
      setBody("");
      setSkill(false);
      onOpenChange(false);
      onDone(meta);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Modal.Container placement="center">
          <Modal.Dialog className="layer-dialog w-[min(92vw,520px)] max-w-none gap-3 p-4">
            <Modal.Heading className="m-0 px-1 pt-1 text-title text-ink">上传</Modal.Heading>
            <Input aria-label="标题" placeholder="标题" value={title} onChange={(event) => setTitle(event.target.value)} />
            <Input
              aria-label="一句说明"
              placeholder={skill && !page ? "什么时候用它" : "一句说明（选填）"}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
            <TextArea
              aria-label="正文"
              placeholder="贴进正文，或者一整页 HTML"
              rows={8}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => file.current?.click()} className={`${SMALL_PILL} px-3`}>
                选文件
              </button>
              <input
                ref={file}
                type="file"
                accept=".md,.markdown,.txt,.html,.htm,text/plain,text/markdown,text/html"
                className="hidden"
                onChange={(event) => void pick(event.target.files?.[0])}
              />
              <span className="relative ml-auto">
                <select
                  aria-label="放在哪"
                  value={place}
                  onChange={(event) => setPlace(event.target.value)}
                  className={`${SMALL_PILL} appearance-none py-0 pr-7 pl-3`}
                >
                  {places.map((item) => (
                    <option key={item.id ?? "org"} value={item.id ?? "org"}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[11px] text-ink-muted" />
              </span>
            </div>
            {page ? (
              <p className="m-0 px-1 text-subheadline text-ink-muted">是一页 HTML，存成页面</p>
            ) : (
              <Switch isSelected={skill} onChange={setSkill} className="flex w-full px-1">
                <Switch.Content className="flex w-full items-center gap-3">
                  <Label className="min-w-0 flex-1 text-body font-normal">是做事的方法（skill）</Label>
                  <Switch.Control className="shrink-0">
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            )}
            {error && <p className="m-0 px-1 text-subheadline text-danger-ink">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => onOpenChange(false)} className={`${PILL_SECONDARY} flex-1`}>
                取消
              </button>
              <button
                type="button"
                disabled={!ready}
                aria-disabled={busy || undefined}
                onClick={() => void save()}
                className={`${PILL_ACTION} flex-1 ${busy ? "pointer-events-none" : ""}`}
              >
                {busy && <Spinner size="sm" color="current" aria-label="正在上传" className="size-3.5" />}
                上传
              </button>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
