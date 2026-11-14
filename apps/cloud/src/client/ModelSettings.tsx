import { Label, Spinner, Switch } from "@heroui/react";
import { useEffect, useState, type ReactNode } from "react";
import type { ComputerView } from "../bridge/protocol";
import type { ModelView } from "../model/settings";
import { api } from "./api";
import { desktop, type LocalModelView } from "./desktop";
import { Dot, Group, PILL_ACTION, computerLabel } from "./settings-ui";

/** 地址、模型名、key、上下文、能不能看图。云端存 key 和电脑上存模型共用。 */
type Fields = { baseUrl: string; model: string; apiKey: string; contextWindow: string; vision: boolean };

const EMPTY: Fields = { baseUrl: "", model: "", apiKey: "", contextWindow: "32000", vision: false };

/** 选项组下面那句：换模型就是把大家的内容改发到别处，谁来看都写着。 */
const SENT_TO = "所有人的消息，包括私聊，都发给这个模型。";

/** 「清除」：透明底、ink-muted，和「移出」一样轻，在「保存」左边。 */
const CLEAR =
  "tap inline-flex h-control min-w-18 shrink-0 items-center justify-center rounded-full px-4 text-body font-semibold text-ink-muted pointer-fine:hover:bg-surface-inset disabled:opacity-50";

/**
 * 表单的输入框直接放在弹窗上（不套进组）：surface-inset 底、radius-field、不描边，框之间 8。
 * 「上下文」一行：「上下文」后面跟 104 宽的数字框，「能看图」和开关靠右。
 */
function ModelFields({
  fields,
  onChange,
  keyKept,
  baseUrlHint
}: {
  fields: Fields;
  onChange: (next: Fields) => void;
  /** 已经存过 key：留空就是不改。 */
  keyKept: boolean;
  baseUrlHint: string;
}) {
  const set = (patch: Partial<Fields>) => onChange({ ...fields, ...patch });
  return (
    <>
      <input
        aria-label="地址"
        placeholder={baseUrlHint}
        value={fields.baseUrl}
        onChange={(event) => set({ baseUrl: event.target.value })}
        className="field w-full"
        autoComplete="off"
        spellCheck={false}
      />
      <input
        aria-label="模型名"
        placeholder="模型名"
        value={fields.model}
        onChange={(event) => set({ model: event.target.value })}
        className="field w-full"
        autoComplete="off"
        spellCheck={false}
      />
      <input
        aria-label="key"
        type="password"
        placeholder={keyKept ? "key 已存，留空不改" : "key"}
        value={fields.apiKey}
        onChange={(event) => set({ apiKey: event.target.value })}
        className="field w-full"
        autoComplete="off"
      />
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-body text-ink-muted">上下文</span>
        <input
          aria-label="上下文长度"
          inputMode="numeric"
          value={fields.contextWindow}
          onChange={(event) => set({ contextWindow: event.target.value.replace(/[^\d]/g, "") })}
          className="field w-26"
        />
        <span className="flex-1" />
        <Switch isSelected={fields.vision} onChange={(vision) => set({ vision })}>
          <Switch.Content className="flex items-center gap-2">
            <Label className="text-body font-normal">能看图</Label>
            <Switch.Control className="shrink-0">
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </div>
    </>
  );
}

/** 「保存」：先试再存，试的时候按钮里转圈（最多 45 秒），不另设「测试」。 */
function SaveButton({ sending }: { sending: boolean }) {
  return (
    <button
      type="submit"
      aria-disabled={sending || undefined}
      className={`${PILL_ACTION} min-w-18 ${sending ? "pointer-events-none" : ""}`}
    >
      {sending && <Spinner size="sm" color="current" aria-label="正在试" className="size-4" />}
      保存
    </button>
  );
}

/** 表单右下的按钮一行，和上面的框隔 12；出错写在它下面。 */
function FormEnd({ children, error }: { children: ReactNode; error: string | null }) {
  return (
    <>
      <div className="mt-1 flex justify-end gap-2">{children}</div>
      {error && <p className="m-0 px-1 text-subheadline text-danger-ink">{error}</p>}
    </>
  );
}

