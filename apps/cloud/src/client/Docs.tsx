import { Input, Label, Modal, Spinner, Switch, TextArea } from "@heroui/react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { DocMeta } from "../docs";
import type { DocPlace, DocView, DocsView } from "../server";
import { api } from "./api";
import { ChevronDownIcon, ChevronLeftIcon, FileIcon, PlusIcon, TrashIcon } from "./icons";
import { PILL_ACTION, PILL_SECONDARY } from "./settings-ui";
import { BuildingIcon, SpaceMark } from "./Spaces";

/** 列表打不开时上传只能放组织层。 */
const ORG_ONLY: readonly DocPlace[] = [{ id: null, name: "组织" }];

/** 返回和删除：control-sm 的圆（手机 36，电脑 28），surface-inset 底。 */
const ROUND = "tap grid size-control-sm shrink-0 place-items-center rounded-full bg-surface-inset text-body";

/** 弹窗里的小胶囊（「选文件」「放在哪」）：surface-inset 底，高 32，subheadline。 */
const SMALL_PILL = "tap inline-flex h-8 shrink-0 items-center rounded-full bg-surface-inset text-subheadline text-ink";

/**
 * 资料（规范 Docs）：组织层和看得到的空间里的，按地方分组。点开读正文；上传放文字。图片和设计稿以后再说。
 * 画在会话卡片上，内容列居中、最宽 column-max；窗框是 canvas（资料不属于哪个空间）。
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
            <p className="m-0 text-message text-ink">还没有资料</p>
            <p className="m-0 max-w-90 text-subheadline text-ink-muted">
              组织和你看得到的空间里的资料会列在这里。让 Pupu 在聊天里记下来，或者点「上传」放一份文字。
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
      <FileIcon className="shrink-0 text-[18px] text-ink-muted" />
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

/** 正文页：返回、标题、说明、正文。正文是 Markdown，直接写在卡片上，不再套面板。 */
function DocPage({ id, onBack, onDeleted }: { id: string; onBack: () => void; onDeleted: () => void }) {
  const [doc, setDoc] = useState<DocView | null | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDoc(undefined);
    setError(null);
    api.doc(id).then(setDoc, () => setDoc(null));
  }, [id]);

  async function remove() {
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

  return (
    <div className="h-full overflow-y-auto">
      <article className="mx-auto flex max-w-column flex-col gap-3 px-4 pb-6 text-ink">
        <div className="flex items-center justify-between">
          <button type="button" aria-label="回到资料" onClick={onBack} className={`${ROUND} text-ink`}>
            <ChevronLeftIcon />
          </button>
          {doc?.mayDelete && (
            <button
              type="button"
              aria-label="删除"
              aria-disabled={deleting || undefined}
              onClick={() => !deleting && void remove()}
              className={`${ROUND} text-danger-ink`}
            >
              {deleting ? <Spinner size="sm" color="current" aria-label="正在删除" className="size-3.5" /> : <TrashIcon />}
            </button>
          )}
        </div>
        {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
        {doc === undefined && <PageSkeleton />}
        {doc === null && <p className="m-0 text-message text-ink">没有这份资料</p>}
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
 * 最下面「取消」「上传」并排等宽。文字类：选一个 .md / .txt，或者直接贴进来。
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
    setBody(await chosen.text());
    if (!title.trim()) setTitle(chosen.name.replace(/\.(md|markdown|txt)$/i, ""));
  }

  async function save() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const meta = await api.uploadDoc({
        title: title.trim(),
        summary: summary.trim(),
        body,
        kind: skill ? "skill" : "doc",
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
            <Modal.Heading className="m-0 px-1 pt-1 text-title text-ink">上传资料</Modal.Heading>
            <Input aria-label="标题" placeholder="标题" value={title} onChange={(event) => setTitle(event.target.value)} />
            <Input
              aria-label="一句说明"
              placeholder={skill ? "什么时候用它" : "一句说明（选填）"}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
            <TextArea aria-label="正文" placeholder="贴进正文" rows={8} value={body} onChange={(event) => setBody(event.target.value)} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => file.current?.click()} className={`${SMALL_PILL} px-3`}>
                选文件
              </button>
              <input
                ref={file}
                type="file"
                accept=".md,.markdown,.txt,text/plain,text/markdown"
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
            <Switch isSelected={skill} onChange={setSkill} className="flex w-full px-1">
              <Switch.Content className="flex w-full items-center gap-3">
                <Label className="min-w-0 flex-1 text-body font-normal">是做事的方法（skill）</Label>
                <Switch.Control className="shrink-0">
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
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
