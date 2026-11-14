import { Label, Spinner, Switch } from "@heroui/react";
import { useEffect, useState, type ReactNode } from "react";
import type { ComputerView } from "../bridge/protocol";
import { recognize, templateOf, TEMPLATES, type Template } from "../model/catalog";
import type { ModelList, ModelOption } from "../model/list";
import type { KeyView, ModelView } from "../model/settings";
import type { MagpieView } from "../server";
import { api } from "./api";
import { desktop, type LocalModelView } from "./desktop";
import { ChevronDownIcon } from "./icons";
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
function SaveButton({ sending, disabled = false }: { sending: boolean; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
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

/** 选项：报不上模型的电脑、离线或没开的 Magpie 点不了（正选着的照常画）。 */
type Option = { readonly source: Source; readonly label: string; readonly detail: ReactNode; readonly disabled: boolean };

/** 下拉框（服务商、模型、Magpie 里的模型）：和输入框一样的底，右边一个 ink-muted 的小箭头。 */
function Select({ label, value, disabled, onChange, children }: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className="relative">
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={`field w-full appearance-none pr-8 disabled:text-ink-muted ${value === "" ? "text-ink-muted" : ""}`}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[11px] text-ink-muted" />
    </span>
  );
}

/**
 * 设置里「模型」那一页（规范 ModelSettings）：这个 Pupu 用哪个模型。大家都看得到用的是哪个，只有创建者能换。
 * 列出来的电脑是报了模型的那几台，加上正在用的那台（它可能离线了、或者没设模型）。
 * 自己电脑上开着 Magpie 的，再多一项 Magpie，选了从它的模型里挑一个（照 Cindy 的做法，见 bridge/magpie.ts）。
 * 点「Pupu 自带」或一台电脑马上就换；点「自己的 key」只展开表单，「保存」先试再存。
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
  const mayEdit = model.mayEdit;
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
    if (!mayEdit || sending) return;
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
  const magpieOptions: Option[] = magpies.map((each) => {
    const computer = computers.find((item) => item.id === each.computerId);
    const using = current.source === "computer" && current.computerId === each.computerId ? current.magpie : undefined;
    const where = magpies.length > 1 ? ` · ${nameOf(each.computerId)}` : "";
    return {
      source: `magpie:${each.computerId}`,
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
  const options: Option[] = [
    { source: "pupu", label: "Pupu 自带", detail: null, disabled: false },
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
        ),
        disabled: !computer.model
      })
    ),
    ...magpieOptions,
    {
      source: "key",
      label: current.source === "key" ? `${current.providerName} · ${current.model}` : "自己的 key",
      detail: current.source !== "key" && own ? `上次用的 ${own.providerName} · ${own.model}` : null,
      disabled: false
    }
  ];

  const formOpen = mayEdit && picked === "key";
  const fallbackOpen = mayEdit && current.source === "computer" && picked === currentSource;
  const magpieOpen = mayEdit && pickedMagpie !== undefined;

  return (
    <>
      <Group
        radiogroup
        label="用哪个模型"
        readOnly={!mayEdit}
        inset="radio"
        note={mayEdit ? SENT_TO : `${SENT_TO}只有创建者能换。`}
        error={formOpen || fallbackOpen || magpieOpen ? null : error}
      >
        {options.map((option) => {
          const selected = picked === option.source;
          const off = option.disabled && !selected;
          return (
            <label
              key={option.source}
              className={`flex min-h-11 items-center gap-3 px-4 py-2.5 ${mayEdit && !sending && !off ? "cursor-pointer pointer-fine:hover:bg-line" : ""}`}
            >
              {/* 不是创建者：选中的照常画，没选的圈 30% 透明；用 aria-disabled 不用 disabled，免得整行变灰。 */}
              <input
                type="radio"
                name="model-source"
                value={option.source}
                checked={selected}
                onChange={() => pick(option.source)}
                disabled={mayEdit && (sending || off)}
                aria-disabled={mayEdit ? undefined : true}
                tabIndex={mayEdit ? undefined : -1}
                className={`m-0 size-5 shrink-0 pointer-fine:size-4 ${(!mayEdit && !selected) || (mayEdit && off) ? "opacity-30" : ""}`}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={`truncate text-body ${mayEdit && off ? "text-ink-muted" : ""}`}>{option.label}</span>
                {option.detail && (
                  <span className="flex min-w-0 items-center gap-1.5 text-subheadline text-ink-muted">{option.detail}</span>
                )}
              </span>
            </label>
          );
        })}
      </Group>
      {fallbackOpen && current.source === "computer" && (
        <Group label="电脑离线时" error={magpieOpen ? null : error}>
          <Switch
            key="fallback"
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
      {magpieOpen && pickedMagpie && (
        <MagpiePicker
          magpie={pickedMagpie}
          current={current.source === "computer" && current.computerId === pickedMagpie.computerId ? (current.magpie?.id ?? null) : null}
          sending={sending}
          error={error}
          onPick={(id) => void save({ source: "computer", computerId: pickedMagpie.computerId, fallback: false, magpie: id })}
        />
      )}
      {formOpen && (
        <KeyForm
          own={own}
          keys={model.keys ?? []}
          sending={sending}
          error={error}
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
    </>
  );
}

/** Magpie 里的模型（规范没画，照表单的下拉框）：挑一个就试一下并存上，试的时候下面一句 footnote。 */
function MagpiePicker({
  magpie,
  current,
  sending,
  error,
  onPick
}: {
  magpie: MagpieView;
  current: string | null;
  sending: boolean;
  error: string | null;
  onPick: (id: string) => void;
}) {
  const [choosing, setChoosing] = useState<string | null>(null);
  useEffect(() => {
    if (!sending) setChoosing(null);
  }, [sending]);
  const models = [...magpie.models].sort((a, b) => a.name.localeCompare(b.name));
  const value = choosing ?? (current && models.some((each) => each.id === current) ? current : "");
  return (
    <div className="flex shrink-0 flex-col gap-2">
      <Select
        label="Magpie 里的模型"
        value={value}
        disabled={sending || !magpie.on}
        onChange={(id) => {
          if (!id) return;
          setChoosing(id);
          onPick(id);
        }}
      >
        {!value && <option value="">{models.length ? "选一个模型" : "Magpie 里没有能调工具的模型"}</option>}
        {models.map((each) => (
          <option key={each.id} value={each.id}>
            {each.name}
          </option>
        ))}
      </Select>
      {sending && choosing && <p className="m-0 px-1 text-footnote text-ink-muted">正在试这个模型…</p>}
      {error && <p className="m-0 px-1 text-subheadline text-danger-ink">{error}</p>}
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

/** 「能看图」「会思考」：字在左、开关在右的一小块（规范「上下文」那一行右边的写法）。 */
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Switch isSelected={value} onChange={onChange}>
      <Switch.Content className="flex items-center gap-2">
        <Label className="text-body font-normal">{label}</Label>
        <Switch.Control className="shrink-0">
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}

/**
 * 自己的 key（规范 ModelSettings 的表单，服务商那几样规范没画）：选一家，贴 key，从拉到的模型里挑一个。
 * 地址、协议跟着模板走；自定义的才填地址。模型列表拉不到就手填模型名，不卡住保存。
 * 输入框和下拉框直接放在弹窗上，框之间 8；「上下文」「能看图」「会思考」收在「高级」里（选了模型就照它的资料填好）；
 * 右下「保存」，存过 key 的左边多一个「忘掉 key」，和「清除」一样轻。
 */
function KeyForm({
  own,
  keys,
  sending,
  error,
  onSave,
  onForget
}: {
  own: KeyView | null;
  keys: readonly { readonly provider: string; readonly baseUrl: string }[];
  sending: boolean;
  error: string | null;
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
      aria-label="自己的 key"
      className="flex shrink-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (sending || !modelId.trim()) return;
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
      <Select label="服务商" value={provider} onChange={chooseProvider}>
        {REGIONS.map(([region, label]) => (
          <optgroup key={region} label={label}>
            {TEMPLATES.filter((each) => each.region === region).map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
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
          className="field w-full"
          autoComplete="off"
          spellCheck={false}
        />
      )}
      <div className="flex items-center gap-3">
        <input
          aria-label="key"
          type="password"
          placeholder={keyKept ? "key 已存，留空不改" : "key"}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          className="field min-w-0 flex-1"
          autoComplete="off"
        />
        {/* 链接照规范：ink 加下划线。 */}
        {template.keyUrl && (
          <a href={template.keyUrl} target="_blank" rel="noreferrer" className="shrink-0 text-body text-ink underline underline-offset-2">
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
          className="field w-full"
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <Select
          label="模型"
          value={listed ? modelId : ""}
          disabled={loading && models.length === 0}
          onChange={(value) => {
            if (value === "\u0000") setTyping(true);
            else chooseModel(value);
          }}
        >
          {!listed && <option value="">{loading ? "正在拉模型…" : "选一个模型"}</option>}
          {models.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name === each.id ? each.id : `${each.name}（${each.id}）`}
            </option>
          ))}
          <option value={"\u0000"}>填别的模型名…</option>
        </Select>
      )}
      {list?.error && <p className="m-0 px-1 text-footnote text-ink-muted">{list.error}</p>}
      <details className="group px-1">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-footnote text-ink-muted [&::-webkit-details-marker]:hidden">
          高级
          <ChevronDownIcon className="text-[10px] transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-body text-ink-muted">上下文</span>
            <input
              aria-label="上下文长度"
              inputMode="numeric"
              value={extras.contextWindow}
              onChange={(event) => setExtras({ ...extras, contextWindow: event.target.value.replace(/[^\d]/g, "") })}
              className="field w-26"
            />
            <span className="flex-1" />
            <Toggle label="能看图" value={extras.vision} onChange={(vision) => setExtras({ ...extras, vision })} />
          </div>
          <div className="flex justify-end">
            <Toggle label="会思考" value={extras.reasoning} onChange={(reasoning) => setExtras({ ...extras, reasoning })} />
          </div>
        </div>
      </details>
      <FormEnd error={error}>
        {saved && (
          <button type="button" disabled={sending} onClick={() => void onForget(provider)} className={CLEAR}>
            忘掉 key
          </button>
        )}
        <SaveButton sending={sending} disabled={!modelId.trim()} />
      </FormEnd>
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