function payload(fields: Fields) {
  return {
    baseUrl: fields.baseUrl,
    model: fields.model,
    apiKey: fields.apiKey,
    vision: fields.vision,
    contextWindow: Number(fields.contextWindow || 0)
  };
}

type Source = "pupu" | "key" | `computer:${string}`;

function sourceOf(view: ModelView): Source {
  return view.source === "computer" ? `computer:${view.computerId}` : view.source;
}

type Option = { readonly source: Source; readonly label: string; readonly detail: ReactNode };

/**
 * 设置里「模型」那一页（规范 ModelSettings）：这个 Pupu 用哪个模型。大家都看得到用的是哪个，只有创建者能换。
 * 列出来的电脑是在线、报了模型的那几台，加上正在用的那台（它可能离线了、或者没设模型）。
 * 点「Pupu 自带」或一台电脑马上就换；点「自己的 key」只展开表单，「保存」先试再存。
 */
export function ModelSection({
  model,
  computers,
  onSaved
}: {
  model: { readonly current: ModelView; readonly mayEdit: boolean };
  computers: readonly ComputerView[];
  onSaved: () => Promise<void>;
}) {
  const current = model.current;
  const mayEdit = model.mayEdit;
  const [picked, setPicked] = useState<Source>(sourceOf(current));
  const [fields, setFields] = useState<Fields>(
    current.source === "key"
      ? { ...EMPTY, baseUrl: "", model: current.model, contextWindow: String(current.contextWindow), vision: current.vision }
      : EMPTY
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 每 5 秒拉一次 state，对象会换；按来源比，不然填到一半的表单会被收起来。
  const currentSource = sourceOf(current);
  useEffect(() => setPicked(currentSource), [currentSource]);

  const relays = computers.filter(
    (computer) => computer.model || (current.source === "computer" && current.computerId === computer.id)
  );

  async function save(choice: unknown) {
    setSending(true);
    setError(null);
    try {
      await api.setModel(choice);
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  function pick(source: Source) {
    if (!mayEdit || sending) return;
    setPicked(source);
    setError(null);
    if (source === "pupu" && current.source !== "pupu") void save({ source: "pupu" });
    if (source.startsWith("computer:")) {
      const computerId = source.slice("computer:".length);
      if (current.source !== "computer" || current.computerId !== computerId) {
        void save({ source: "computer", computerId, fallback: false });
      }
    }
  }

  const options: Option[] = [
    { source: "pupu", label: "Pupu 自带", detail: null },
    ...relays.map(
      (computer): Option => ({
        source: `computer:${computer.id}`,
        // 离线的报不上模型名，只写电脑名，下面写离线多久了。
        label: computer.online && computer.model ? `${computer.name} · ${computer.model.name}` : computer.name,
        detail: !computer.online ? (
          <>
            <Dot online={false} />
            {computerLabel(computer)}
          </>
        ) : computer.model ? null : (
          "这台电脑上没设模型"
        )
      })
    ),
    {
      source: "key",
      label: current.source === "key" ? `自己的 key · ${current.model}` : "自己的 key",
      detail: current.source === "key" ? current.host : null
    }
  ];

  const formOpen = mayEdit && picked === "key";
  const fallbackOpen = mayEdit && current.source === "computer" && picked === currentSource;

  return (
    <>
      <Group
        radiogroup
        label="用哪个模型"
        readOnly={!mayEdit}
        inset="radio"
        note={mayEdit ? SENT_TO : `${SENT_TO}只有创建者能换。`}
        error={formOpen || fallbackOpen ? null : error}
      >
        {options.map((option) => {
          const selected = picked === option.source;
          return (
            <label
              key={option.source}
              className={`flex min-h-11 items-center gap-3 px-4 py-2.5 ${mayEdit && !sending ? "cursor-pointer pointer-fine:hover:bg-line" : ""}`}
            >
              {/* 不是创建者：选中的照常画，没选的圈 30% 透明；用 aria-disabled 不用 disabled，免得整行变灰。 */}
              <input
                type="radio"
                name="model-source"
                value={option.source}
                checked={selected}
                onChange={() => pick(option.source)}
                disabled={mayEdit && sending}
                aria-disabled={mayEdit ? undefined : true}
                tabIndex={mayEdit ? undefined : -1}
                className={`m-0 size-5 shrink-0 pointer-fine:size-4 ${!mayEdit && !selected ? "opacity-30" : ""}`}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body">{option.label}</span>
                {option.detail && (
                  <span className="flex min-w-0 items-center gap-1.5 text-subheadline text-ink-muted">{option.detail}</span>
                )}
              </span>
            </label>
          );
        })}
      </Group>
      {fallbackOpen && current.source === "computer" && (
        <Group label="电脑离线时" error={error}>
          <Switch
            key="fallback"
            isSelected={current.fallback}
            isDisabled={sending}
            onChange={(fallback) => void save({ ...current, fallback })}
            className="flex min-h-11 w-full items-center px-4 py-2.5"
          >
            <Switch.Content className="flex w-full items-center gap-3">
              <Label className="min-w-0 flex-1 text-body font-normal">电脑离线时用 Pupu 自带的</Label>
              <Switch.Control className="shrink-0">
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        </Group>
      )}
      {formOpen && (
        <form
          aria-label="自己的 key"
          className="flex shrink-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!sending) void save({ source: "key", ...payload(fields) });
          }}
        >
          <ModelFields
            fields={fields}
            onChange={setFields}
            keyKept={current.source === "key"}
            baseUrlHint={current.source === "key" ? `https://${current.host}/…` : "https://api.example.com/v1"}
          />
          <FormEnd error={error}>
            <SaveButton sending={sending} />
          </FormEnd>
        </form>
      )}
    </>
  );
}

/** 设置首页「模型」那一行右边的字。 */
export function modelSummary(current: ModelView, computers: readonly ComputerView[]): string {
  if (current.source === "pupu") return "Pupu 自带";
  if (current.source === "key") return current.model;
  const computer = computers.find((item) => item.id === current.computerId);
  return computer?.model?.name ?? computer?.name ?? "电脑上的";
}

/**
 * 只在电脑 App 里：「这台电脑」那一页最下面，这台电脑上的模型。地址和 key 交给 App 加密存在本机，不经过云端。
 * 老的 App 没有这个接口，不显示。
 */
export function LocalModelForm() {
  const app = desktop();
  const [saved, setSaved] = useState<LocalModelView | null | undefined>(undefined);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!app?.localModel) return;
    void app.localModel().then((view) => {
      setSaved(view);
      if (view) {
        setFields({
          baseUrl: view.baseUrl,
          model: view.model,
          apiKey: "",
          contextWindow: String(view.contextWindow),
          vision: view.vision
        });
      }
    });
  }, [app]);

  if (!app?.localModel || !app.setLocalModel || saved === undefined) return null;
  const setLocalModel = app.setLocalModel;
  const localModel = app.localModel;

  async function save(input: Parameters<typeof setLocalModel>[0]) {
    setSending(true);
    setError(null);
    try {
      const result = await setLocalModel(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const view = await localModel();
      setSaved(view);
      if (!view) setFields(EMPTY);
      else setFields((current) => ({ ...current, apiKey: "" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="flex shrink-0 flex-col gap-2 not-first:mt-1.5">
      <h3 className="m-0 px-1 text-footnote text-ink-muted">这台电脑上的模型</h3>
      <form
        aria-label="这台电脑上的模型"
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!sending) void save(payload(fields));
        }}
      >
        <ModelFields
          fields={fields}
          onChange={setFields}
          keyKept={saved?.hasKey === true}
          baseUrlHint="http://localhost:11434/v1"
        />
        <FormEnd error={error}>
          {saved && (
            <button type="button" disabled={sending} onClick={() => void save(null)} className={CLEAR}>
              清除
            </button>
          )}
          <SaveButton sending={sending} />
        </FormEnd>
      </form>
      <p className="m-0 px-1 text-footnote text-ink-muted">存好以后，创建者能让整个 Pupu 用它。</p>
    </section>
  );
}
