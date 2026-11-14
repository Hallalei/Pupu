import { Input, Modal, Spinner, TextArea } from "@heroui/react";
import { useState } from "react";
import { PILL_ACTION, PILL_SECONDARY } from "./settings-ui";

/**
 * 手动建空间：私有的，只有自己和 Pupu，建好再邀请人。
 * 规范没画这一个弹窗，照 Docs 的「上传」排：居中弹窗，surface-sheet 底，各项隔 12，最下面「取消」「新建」并排等宽。
 */
export function NewProject({
  isOpen,
  onOpenChange,
  onCreate
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, goal: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim(), goal.trim());
      setName("");
      setGoal("");
      onOpenChange(false);
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
          <Modal.Dialog className="layer-dialog w-[min(92vw,420px)] max-w-none gap-3 p-4">
            <Modal.Heading className="m-0 px-1 pt-1 text-title text-ink">新空间</Modal.Heading>
            <Input
              aria-label="空间名"
              placeholder="名字"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
            <TextArea aria-label="目标" placeholder="目标（选填）" rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} />
            {error && <p className="m-0 px-1 text-subheadline text-danger-ink">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => onOpenChange(false)} className={`${PILL_SECONDARY} flex-1`}>
                取消
              </button>
              <button
                type="button"
                disabled={!name.trim()}
                aria-disabled={busy || undefined}
                onClick={() => void create()}
                className={`${PILL_ACTION} flex-1 ${busy ? "pointer-events-none" : ""}`}
              >
                {busy && <Spinner size="sm" color="current" aria-label="正在新建" className="size-3.5" />}
                新建
              </button>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
