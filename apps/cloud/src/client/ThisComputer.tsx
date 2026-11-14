import { Label, Switch } from "@heroui/react";
import { useState } from "react";
import { desktop, type ChromeProfile, type DesktopComputer, type DesktopSwitch, type PrivacyPane } from "./desktop";
import { ComputerIcon } from "./icons";
import { LocalModelForm } from "./ModelSettings";
import { Group, PILL_ACTION, PILL_ROW } from "./settings-ui";

const SWITCHES: readonly (readonly [DesktopSwitch, string, string])[] = [
  ["allowCommands", "允许跑命令和写文件", "关掉后，批准了也不做。"],
  ["allowScreen", "允许操作屏幕", "关掉时顺手收回屏幕授权。"]
];

const PERMISSIONS: readonly (readonly [PrivacyPane, string])[] = [
  ["screen", "屏幕录制"],
  ["accessibility", "辅助功能"]
];

/** 圆点：在线 online；在做事、在用屏幕 ink，和事情「正在做」一样；等你批准 warning；没连上、授权被吊销 offline。 */
const DOT: Record<DesktopComputer["status"], string> = {
  idle: "bg-online",
  busy: "bg-ink",
  screen: "bg-ink",
  waiting: "bg-warning",
  offline: "bg-offline"
};

/** 状态词（规范 ThisComputer）。页面自己按状态写：老的电脑 App 报的 title 还是菜单栏的老说法。 */
const WORD: Record<DesktopComputer["status"], string> = {
  offline: "没连上",
  idle: "在线",
  busy: "在做事",
  screen: "在用屏幕",
  waiting: "等你批准"
};

/**
 * 窗口还在、这台电脑的凭据没了：配对半路没做完是「没连上」（补充「配对没做完」由 App 报），云端拒了是「授权被吊销」。
 * 老的 App 分不出这两种，没配好都当被吊销。设置首页「这台电脑」那一行也用它。
 */
export function statusWord(computer: DesktopComputer): string {
  if (computer.paired) return WORD[computer.status];
  return computer.unfinished ? WORD.offline : "授权被吊销";
}

/** 这一页的行：高 44，左右 16，字 body；不能点的字用 ink-muted。 */
const ROW =
  "flex min-h-11 w-full items-center px-4 py-2.5 text-left text-body text-ink enabled:pointer-fine:hover:bg-line disabled:text-ink-muted";

type Where = "status" | "switches" | "permissions";

/**
 * 设置里「这台电脑」那一页（规范 ThisComputer），只在电脑 App 的窗口里有：状态、本机开关、系统授权、浏览器、这台电脑上的模型。
 * 和菜单栏图标是同一份数据；开关存在这台电脑上，云端改不了。权限分级、「远程控制前」和吊销在「电脑」页，不在这里。
 */
