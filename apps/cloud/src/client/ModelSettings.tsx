import { Button, Label, Switch } from "@heroui/react";
import { useEffect, useState } from "react";
import type { ComputerView } from "../bridge/protocol";
import type { MagpieView } from "../server";
import { recognize, templateOf, TEMPLATES, type Template } from "../model/catalog";
import type { ModelList, ModelOption } from "../model/list";
import type { KeyView, ModelView } from "../model/settings";
import { api } from "./api";
import { desktop, type LocalModelView } from "./desktop";
import { CheckIcon, ChevronDownIcon } from "./icons";

/** 地址、模型名、key、上下文、能不能看图。云端存 key 和电脑上存模型共用。 */
type Fields = { baseUrl: string; model: string; apiKey: string; contextWindow: string; vision: boolean };

const EMPTY: Fields = { baseUrl: "", model: "", apiKey: "", contextWindow: "32000", vision: false };

const INPUT = "min-w-0 rounded-tag bg-foreground/6 px-3 py-1.5 text-subheadline";

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
          <span className="shrink-0 text-muted">上下文</span>
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

type Source = "pupu" | "key" | `computer:${string}` | `magpie:${string}`;

function sourceOf(view: ModelView): Source {
  if (view.source !== "computer") return view.source;
  return view.magpie ? `magpie:${view.computerId}` : `computer:${view.computerId}`;
}

type ModelState = {
  readonly current: ModelView;
  readonly mayEdit: boolean;
  readonly own?: KeyView | null;
  readonly keys?: readonly { readonly provider: string; readonly baseUrl: string }[];
  readonly magpie?: readonly MagpieView[];
};

/**
 * 这个 Pupu 用哪个模型。大家都看得到用的是哪种，只有创建者能改。
 * 列出来的电脑是报过本地模型的那几台，加上现在选着的那台（它可能离线了）。
 * 自己电脑上开着 Magpie 的，再多一项 Magpie，选了从它的模型里挑一个（照 Cindy 的做法，见 bridge/magpie.ts）。
 */
