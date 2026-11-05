import { Button, Input, Modal, TextArea } from "@heroui/react";
import { useState } from "react";

/** 手动建项目。平时是 Pupu 在聊天里问过你再建，这里给想自己建的时候用。 */
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
          <Modal.Dialog className="w-[min(92vw,420px)] rounded-panel">
            <Modal.Header>
              <Modal.Heading className="text-title">新项目</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              <Input
                aria-label="项目名"
                placeholder="名字"
                value={name}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
              <TextArea
                aria-label="目标"
                placeholder="目标（选填）"
                rows={3}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
              {error && <div className="text-subheadline text-danger-ink">{error}</div>}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary">
                取消
              </Button>
              <Button isPending={busy} isDisabled={!name.trim()} onPress={() => void create()}>
                新建
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
