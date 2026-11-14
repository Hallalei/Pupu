import { Button, Label, Switch } from "@heroui/react";
import { useEffect, useState } from "react";
import type { ComputerView } from "../bridge/protocol";
import type { ModelView } from "../model/settings";
import { api } from "./api";
import { desktop, type LocalModelView } from "./desktop";
import { CheckIcon } from "./icons";

/** 地址、模型名、key、上下文、能不能看图。云端存 key 和电脑上存模型共用。 */
type Fields = { baseUrl: string; model: string; apiKey: string; contextWindow: string; vision: boolean };

const EMPTY: Fields = { baseUrl: "", model: "", apiKey: "", contextWindow: "32000", vision: false };

const INPUT = "min-w-0 rounded-tag bg-surface-inset px-3 py-1.5 text-subheadline";

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
    <div className="flex flex-col gap-2">
      <input
        aria-label="地址"
        placeholder={baseUrlHint}
        value={fields.baseUrl}
        onChange={(event) => set({ baseUrl: event.target.value })}
        className={INPUT}
        autoComplete="off"
        spellCheck={false}
      />
      <input
        aria-label="模型名"
        placeholder="模型名"
        value={fields.model}
        onChange={(event) => set({ model: event.target.value })}
        className={INPUT}
        autoComplete="off"
        spellCheck={false}
      />
      <input
        aria-label="key"
        type="password"
        placeholder={keyKept ? "key 已存，留空不改" : "key"}
        value={fields.apiKey}
        onChange={(event) => set({ apiKey: event.target.value })}
        className={INPUT}
        autoComplete="off"
      />
      <div className="flex items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-subheadline">
          <span className="shrink-0 text-ink-muted">上下文</span>
          <input
            aria-label="上下文长度"
            inputMode="numeric"
            value={fields.contextWindow}
            onChange={(event) => set({ contextWindow: event.target.value.replace(/[^\d]/g, "") })}
            className={`${INPUT} w-24`}
          />
        </label>
        <label className="flex shrink-0 items-center gap-1.5 text-subheadline">
          <input type="checkbox" checked={fields.vision} onChange={(event) => set({ vision: event.target.checked })} />
          能看图
        </label>
      </div>
    </div>
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

/**
 * 这个 Pupu 用哪个模型。大家都看得到用的是哪种，只有创建者能改。
 * 列出来的电脑是报过本地模型的那几台，加上现在选着的那台（它可能离线了）。
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

  const options: { source: Source; label: string; detail: string | null; disabled: boolean }[] = [
    { source: "pupu", label: "Pupu 自带", detail: null, disabled: false },
    ...relays.map((computer) => ({
      source: `computer:${computer.id}` as Source,
      label: computer.model ? `${computer.name} · ${computer.model.name}` : computer.name,
      detail: computer.online ? (computer.model ? null : "这台电脑上没设模型") : "离线",
      disabled: !computer.model
    })),
    {
      source: "key",
      label: current.source === "key" ? `自己的 key · ${current.model}` : "自己的 key",
      detail: current.source === "key" ? current.host : null,
      disabled: false
    }
  ];

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-2 rounded-row bg-surface px-3 py-3">
        <div role="radiogroup" aria-label="用哪个模型" className="flex flex-col">
          {options.map((option) => {
            const selected = picked === option.source;
            return (
              <button
                key={option.source}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!model.mayEdit || sending || (option.disabled && !selected)}
                onClick={() => pick(option.source)}
                className="flex min-h-control items-center gap-2 rounded-tag px-2 py-1 text-left enabled:hover:bg-ink/6 disabled:cursor-default"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-subheadline font-medium">{option.label}</span>
                  {option.detail && <span className="block truncate text-caption text-ink-muted">{option.detail}</span>}
                </span>
                {selected && <CheckIcon className="shrink-0 text-[14px]" />}
              </button>
            );
          })}
        </div>
        {model.mayEdit && current.source === "computer" && picked === sourceOf(current) && (
          <Switch
            isSelected={current.fallback}
            isDisabled={sending}
            onChange={(fallback) => void save({ ...current, fallback })}
          >
            <Switch.Content className="flex w-full items-center gap-3 px-2">
              <Label className="min-w-0 flex-1 text-subheadline">电脑离线时用 Pupu 自带的</Label>
              <Switch.Control className="shrink-0">
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        )}
        {model.mayEdit && picked === "key" && (
          <form
            className="flex flex-col gap-2 border-t border-line pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void save({ source: "key", ...payload(fields) });
            }}
          >
            <ModelFields
              fields={fields}
              onChange={setFields}
              keyKept={current.source === "key"}
              baseUrlHint={current.source === "key" ? `https://${current.host}/…` : "https://api.example.com/v1"}
            />
            <Button size="sm" type="submit" className="self-end" isPending={sending}>
              试一下并保存
            </Button>
          </form>
        )}
        {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
      </div>
      {!model.mayEdit && <p className="m-0 px-4 text-footnote font-normal text-ink-muted">只有创建者能换。</p>}
    </section>
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
 * 只在电脑 App 里：这台电脑上的模型。地址和 key 交给 App 加密存在本机，不经过云端。
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
    <section className="flex flex-col gap-1.5">
      <h3 className="m-0 px-4 text-footnote text-ink-muted">这台电脑上的模型</h3>
      <form
        className="flex flex-col gap-2 rounded-row bg-surface px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save(payload(fields));
        }}
      >
      <ModelFields
        fields={fields}
        onChange={setFields}
        keyKept={saved?.hasKey === true}
        baseUrlHint="http://localhost:11434/v1"
      />
      <div className="flex justify-end gap-2">
        {saved && (
          <Button size="sm" variant="tertiary" isDisabled={sending} onPress={() => void save(null)}>
            清除
          </Button>
        )}
        <Button size="sm" type="submit" isPending={sending}>
          试一下并保存
        </Button>
      </div>
      {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
      </form>
    </section>
  );
}
