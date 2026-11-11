import { Button, Label, Switch } from "@heroui/react";
import { useState } from "react";
import { desktop, type DesktopComputer, type DesktopSwitch, type PrivacyPane } from "./desktop";

const SWITCHES: readonly (readonly [DesktopSwitch, string, string])[] = [
  ["allowCommands", "允许跑命令和写文件", "关掉后，批准了也不做。"],
  ["allowScreen", "允许操作屏幕", "关掉时顺手收回屏幕授权。"]
];

const PERMISSIONS: readonly (readonly [PrivacyPane, string])[] = [
  ["screen", "屏幕录制"],
  ["accessibility", "辅助功能"]
];

/**
 * 设置里「这台电脑」那一页，只在电脑 App 的窗口里有：这台电脑的状态和本机开关，跟菜单栏图标里的一样。
 * 开关存在这台电脑上，云端改不了；这里改的就是托盘里那两个勾。
 */
export function ThisComputer({ computer }: { computer: DesktopComputer }) {
  const [error, setError] = useState<string | null>(null);
  const app = desktop();
  if (!app) return null;

  async function run(work: () => Promise<void>) {
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const group = "flex flex-col divide-y divide-separator overflow-hidden rounded-row bg-surface";
  const action =
    "flex min-h-control w-full items-center px-4 py-2.5 text-left text-body enabled:hover:bg-foreground/4 disabled:text-muted";
  const missing = PERMISSIONS.some(([pane]) => !computer.permissions[pane]);

  return (
    <>
      <div className={group}>
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <span
              className={`size-2 shrink-0 rounded-full ${computer.status === "offline" ? "bg-offline" : "bg-online"}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body">{computer.name}</div>
              <div className="truncate text-subheadline text-muted">{computer.title}</div>
            </div>
          </div>
          {computer.lines.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-caption text-muted">
              {computer.lines.slice(0, 6).map((line) => (
                <li key={line} className="truncate font-mono">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
        {!computer.paired ? (
          <div className="flex flex-col items-start gap-2 px-4 py-3">
            <p className="m-0 text-subheadline text-muted">这台电脑的授权被吊销了，Pupu 现在用不了它。</p>
            <Button size="sm" variant="secondary" onPress={() => void run(() => app.repair())}>
              重新授权
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              disabled={!computer.screenGrant && computer.status !== "screen"}
              onClick={() => void run(() => app.takeback())}
              className={action}
            >
              收回屏幕控制
            </button>
            <button
              type="button"
              disabled={computer.jobs === 0}
              onClick={() => void run(() => app.stopJobs())}
              className={action}
            >
              {computer.jobs > 0 ? `停止命令（${computer.jobs} 条）` : "停止命令"}
            </button>
          </>
        )}
      </div>
      <div className={group}>
        {SWITCHES.map(([name, label, hint]) => (
          <Switch
            key={name}
            isSelected={computer[name]}
            onChange={(value) => void run(() => app.setSwitch(name, value))}
            className="px-4 py-2.5"
          >
            <Switch.Content className="flex w-full items-center gap-3">
              <span className="min-w-0 flex-1">
                <Label className="block text-body font-normal">{label}</Label>
                <span className="block text-subheadline text-muted">{hint}</span>
              </span>
              <Switch.Control className="shrink-0">
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
        ))}
      </div>
      <section className="flex flex-col gap-1.5">
        <h3 className="m-0 px-4 text-footnote text-muted">系统授权</h3>
        <div className={group}>
          {PERMISSIONS.map(([pane, label]) => (
            <div key={pane} className="flex min-h-control items-center gap-3 px-4 py-2.5 text-body">
              <span className="flex-1">{label}</span>
              {computer.permissions[pane] ? (
                <span className="text-muted">已允许</span>
              ) : (
                <button
                  type="button"
                  className="shrink-0 font-semibold hover:opacity-75"
                  onClick={() => void run(() => app.openPrivacySettings(pane))}
                >
                  去打开
                </button>
              )}
            </div>
          ))}
        </div>
        {missing && (
          <p className="m-0 px-4 text-footnote font-normal text-muted">
            在系统设置里给「Pupu」打开，然后从菜单栏退出 Pupu 再打开。
          </p>
        )}
      </section>
      {error && <p className="m-0 px-4 text-subheadline text-danger-ink">{error}</p>}
    </>
  );
}
