import { Button, Drawer } from "@heroui/react";
import { useState } from "react";
import type { ComputerPolicy } from "../bridge/policy";
import type { ComputerView } from "../bridge/protocol";
import { computerLabel } from "./Home";

const POLICIES: readonly (readonly [ComputerPolicy, string, string])[] = [
  ["ask_risky", "高风险的才问", "删除、推送、发布这类先问你；屏幕先批一次，15 分钟不用就失效。"],
  ["ask_all", "每一步都问", "跑命令、写文件、点屏幕，每一步都等你批准。读文件不问。"],
  ["trust", "都放行", "什么都不问。电脑菜单栏上照样能看到 Pupu 在做什么。"]
];

/**
 * 这一版的设置：管已经连上的电脑，以及每台电脑上 Pupu 什么时候要先问你。
 */
export function Settings({
  isOpen,
  onOpenChange,
  computers,
  onRevoke,
  onSetPolicy
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  computers: readonly ComputerView[];
  onRevoke: (id: string) => Promise<void>;
  onSetPolicy: (id: string, policy: ComputerPolicy) => Promise<void>;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const origin = window.location.origin;

  async function setPolicy(id: string, policy: ComputerPolicy) {
    setPendingId(id);
    setError(null);
    try {
      await onSetPolicy(id, policy);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingId(null);
    }
  }

  async function revoke(id: string) {
    setPendingId(id);
    setError(null);
    try {
      await onRevoke(id);
      setConfirmId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Drawer>
      <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="w-[min(88vw,380px)]">
            <Drawer.Header>
              <Drawer.Heading>设置</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className="flex flex-col gap-6">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-muted">电脑</h3>
                {computers.length === 0 ? (
                  <p className="text-sm leading-6 text-muted">还没有授权的电脑。</p>
                ) : (
                  computers.map((computer) => (
                    <div
                      key={computer.id}
                      className="flex flex-col gap-2 rounded-2xl bg-default px-3 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`size-2 shrink-0 rounded-full ${
                            computer.online ? "bg-emerald-600" : "bg-foreground/25"
                          }`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{computer.name}</div>
                          <div className="text-sm text-muted">
                            {computerLabel(computer)}
                            {computer.screen ? " · 屏幕已授权" : ""}
                          </div>
                        </div>
                        {confirmId !== computer.id && (
                          <button
                            type="button"
                            className="shrink-0 text-sm text-danger"
                            onClick={() => {
                              setError(null);
                              setConfirmId(computer.id);
                            }}
                          >
                            吊销
                          </button>
                        )}
                      </div>
                      <div role="radiogroup" aria-label={`「${computer.name}」上什么时候先问你`} className="flex flex-col gap-1">
                        {POLICIES.map(([policy, label, hint]) => {
                          const selected = computer.policy === policy;
                          return (
                            <button
                              key={policy}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              disabled={pendingId === computer.id}
                              onClick={() => {
                                if (!selected) void setPolicy(computer.id, policy);
                              }}
                              className={`flex items-start gap-2.5 rounded-xl px-2.5 py-2 text-left ${
                                selected ? "bg-background" : ""
                              }`}
                            >
                              <span
                                aria-hidden="true"
                                className={`mt-1 size-3.5 shrink-0 rounded-full border-2 ${
                                  selected ? "border-foreground bg-foreground" : "border-foreground/30"
                                }`}
                              />
                              <span className="min-w-0">
                                <span className="block text-sm font-medium">{label}</span>
                                <span className="block text-xs leading-5 text-muted">{hint}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {confirmId === computer.id && (
                        <div className="flex flex-col gap-2">
                          <p className="text-sm leading-6 text-muted">
                            吊销后「{computer.name}」会断开。要再用，就在那台电脑上重新配对。
                          </p>
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="tertiary"
                              onPress={() => setConfirmId(null)}
                            >
                              取消
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              isPending={pendingId === computer.id}
                              onPress={() => void revoke(computer.id)}
                            >
                              吊销
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))
                )}
                {error && <p className="text-sm text-danger">{error}</p>}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-muted">这台电脑能做的</h3>
                <p className="text-sm leading-6">
                  跑命令，读写主目录里的文件，列目录。也能看主屏幕、点鼠标、打字。第一次操作屏幕时，系统会要求允许 pupu-computer-use 的屏幕录制和辅助功能。
                </p>
                <p className="text-sm leading-6 text-muted">
                  电脑菜单栏上有 Pupu 的图标：能看到它在跑什么、是不是在操作屏幕，一键收回屏幕控制，也能在那台电脑上关掉跑命令或操作屏幕。在电脑上关掉的，手机上批准了也不做。
                </p>
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium text-muted">再配一台</h3>
                <p className="text-sm leading-6 text-muted">在那台电脑上运行：</p>
                <pre className="overflow-x-auto rounded-2xl bg-default px-3 py-2 text-xs leading-5">
                  {`npm run bridge -- pair --url ${origin} --name 名字\nnpm run bridge -- install`}
                </pre>
              </section>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
