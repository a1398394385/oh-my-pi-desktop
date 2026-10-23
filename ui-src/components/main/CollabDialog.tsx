// Collab live-sharing dialog: host a room on a relay (optional relay address),
// join via pasted link, leave, invite-link copy rows, and the participant list.
// Mirrors oh-my-pi-gui's CollabDialog UX; all state rides the collab_state frame
// (store slice collabStates / collabBusy / collabError — no local mirrors), the
// same frame serves op replies and live participant pushes (host/rpc/collab.ts).
// Reused surfaces: Dialog base + .confirm-box card, .inp inputs, .confirm-btn
// footer (danger variant), .save-btn row buttons — app-wide dialog language.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, toast } from "../../store";
import { copyText } from "./sidebar/util";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui/dialog";
import Icon from "../../Icon";

function LinkRow({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const copy = () => {
    void copyText(value).then(
      () => toast(t("collab.copied")),
      () => toast(t("collab.copyFailed"), true),
    );
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
      <span style={{ flex: "none", width: "110px", color: "var(--dim)", fontSize: "var(--ui-fs-sm)" }}>{label}</span>
      <code
        className="truncate"
        style={{ flex: "1 1 0", minWidth: 0, padding: "6px 10px", borderRadius: "var(--r-sm)", background: "var(--panel-2)", fontSize: "var(--ui-fs-sm)" }}
        title={value}
      >
        {value}
      </code>
      <button className="save-btn" style={{ flex: "none" }} onClick={copy} title={t("collab.copy")}>
        <Icon name="copy" size={12} />
      </button>
    </div>
  );
}

export default function CollabDialog() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.collabOpen);
  const close = useAppStore((s) => s.collabCloseDialog);
  const sessionId = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath)?.sessionId : undefined));
  const state = useAppStore((s) => (s.activePath ? s.collabStates.get(s.openSessions.get(s.activePath)?.sessionId ?? "") : undefined));
  const busy = useAppStore((s) => s.collabBusy);
  const error = useAppStore((s) => s.collabError);
  const collabRefresh = useAppStore((s) => s.collabRefresh);
  const collabStart = useAppStore((s) => s.collabStart);
  const collabJoin = useAppStore((s) => s.collabJoin);
  const collabLeave = useAppStore((s) => s.collabLeave);
  // Form inputs (component-local: never needed outside the dialog)
  const [relay, setRelay] = useState("");
  const [joinLink, setJoinLink] = useState("");

  // Refresh on open so the dialog never shows stale role/participants
  useEffect(() => {
    if (open && sessionId) collabRefresh(sessionId);
  }, [open, sessionId, collabRefresh]);

  if (!open) return null;
  const dialogError = error && error.sessionId === sessionId ? error.message : null;
  const active = Boolean(state?.role);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent
        className="confirm-box"
        style={{ width: "560px", maxWidth: "92vw", maxHeight: "82vh", display: "flex", flexDirection: "column" }}
        onPointerDownOutside={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="confirm-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Icon name="globe" size={15} />
          <span>{t("collab.title")}</span>
        </DialogTitle>
        <div style={{ color: "var(--faint)", fontSize: "var(--ui-fs-sm)", marginTop: "2px" }}>{t("collab.desc")}</div>

        <div style={{ flex: 1, minHeight: 0, marginTop: "14px", overflowY: "auto", overflowX: "hidden" }}>
          {!active ? (
            <>
              <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "12px" }}>
                <div style={{ fontWeight: 500 }}>{t("collab.hostTitle")}</div>
                <div style={{ color: "var(--dim)", fontSize: "var(--ui-fs-sm)", marginTop: "4px" }}>{t("collab.hostDesc")}</div>
                <input
                  className="inp w-full"
                  style={{ marginTop: "10px" }}
                  value={relay}
                  placeholder={t("collab.relayPh")}
                  onChange={(e) => setRelay(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && sessionId && !busy) collabStart(sessionId, relay);
                  }}
                />
                <button
                  className="confirm-btn"
                  style={{ marginTop: "10px" }}
                  disabled={busy || !sessionId}
                  onClick={() => sessionId && collabStart(sessionId, relay)}
                >
                  {t("collab.start")}
                </button>
              </div>
              <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "12px", marginTop: "12px" }}>
                <div style={{ fontWeight: 500 }}>{t("collab.joinTitle")}</div>
                <div style={{ color: "var(--dim)", fontSize: "var(--ui-fs-sm)", marginTop: "4px" }}>{t("collab.joinDesc")}</div>
                <input
                  className="inp w-full"
                  style={{ marginTop: "10px" }}
                  value={joinLink}
                  placeholder={t("collab.joinPh")}
                  onChange={(e) => setJoinLink(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && joinLink.trim() && sessionId && !busy) collabJoin(sessionId, joinLink);
                  }}
                />
                <button
                  className="confirm-btn"
                  style={{ marginTop: "10px" }}
                  disabled={busy || !joinLink.trim() || !sessionId}
                  onClick={() => sessionId && collabJoin(sessionId, joinLink)}
                >
                  {t("collab.join")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div
                style={{ display: "flex", alignItems: "center", gap: "8px", padding: "9px 12px", borderRadius: "var(--r-md)", border: "1px solid var(--line)", fontSize: "var(--ui-fs-base)" }}
              >
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--green)", flex: "none" }} />
                <span className="flex-1 min-w-0 truncate">
                  {state?.role === "host" ? t("collab.hosting") : state?.readOnly ? t("collab.viewing") : t("collab.joined")}
                </span>
                <button className="save-btn danger" disabled={busy} onClick={() => sessionId && collabLeave(sessionId)}>
                  {t("collab.leave")}
                </button>
              </div>
              {state?.role === "host" && (state.link || state.viewLink) && (
                <div style={{ marginTop: "12px" }}>
                  <div style={{ color: "var(--dim)", fontSize: "var(--ui-fs-sm)", marginBottom: "8px" }}>{t("collab.linksTitle")}</div>
                  {state.link && <LinkRow label={t("collab.linkControl")} value={state.link} />}
                  {state.viewLink && <LinkRow label={t("collab.linkView")} value={state.viewLink} />}
                  {state.webLink && <LinkRow label={t("collab.webLinkControl")} value={state.webLink} />}
                  {state.webViewLink && <LinkRow label={t("collab.webLinkView")} value={state.webViewLink} />}
                </div>
              )}
              <div style={{ marginTop: "12px" }}>
                <div style={{ color: "var(--dim)", fontSize: "var(--ui-fs-sm)", marginBottom: "8px" }}>
                  {t("collab.participants")} ({state?.participants.length ?? 0})
                </div>
                {(state?.participants.length ?? 0) === 0 ? (
                  <div style={{ color: "var(--faint)", fontSize: "var(--ui-fs-sm)" }}>{t("collab.emptyParticipants")}</div>
                ) : (
                  state?.participants.map((p, i) => (
                    <div
                      key={`${p.name}-${i}`}
                      style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 10px", borderRadius: "var(--r-sm)", fontSize: "var(--ui-fs-base)" }}
                    >
                      <Icon name={p.role === "host" ? "globe" : "comment"} size={13} style={{ color: "var(--dim)", flex: "none" }} />
                      <span className="flex-1 min-w-0 truncate">{p.name}</span>
                      <span style={{ color: "var(--faint)", fontSize: "var(--ui-fs-sm)", flex: "none" }}>
                        {p.role === "host" ? t("collab.roleHost") : p.readOnly ? t("collab.roleReadOnly") : t("collab.roleGuest")}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
          {dialogError && (
            <div style={{ color: "var(--err)", fontSize: "var(--ui-fs-sm)", marginTop: "12px", userSelect: "text" }}>{dialogError}</div>
          )}
        </div>

        <DialogFooter className="confirm-actions" style={{ marginTop: "16px" }}>
          <button className="confirm-btn" onClick={close}>{t("common.close")}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