export function ModelSection({
  model,
  computers,
  onSaved
}: {
  model: ModelState;
  computers: readonly ComputerView[];
  onSaved: () => Promise<void>;
}) {
  const current = model.current;
  const [picked, setPicked] = useState<Source>(sourceOf(current));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 每 5 秒拉一次 state，对象会换；按来源比，不然填到一半的表单会被收起来。
  const currentSource = sourceOf(current);
  useEffect(() => setPicked(currentSource), [currentSource]);

  const relays = computers.filter(
    (computer) =>
      computer.model || (current.source === "computer" && !current.magpie && current.computerId === computer.id)
  );

  async function save(choice: unknown): Promise<boolean> {
    setSending(true);
    setError(null);
    try {
      await api.setModel(choice);
      await onSaved();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
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
      if (current.source !== "computer" || current.computerId !== computerId || current.magpie) {
        void save({ source: "computer", computerId, fallback: false });
      }
    }
    // Magpie 要先挑模型，挑了才存。
  }

  const nameOf = (computerId: string) => computers.find((computer) => computer.id === computerId)?.name ?? "电脑";
  const magpies = model.magpie ?? [];
  const magpieOptions = magpies.map((each) => {
    const computer = computers.find((item) => item.id === each.computerId);
    const using = current.source === "computer" && current.computerId === each.computerId ? current.magpie : undefined;
    const where = magpies.length > 1 ? ` · ${nameOf(each.computerId)}` : "";
    return {
      source: `magpie:${each.computerId}` as Source,
      label: using ? `Magpie · ${using.name}` : `Magpie${where}`,
      detail: !computer?.online ? "离线" : each.on ? (using && where ? nameOf(each.computerId) : null) : "Magpie 没开",
      disabled: !computer?.online || !each.on
    };
  });
  // 选着 Magpie、但自己看不到清单（别人看，或者电脑被删了）时也要有这一项。
  if (current.source === "computer" && current.magpie && !magpies.some((each) => each.computerId === current.computerId)) {
    magpieOptions.push({
      source: `magpie:${current.computerId}`,
      label: `Magpie · ${current.magpie.name}`,
      detail: nameOf(current.computerId),
      disabled: true
    });
  }
  const pickedMagpie = picked.startsWith("magpie:") ? magpies.find((each) => `magpie:${each.computerId}` === picked) : undefined;

  const own = current.source === "key" ? current : (model.own ?? null);
  const options: { source: Source; label: string; detail: string | null; disabled: boolean }[] = [
    { source: "pupu", label: "Pupu 自带", detail: null, disabled: false },
    ...relays.map((computer) => ({
      source: `computer:${computer.id}` as Source,
      label: computer.model ? `${computer.name} · ${computer.model.name}` : computer.name,
      detail: computer.online ? (computer.model ? null : "这台电脑上没设模型") : "离线",
      disabled: !computer.model
    })),
    ...magpieOptions,
    {
      source: "key",
      label: current.source === "key" ? `${current.providerName} · ${current.model}` : "自己的 key",
      detail: current.source !== "key" && own ? `上次用的 ${own.providerName} · ${own.model}` : null,
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
                className="flex min-h-control items-center gap-2 rounded-tag px-2 py-1 text-left enabled:hover:bg-foreground/6 disabled:cursor-default"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-subheadline font-medium">{option.label}</span>
                  {option.detail && <span className="block truncate text-caption text-muted">{option.detail}</span>}
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
            onChange={(fallback) =>
              void save({
                source: "computer",
                computerId: current.computerId,
                fallback,
                ...(current.magpie ? { magpie: current.magpie.id } : {})
              })
            }
          >
            <Switch.Content className="flex w-full items-center gap-3 px-2">
              <Label className="min-w-0 flex-1 text-subheadline">电脑离线时用 Pupu 自带的</Label>
              <Switch.Control className="shrink-0">
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        )}
        {model.mayEdit && pickedMagpie && (
          <MagpiePicker
            magpie={pickedMagpie}
            current={current.source === "computer" && current.computerId === pickedMagpie.computerId ? (current.magpie?.id ?? null) : null}
            sending={sending}
            onPick={(id) => void save({ source: "computer", computerId: pickedMagpie.computerId, fallback: false, magpie: id })}
          />
        )}
        {model.mayEdit && picked === "key" && (
          <KeyForm
            own={own}
            keys={model.keys ?? []}
            sending={sending}
            onSave={save}
            onForget={async (provider) => {
              setSending(true);
              setError(null);
              try {
                await api.forgetModelKey(provider);
                await onSaved();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setSending(false);
              }
            }}
          />
        )}
        {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
      </div>
      {!model.mayEdit && <p className="m-0 px-4 text-footnote font-normal text-muted">只有创建者能换。</p>}
    </section>
  );
}

