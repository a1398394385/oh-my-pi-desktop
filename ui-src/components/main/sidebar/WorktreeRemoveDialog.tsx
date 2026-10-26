// Worktree-remove dialog (session-row context menu → "Remove Worktree"):
// queries worktree_status first — clean → removes right away (the menu click
// already is the confirmation); dirty → shows branch/path + counts and waits
// for an explicit force confirm; gone/not-a-worktree → toast and close.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../../ui/dialog";
import { toast } from "../../../store";
import { worktreeRemove, worktreeStatus, type WorktreeStatusReply } from "../../../store/worktree";
import { worktreeErrorText } from "./WorktreeCreateDialog";

type Phase = { kind: "checking" } | { kind: "ready"; status: WorktreeStatusReply } | { kind: "error"; text: string };

export default function WorktreeRemoveDialog({ target, onClose }: { target: { path: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [busy, setBusy] = useState(false);

  const remove = async (force: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const reply = await worktreeRemove(target.path, force);
      if (!reply.ok) {
        toast(worktreeErrorText(t, reply.code, reply.error, "worktree.remove.removeFailed"), true);
        return;
      }
      toast(t("worktree.remove.removedToast"));
      onClose();
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const status = await worktreeStatus(target.path);
        if (!status.ok) {
          setPhase({ kind: "error", text: worktreeErrorText(t, status.code, status.error, "worktree.remove.removeFailed") });
          return;
        }
        setPhase({ kind: "ready", status });
        if (!status.exists) {
          toast(t("worktree.remove.goneToast"));
          onClose();
        } else if (status.isRepo && !status.dirty) {
          void remove(false); // clean: the context-menu click was the confirmation
        }
      } catch (e) {
        setPhase({ kind: "error", text: String(e instanceof Error ? e.message : e) });
      }
    })();
    // Status/remove reads `target` once per open; closing rewrites it via the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = phase.kind === "ready" ? phase.status : null;
  const dirty = status !== null && status.exists && status.isRepo && status.dirty;

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent
        className="confirm-box"
        style={{ width: "480px", maxWidth: "calc(100vw - 48px)" }}
        aria-describedby={undefined}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="confirm-title">{t("worktree.remove.title")}</DialogTitle>
        {phase.kind === "checking" && (
          <p className="confirm-desc" style={{ marginTop: "10px" }}>
            {t("worktree.remove.checking")}
          </p>
        )}
        {phase.kind === "error" && (
          <p role="alert" style={{ marginTop: "10px", fontSize: "var(--ui-fs-sm)", color: "var(--err)", wordBreak: "break-all" }}>
            {phase.text}
          </p>
        )}
        {status && (
          <div style={{ marginTop: "10px" }}>
            {status.exists && !status.isRepo && <p className="confirm-desc">{t("worktree.remove.notWorktree")}</p>}
            {dirty && (
              <p className="confirm-desc" style={{ color: "var(--err)" }}>
                {t("worktree.remove.dirtyBody", { staged: status.staged, unstaged: status.unstaged, untracked: status.untracked })}
              </p>
            )}
            {(status.isRepo || status.branch) && (
              <p style={{ marginTop: "10px", fontSize: "var(--ui-fs-sm)", color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={target.path}>
                {status.branch ?? "HEAD"} — {target.path}
              </p>
            )}
          </div>
        )}
        <DialogFooter className="confirm-actions" style={{ marginTop: "16px" }}>
          {(!dirty || !busy) && (
            <button type="button" className="confirm-btn" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </button>
          )}
          {dirty && (
            <button type="button" className="confirm-btn danger" disabled={busy} onClick={() => void remove(true)}>
              {busy ? t("worktree.remove.removing") : t("worktree.remove.forceBtn")}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
