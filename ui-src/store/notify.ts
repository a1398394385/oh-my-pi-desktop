// Desktop alerts (system notification + alert sound; both toggled in
// settings ▸ Interaction, duplicated events → 10s dedupe), split from
// store/session.ts for its architecture line cap. Closes over useAppStore at
// runtime only — ESM-cycle safe, same pattern as queue-actions.ts.
import { useAppStore } from "./index";
import { invoke } from "./ws";
import { t } from "../i18n";
import type { OpenSession } from "../types/session";

const notifyLastAt = new Map<string, number>();
// Dedupe window: entries older than this are semantically dead; the map is pruned back to
// live entries once it outgrows the cap (unbounded growth otherwise: one key per session×kind)
const NOTIFY_DEDUPE_MS = 10_000;
const NOTIFY_LASTAT_MAX = 64;
// Event kind → the base settings id gating it (the Notifications group rendered on the
// Interaction page from the base schema). Defaults mirror the base registry:
// completion/ask notify on, error notify off.
const NOTIFY_KIND_SETTING: Record<string, string> = {
  turn_end: "completion.notify",
  error: "error.notify",
  approval: "ask.notify",
};
export function notifyDesktop(kind: string, s: OpenSession, title: string, body: string): void {
  const st = useAppStore.getState();
  const settingId = NOTIFY_KIND_SETTING[kind];
  if (settingId) {
    const v = st.hostSettings?.values?.[settingId];
    if (settingId === "error.notify" ? v !== "on" : v === "off") return;
  }
  const now = Date.now();
  const key = `${s.sessionId}:${kind}`;
  if (now - (notifyLastAt.get(key) ?? 0) < NOTIFY_DEDUPE_MS) return;
  if (notifyLastAt.size > NOTIFY_LASTAT_MAX) {
    for (const [k, at] of notifyLastAt) {
      if (now - at >= NOTIFY_DEDUPE_MS) notifyLastAt.delete(k);
    }
  }
  notifyLastAt.set(key, now);
  if (!invoke) return; // non-Tauri environment (browser direct-connect debugging): feature absent, skip silently
  const path = [...st.openSessions.entries()].find(([, v]) => v === s)?.[0];
  if (path === st.activePath && document.hasFocus()) return; // the user is already looking at this session
  if (st.uiPrefs.notifySound !== false) {
    invoke("play_alert_sound").catch((err: unknown) => console.warn("play_alert_sound:", err));
  }
  if (st.uiPrefs.notifyDesktop !== false) {
    // macOS rejects the request with a reason when the app lacks notification
    // authorization (unsigned build, permission denied): keep it in the console
    // instead of dropping it silently.
    invoke("send_desktop_notification", { title, body, path }).catch((err: unknown) =>
      console.warn("send_desktop_notification:", err),
    );
  }
}

/** Alert title for a session: its on-disk list title, else the generic label. */
export function alertTitle(s: OpenSession): string {
  const st = useAppStore.getState();
  return st.diskProjects.flatMap((pr) => pr.sessions).find((x) => x.id === s.sessionId)?.title || t("notify.bgSessionTitle");
}