/** Magpie 里的模型，挑一个就试一下并存上。 */
function MagpiePicker({
  magpie,
  current,
  sending,
  onPick
}: {
  magpie: MagpieView;
  current: string | null;
  sending: boolean;
  onPick: (id: string) => void;
}) {
  const [choosing, setChoosing] = useState<string | null>(null);
  useEffect(() => {
    if (!sending) setChoosing(null);
  }, [sending]);
  const models = [...magpie.models].sort((a, b) => a.name.localeCompare(b.name));
  const value = choosing ?? (current && models.some((each) => each.id === current) ? current : "");
  return (
    <div className="flex flex-col gap-1 border-t border-foreground/10 pt-3">
      <span className="relative">
        <select
          aria-label="Magpie 里的模型"
          value={value}
          disabled={sending || !magpie.on}
          onChange={(event) => {
            if (!event.target.value) return;
            setChoosing(event.target.value);
            onPick(event.target.value);
          }}
          className={`${INPUT} w-full appearance-none pr-8`}
        >
          {!value && <option value="">{models.length ? "选一个模型" : "Magpie 里没有能调工具的模型"}</option>}
          {models.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[11px] text-muted" />
      </span>
      {sending && choosing && <p className="m-0 px-1 text-footnote text-muted">正在试这个模型…</p>}
    </div>
  );
}

const REGIONS: readonly [Template["region"], string][] = [
  ["cn", "国内"],
  ["global", "海外"],
  ["custom", "自定义"]
];

/** 「高级」里的几项。选了模型就按模型的资料填，用户可以改。 */
type Extras = { contextWindow: string; vision: boolean; reasoning: boolean };

function extrasOf(option: ModelOption | KeyView | null): Extras {
  return option
    ? { contextWindow: String(option.contextWindow), vision: option.vision, reasoning: option.reasoning }
    : { contextWindow: "32000", vision: false, reasoning: false };
}

/**
 * 自己的 key：选一家，贴 key，从拉到的模型里挑一个。地址、协议跟着模板走；自定义的才填地址。
 * 模型列表拉不到就手填模型名，不卡住保存。
 */
function KeyForm({
  own,
  keys,
  sending,
  onSave,
  onForget
}: {
  own: KeyView | null;
  keys: readonly { readonly provider: string; readonly baseUrl: string }[];
  sending: boolean;
  onSave: (choice: unknown) => Promise<boolean>;
  onForget: (provider: string) => Promise<void>;
}) {
  const [provider, setProvider] = useState(own?.provider ?? "deepseek");
  const template = templateOf(provider) ?? TEMPLATES[0]!;
  const editable = template.editableBaseUrl === true;
  const [customUrl, setCustomUrl] = useState(() => {
    const saved = keys.find((each) => each.provider === provider);
    return editable && saved ? saved.baseUrl : "";
  });
  const baseUrl = editable ? customUrl.trim() : template.baseUrl;
  const saved = keys.find((each) => each.provider === provider);
  const keyKept = Boolean(saved && (!editable || saved.baseUrl === baseUrl.replace(/\/+$/, "")));
  const [apiKey, setApiKey] = useState("");
  const [list, setList] = useState<ModelList | null>(null);
  const [loading, setLoading] = useState(false);
  const [modelId, setModelId] = useState(own?.provider === provider ? own.model : "");
  const [typing, setTyping] = useState(false);
  const [extras, setExtras] = useState<Extras>(extrasOf(own?.provider === provider ? own : null));

  // 换服务商、key 或地址就重拉。key 是一个字一个字粘进来的，等一下再拉。
  useEffect(() => {
    // 本机开发时云端能连 localhost 上的服务，和服务端的规则一样。
    if (editable && !/^(https:\/\/[^/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(baseUrl)) {
      setList(null);
      return;
    }
    let stale = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .providerModels({ provider, baseUrl, apiKey })
        .then((next) => {
          if (!stale) setList(next);
        })
        .catch((cause) => {
          if (!stale) setList({ models: [], error: cause instanceof Error ? cause.message : String(cause) });
        })
        .finally(() => {
          if (!stale) setLoading(false);
        });
    }, 400);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [provider, baseUrl, apiKey, editable]);

  const models = list?.models ?? [];
  const listed = models.find((each) => each.id === modelId);
  // 列表里没有、或者拉不到：手填。
  const manual = typing || (list !== null && models.length === 0);

  function chooseProvider(next: string) {
    setProvider(next);
    setApiKey("");
    setList(null);
    setTyping(false);
    const keep = own?.provider === next ? own : null;
    setModelId(keep?.model ?? "");
    setExtras(extrasOf(keep));
    const nextTemplate = templateOf(next);
    const savedNext = keys.find((each) => each.provider === next);
    setCustomUrl(nextTemplate?.editableBaseUrl && savedNext ? savedNext.baseUrl : "");
  }

  function chooseModel(id: string) {
    setModelId(id);
    const option = models.find((each) => each.id === id);
    if (option) setExtras(extrasOf(option));
  }

  return (
    <form
      className="flex flex-col gap-2 border-t border-foreground/10 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          source: "key",
          provider,
          baseUrl,
          model: modelId.trim(),
          apiKey,
          contextWindow: Number(extras.contextWindow || 0),
          vision: extras.vision,
          reasoning: extras.reasoning
        }).then((saved) => {
          // 存好了就清掉框里的 key，之后显示「key 已存」。
          if (saved) setApiKey("");
        });
      }}
    >
      <span className="relative">
        <select
          aria-label="服务商"
          value={provider}
          onChange={(event) => chooseProvider(event.target.value)}
          className={`${INPUT} w-full appearance-none pr-8`}
        >
          {REGIONS.map(([region, label]) => (
            <optgroup key={region} label={label}>
              {TEMPLATES.filter((each) => each.region === region).map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[11px] text-muted" />
      </span>
      {editable && (
        <input
          aria-label="地址"
          placeholder={template.api === "anthropic-messages" ? "https://api.example.com/anthropic" : "https://api.example.com/v1"}
          value={customUrl}
          onChange={(event) => setCustomUrl(event.target.value)}
          onPaste={(event) => {
            // 贴的是认得的那家：直接换成那家的模板。只认粘贴，手打到一半不跳。
            const known = recognize(event.clipboardData.getData("text"));
            if (known && !known.editableBaseUrl) {
              event.preventDefault();
              chooseProvider(known.id);
            }
          }}
          className={INPUT}
          autoComplete="off"
          spellCheck={false}
        />
      )}
      <div className="flex items-center gap-2">
        <input
          aria-label="key"
          type="password"
          placeholder={keyKept ? "key 已存，留空不改" : "key"}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          className={`${INPUT} min-w-0 flex-1`}
          autoComplete="off"
        />
        {template.keyUrl && (
          <a
            href={template.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-subheadline text-accent"
          >
            拿 key
          </a>
        )}
      </div>
      {manual ? (
        <input
          aria-label="模型名"
          placeholder="模型名"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
          className={INPUT}
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <span className="relative">
          <select
            aria-label="模型"
            value={listed ? modelId : ""}
            disabled={loading && models.length === 0}
            onChange={(event) => {
              if (event.target.value === "\u0000") setTyping(true);
              else chooseModel(event.target.value);
            }}
            className={`${INPUT} w-full appearance-none pr-8`}
          >
            {!listed && <option value="">{loading ? "正在拉模型…" : "选一个模型"}</option>}
            {models.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name === each.id ? each.id : `${each.name}（${each.id}）`}
              </option>
            ))}
            <option value={"\u0000"}>填别的模型名…</option>
          </select>
          <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[11px] text-muted" />
        </span>
      )}
      {list?.error && <p className="m-0 px-1 text-footnote text-muted">{list.error}</p>}
      <details className="px-1">
        <summary className="cursor-pointer text-footnote text-muted">高级</summary>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-subheadline">
            <span className="shrink-0 text-muted">上下文</span>
            <input
              aria-label="上下文长度"
              inputMode="numeric"
              value={extras.contextWindow}
              onChange={(event) => setExtras({ ...extras, contextWindow: event.target.value.replace(/[^\d]/g, "") })}
              className={`${INPUT} w-28`}
            />
          </label>
          <label className="flex items-center gap-1.5 text-subheadline">
            <input type="checkbox" checked={extras.vision} onChange={(event) => setExtras({ ...extras, vision: event.target.checked })} />
            能看图
          </label>
          <label className="flex items-center gap-1.5 text-subheadline">
            <input
              type="checkbox"
              checked={extras.reasoning}
              onChange={(event) => setExtras({ ...extras, reasoning: event.target.checked })}
            />
            会思考
          </label>
        </div>
      </details>
      <div className="flex justify-end gap-2">
        {saved && (
          <Button size="sm" variant="tertiary" isDisabled={sending} onPress={() => void onForget(provider)}>
            忘掉 key
          </Button>
        )}
        <Button size="sm" type="submit" isPending={sending} isDisabled={!modelId.trim()}>
          试一下并保存
        </Button>
      </div>
    </form>
  );
}

/** 设置首页「模型」那一行右边的字。 */
export function modelSummary(current: ModelView, computers: readonly ComputerView[]): string {
  if (current.source === "pupu") return "Pupu 自带";
  if (current.source === "key") return current.model;
  if (current.magpie) return current.magpie.name;
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
      <h3 className="m-0 px-4 text-footnote text-muted">这台电脑上的模型</h3>
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
