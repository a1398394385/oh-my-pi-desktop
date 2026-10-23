// Worktree-create dialog (sidebar "Worktree Session" entry): names a new branch
// omp/desktop/<slug> checked out at ~/.omp/wt/desktop-<slug>-<hash7>, then hands
// the path to the normal new-session flow (showWelcomeScreen + setWelcomeProject,
// so the first composer message runs create_session with the worktree as cwd).
// Reused surfaces: Dialog base + .confirm-box, .inp input, .confirm-btn footer —
// the app-wide dialog language, no dialog-private styles.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../../ui/dialog";
import { useAppStore, toast, showWelcomeScreen, setWelcomeProject, activeOpen } from "../../../store";
import { worktreeCreate } from "../../../store/worktree";

// Renderer-side mirror of the host's slugify (host/rpc/worktree.ts) — preview only,
// the host re-validates authoritatively.
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
const labelStyle = { fontSize: "var(--ui-fs-sm)", color: "var(--dim)", marginBottom: "6px", display: "block" } as const;

// Localized label for the host's stable error codes; the raw host error (paths,
// git stderr) is appended for the detail the labels don't carry.
const CODE_KEY: Record<string, string> = {
  not_a_repo: "worktree.code.not_a_repo",
  invalid_name: "worktree.code.invalid_name",
  not_a_worktree: "worktree.code.not_a_worktree",
  worktree_dirty: "worktree.code.worktree_dirty",
};

export function worktreeErrorText(t: (key: string, opts?: Record<string, unknown>) => string, code: string | undefined, error: string | undefined, fallback: string): string {
  const label = code && CODE_KEY[code] ? t(CODE_KEY[code]) : t(fallback);
  return error ? `${label}: ${error}` : label;
}

export default function WorktreeCreateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const fallbackCwd = useAppStore((s) => s.newSessionProject);
  const [name, setName] = useState("");
  const [baseRef, setBaseRef] = useState<"HEAD" | "default">("HEAD");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const baseCwd = activeOpen()?.cwd || fallbackCwd || "";
  const slug = slugify(name);
  const validName = NAME_PATTERN.test(slug);

  const submit = async () => {
    if (!validName || !baseCwd || creating) return;
    setCreating(true);
    setError(null);
    try {
      const reply = await worktreeCreate({ name, baseRef, baseCwd });
      if (!reply.ok || !reply.path || !reply.branch) {
        setError(worktreeErrorText(t, reply.code, reply.error, "worktree.create.failed"));
        return;
      }
      // Hand the worktree to the existing new-session flow: the welcome page's
      // next composer send runs create_session with this cwd.
      showWelcomeScreen();
      setWelcomeProject(reply.path);
      toast(t("worktree.create.openedToast"));
      onClose();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !creating) onClose(); }}>
      <DialogContent
        className="confirm-box"
        style={{ width: "480px", maxWidth: "calc(100vw - 48px)" }}
        aria-describedby={undefined}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="confirm-title">{t("worktree.create.title")}</DialogTitle>
        <form
          style={{ marginTop: "12px" }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label style={labelStyle}>{t("worktree.create.nameLabel")}</label>
          <input
            ref={inputRef}
            className="inp w-full"
            value={name}
            placeholder={t("worktree.create.namePh")}
            maxLength={41}
            disabled={creating}
            onChange={(e) => setName(e.target.value)}
          />
          {name && validName && (
            <p style={{ marginTop: "6px", fontSize: "var(--ui-fs-sm)", color: "var(--dim)" }}>
              {t("worktree.create.branchPreview", { branch: `omp/desktop/${slug}` })}
            </p>
          )}
          {name && !validName && (
            <p role="alert" style={{ marginTop: "6px", fontSize: "var(--ui-fs-sm)", color: "var(--err)" }}>
              {t("worktree.create.invalidName")}
            </p>
          )}
          <div style={{ marginTop: "12px" }}>
            <div style={labelStyle}>{t("worktree.create.baseLabel")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {(["HEAD", "default"] as const).map((value) => (
                <label key={value} style={{ display: "flex", cursor: "pointer", alignItems: "center", gap: "8px", fontSize: "var(--ui-fs)" }}>
                  <input type="radio" name="worktree-base" checked={baseRef === value} disabled={creating} onChange={() => setBaseRef(value)} style={{ accentColor: "var(--accent)" }} />
                  {value === "HEAD" ? t("worktree.create.baseHead") : t("worktree.create.baseDefault")}
                </label>
              ))}
            </div>
          </div>
          {error && (
            <p role="alert" style={{ marginTop: "10px", fontSize: "var(--ui-fs-sm)", color: "var(--err)", wordBreak: "break-all" }}>
              {error}
            </p>
          )}
          <DialogFooter className="confirm-actions" style={{ marginTop: "16px" }}>
            <button type="button" className="confirm-btn" disabled={creating} onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="confirm-btn" disabled={!validName || !baseCwd || creating} autoFocus>
              {creating ? t("worktree.create.creating") : t("worktree.create.submit")}
            </button>
          </DialogFooter>
          {!baseCwd && (
            <p role="alert" style={{ marginTop: "8px", fontSize: "var(--ui-fs-sm)", color: "var(--err)" }}>
              {t("worktree.create.baseMissing")}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
