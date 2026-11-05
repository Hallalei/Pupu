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
 * 只在电脑 App 的窗口里出现：这台电脑的状态和本机开关，跟菜单栏图标里的一样。
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

  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 px-1 text-footnote text-muted">这台电脑</h3>
      <div className="flex flex-col gap-3 rounded-row bg-default px-3 py-3">
        <div className="flex items-center gap-3">
          <span
            className={`size-2 shrink-0 rounded-full ${
              computer.status === "offline" ? "bg-offline" : "bg-online"
            }`}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-body font-medium">{computer.name}</div>
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
        {!computer.paired ? (
          <div className="flex flex-col items-start gap-2">
            <p className="m-0 text-subheadline text-muted">这台电脑的授权被吊销了，Pupu 现在用不了它。</p>
            <Button size="sm" variant="secondary" onPress={() => void run(() => app.repair())}>
              重新授权
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!computer.screenGrant && computer.status !== "screen"}
              onPress={() => void run(() => app.takeback())}
            >
              收回屏幕控制
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={computer.jobs === 0}
              onPress={() => void run(() => app.stopJobs())}
            >
              {computer.jobs > 0 ? `停止命令（${computer.jobs} 条）` : "停止命令"}
            </Button>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {SWITCHES.map(([name, label, hint]) => (
            <Switch
              key={name}
              isSelected={computer[name]}
              onChange={(value) => void run(() => app.setSwitch(name, value))}
            >
              <Switch.Content className="flex w-full items-start gap-3">
                <span className="min-w-0 flex-1">
                  <Label className="block text-subheadline font-medium">{label}</Label>
                  <span className="block text-caption text-muted">{hint}</span>
                </span>
                <Switch.Control className="mt-0.5 shrink-0">
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 border-t border-foreground/10 pt-3">
          {PERMISSIONS.map(([pane, label]) => (
            <div key={pane} className="flex items-center gap-2 text-subheadline">
              <span className="flex-1">
                {label}
                <span className="text-muted">{computer.permissions[pane] ? " · 已允许" : " · 还没允许"}</span>
              </span>
              {!computer.permissions[pane] && (
                <button
                  type="button"
                  className="shrink-0 text-subheadline font-semibold hover:opacity-75"
                  onClick={() => void run(() => app.openPrivacySettings(pane))}
                >
                  去打开
                </button>
              )}
            </div>
          ))}
          {PERMISSIONS.some(([pane]) => !computer.permissions[pane]) && (
            <p className="m-0 text-caption text-muted">在系统设置里给「Pupu」打开，然后从菜单栏退出 Pupu 再打开。</p>
          )}
        </div>
        {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
      </div>
    </section>
  );
}