export function ThisComputer({ computer }: { computer: DesktopComputer }) {
  const [errors, setErrors] = useState<Partial<Record<Where, string>>>({});
  const app = desktop();
  if (!app) return null;

  // 失败写在出事的那一组下面，不弹窗。
  function run(where: Where, work: () => Promise<void>) {
    setErrors((all) => ({ ...all, [where]: undefined }));
    work().catch((cause: unknown) =>
      setErrors((all) => ({ ...all, [where]: cause instanceof Error ? cause.message : String(cause) }))
    );
  }

  // 补充（屏幕已授权、正在连接…、没连上的原因）只有新的电脑 App 报，接在状态词后面。
  const status = [statusWord(computer), computer.detail].filter(Boolean).join(" · ");
  const missing = PERMISSIONS.some(([pane]) => !computer.permissions[pane]);

  return (
    <>
      <Group label="这台电脑的状态" error={errors.status}>
        <div key="status" className="flex items-start gap-3 px-4 py-3">
          <ComputerIcon className="mt-2 shrink-0 text-[24px]" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-headline">{computer.name}</span>
            <span className="flex min-w-0 items-center gap-1 text-subheadline text-ink-muted">
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[computer.status]}`} />
              <span className="truncate">{status}</span>
            </span>
            {computer.lines.length > 0 && (
              <ul className="m-0 mt-1 flex list-none flex-col p-0 font-mono text-code text-ink-muted">
                {computer.lines.slice(0, 6).map((line) => (
                  <li key={line} className="truncate">
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {computer.paired
          ? [
              <button
                key="takeback"
                type="button"
                disabled={!computer.screenGrant && computer.status !== "screen"}
                onClick={() => run("status", () => app.takeback())}
                className={ROW}
              >
                收回屏幕
              </button>,
              <button
                key="stop"
                type="button"
                disabled={computer.jobs === 0}
                onClick={() => run("status", () => app.stopJobs())}
                className={ROW}
              >
                {computer.jobs > 0 ? `停止命令（${computer.jobs} 条）` : "停止命令"}
              </button>
            ]
          : computer.unfinished
            ? (
                // 状态那一行已经写了「没连上 · 配对没做完」，这里只给按钮。
                <div key="unfinished" className="flex px-4 py-3">
                  <button type="button" onClick={() => run("status", () => app.repair())} className={PILL_ACTION}>
                    再试一次
                  </button>
                </div>
              )
            : (
                <div key="revoked" className="flex flex-col items-start gap-2 px-4 py-3">
                  <p className="m-0 text-body">Pupu 现在用不了这台电脑。</p>
                  <button type="button" onClick={() => run("status", () => app.repair())} className={PILL_ACTION}>
                    重新配对
                  </button>
                </div>
              )}
      </Group>
      <Group label="本机开关" error={errors.switches}>
        {SWITCHES.map(([name, label, hint]) => (
          <Switch
            key={name}
            isSelected={computer[name]}
            onChange={(value) => run("switches", () => app.setSwitch(name, value))}
            className="flex w-full px-4 py-2.5"
          >
            <Switch.Content className="flex w-full items-center gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Label className="text-body font-normal">{label}</Label>
                <span className="text-subheadline text-ink-muted">{hint}</span>
              </span>
              <Switch.Control className="shrink-0">
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        ))}
      </Group>
      <Group
        title="系统授权"
        note={missing ? "在系统设置里给「Pupu」打开，然后从菜单栏退出 Pupu 再打开。" : undefined}
        error={errors.permissions}
      >
        {PERMISSIONS.map(([pane, label]) => (
          <div key={pane} className="flex min-h-11 items-center gap-3 px-4 py-1.5">
            <span className="min-w-0 flex-1 text-body">{label}</span>
            {computer.permissions[pane] ? (
              <span className="shrink-0 text-subheadline text-ink-muted">已允许</span>
            ) : (
              <button type="button" onClick={() => run("permissions", () => app.openPrivacySettings(pane))} className={PILL_ROW}>
                去打开
              </button>
            )}
          </div>
        ))}
      </Group>
      {app.importChrome && app.chromeProfiles && computer.paired && <ChromeImport />}
      {computer.paired && <LocalModelForm />}
    </>
  );
}

/**
 * Pupu 浏览器的登录状态从这台电脑的 Chrome 导进来：只有一个用户资料就直接导，有几个就列出来让人挑。
 * macOS 会问能不能用钥匙串，人自己点允许。导进来的只在这台电脑上。
 */
function ChromeImport() {
  const app = desktop();
  const [profiles, setProfiles] = useState<readonly ChromeProfile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!app?.importChrome || !app.chromeProfiles) return null;
  const { importChrome, chromeProfiles } = app;

  async function start(profile: string) {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const done = await importChrome(profile);
      if (done.ok) {
        setResult(`导进了 ${done.imported} 个登录状态${done.skipped ? `，跳过 ${done.skipped} 个过期或解不开的` : ""}。`);
        setProfiles(null);
      } else setError(done.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    setResult(null);
    setError(null);
    const found = await chromeProfiles();
    if (found.length === 0) setError("这台电脑上没找到 Chrome。");
    else if (found.length === 1) await start(found[0]!.dir);
    else setProfiles(found);
  }

  return (
    <Group title="浏览器" note={error ? undefined : (result ?? "只存在这台电脑上，不上传。")} error={error}>
      <div key="import" className="flex min-h-11 items-center gap-3 px-4 py-1.5">
        <span className="min-w-0 flex-1 text-body">Pupu 浏览器的登录状态</span>
        <button type="button" disabled={busy} onClick={() => void pick()} className={PILL_ROW}>
          {busy ? "正在导入…" : "从 Chrome 导入"}
        </button>
      </div>
      {profiles && (
        <div key="profiles" role="group" aria-label="Chrome 的用户资料" className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          {profiles.map((profile) => (
            <button key={profile.dir} type="button" disabled={busy} onClick={() => void start(profile.dir)} className={PILL_ROW}>
              {profile.name}
            </button>
          ))}
        </div>
      )}
    </Group>
  );
}
