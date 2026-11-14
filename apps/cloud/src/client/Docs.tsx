import { Button, Input, Label, Modal, Spinner, Switch, TextArea } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { Doc, DocMeta } from "../docs";
import type { DocsView } from "../server";
import { api } from "./api";
import { ChevronDownIcon, ChevronLeftIcon, FileIcon, PlusIcon } from "./icons";

/** 资料：组织层和看得到的空间里的，按地方分组。点开读正文；上传放文字。图片和设计稿以后再说。 */
export function Docs({ version, open, onOpen }: { version: unknown; open: string | undefined; onOpen: (id: string | undefined) => void }) {
  const [view, setView] = useState<DocsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const load = useCallback(() => {
    api.docs().then(setView, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  // 空间变了（拉人、移人、改密级）看得到的也跟着变，重新拿一次。
  useEffect(load, [load, version]);

  if (open) return <DocPage id={open} onBack={() => onOpen(undefined)} />;
  if (!view) {
    return (
      <div className="grid h-full place-items-center">
        {error ? <div className="text-message text-danger-ink">{error}</div> : <Spinner size="sm" aria-label="正在打开" />}
      </div>
    );
  }
  const groups = view.places
    .map((place) => ({ place, docs: view.docs.filter((doc) => doc.spaceId === place.id) }))
    .filter((group) => group.docs.length > 0);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 pb-10">
        <div className="flex justify-end">
          <Button
            variant="ghost"
            onPress={() => setUploading(true)}
            className="glass lift tap h-control rounded-full px-4 text-body font-semibold text-foreground"
          >
            <PlusIcon />
            上传
          </Button>
        </div>
        {groups.length === 0 && <div className="pt-16 text-center text-message text-ink-sky">还没有资料</div>}
        {groups.map(({ place, docs }) => (
          <section key={place.id ?? "org"} className="flex flex-col gap-1">
            <h2 className="px-1 text-footnote font-medium text-muted">{place.name}</h2>
            <div className="strong flex flex-col overflow-hidden rounded-panel">
              {docs.map((doc) => (
                <DocRow key={doc.id} doc={doc} onOpen={() => onOpen(doc.id)} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <Upload
        isOpen={uploading}
        onOpenChange={setUploading}
        places={view.places}
        onDone={(meta) => {
          load();
          onOpen(meta.id);
        }}
      />
    </div>
  );
}

function DocRow({ doc, onOpen }: { doc: DocMeta; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="tap flex min-h-13 w-full items-center gap-3 border-b border-separator px-4 py-2.5 text-left last:border-b-0 hover:bg-foreground/4"
    >
      <FileIcon className="shrink-0 text-[18px] text-muted" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate text-body font-medium text-foreground">{doc.title}</span>
          {doc.kind === "skill" && <span className="shrink-0 rounded-full bg-foreground/8 px-2 text-caption text-muted">skill</span>}
        </span>
        {doc.summary && <span className="truncate text-subheadline text-muted">{doc.summary}</span>}
      </span>
    </button>
  );
}

function DocPage({ id, onBack }: { id: string; onBack: () => void }) {
  const [doc, setDoc] = useState<Doc | null | undefined>(undefined);
  useEffect(() => {
    setDoc(undefined);
    api.doc(id).then(setDoc, () => setDoc(null));
  }, [id]);
  return (
    <div className="h-full overflow-y-auto">
      <article className="mx-auto flex max-w-2xl flex-col gap-3 px-4 pb-10">
        <button
          type="button"
          aria-label="回到资料"
          onClick={onBack}
          className="glass lift tap grid size-bar place-items-center rounded-full text-[20px]"
        >
          <ChevronLeftIcon />
        </button>
        {doc === undefined && <Spinner size="sm" aria-label="正在打开" />}
        {doc === null && <div className="text-message text-ink-sky">没有这份资料</div>}
        {doc && (
          <div className="strong flex flex-col gap-2 rounded-panel px-5 py-4">
            <h1 className="text-title font-semibold text-foreground">{doc.title}</h1>
            {doc.summary && <div className="text-subheadline text-muted">{doc.summary}</div>}
            <Streamdown className="sd-theme text-message" controls={false}>
              {doc.body}
            </Streamdown>
          </div>
        )}
      </article>
    </div>
  );
}

/** 文字类：选一个 .md / .txt，或者直接贴进来。 */
function Upload({
  isOpen,
  onOpenChange,
  places,
  onDone
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  places: DocsView["places"];
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

  async function pick(chosen: File | undefined) {
    if (!chosen) return;
    setBody(await chosen.text());
    if (!title.trim()) setTitle(chosen.name.replace(/\.(md|markdown|txt)$/i, ""));
  }

  async function save() {
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
          <Modal.Dialog className="w-[min(92vw,520px)] rounded-panel">
            <Modal.Header>
              <Modal.Heading className="text-title">上传资料</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              <Input aria-label="标题" placeholder="标题" value={title} onChange={(event) => setTitle(event.target.value)} />
              <Input
                aria-label="一句说明"
                placeholder={skill ? "什么时候用它" : "一句说明（选填）"}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
              <TextArea aria-label="正文" placeholder="贴进正文" rows={8} value={body} onChange={(event) => setBody(event.target.value)} />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="tertiary" onPress={() => file.current?.click()}>
                  选文件
                </Button>
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
                    className="tap h-8 appearance-none rounded-full border border-separator bg-surface py-0 pr-7 pl-3 text-subheadline text-foreground"
                  >
                    {places.map((item) => (
                      <option key={item.id ?? "org"} value={item.id ?? "org"}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[11px] text-muted" />
                </span>
              </div>
              <Switch isSelected={skill} onChange={setSkill}>
                <Switch.Content className="flex w-full items-center gap-3">
                  <Label className="min-w-0 flex-1 text-subheadline">是做事的方法（skill）</Label>
                  <Switch.Control className="shrink-0">
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
              {error && <div className="text-subheadline text-danger-ink">{error}</div>}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary">
                取消
              </Button>
              <Button isPending={busy} isDisabled={!title.trim() || !body.trim()} onPress={() => void save()}>
                上传
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
