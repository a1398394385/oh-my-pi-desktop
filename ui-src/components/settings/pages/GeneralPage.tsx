// Settings page: general (pg-general). Profile switching / UI language / theme / network env
// vars / updates & behavior.
// Old reference: <div class="set-page" id="pg-general"> in git show 464131d:ui/index.html,
// bindings per initSettings / applyHostSettings / saveDesktopField in ui/settings/index.js.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { saveUiPrefs, saveUiLocale } from "../../../appearance";
import i18next, { type AppLang } from "../../../i18n";
import { IS_MAC } from "../../../platform";
import { invoke } from "../../../store/ws";
import { Sel, Srow, useDropdownClose } from "../common";
import { formatBytes } from "../stats/data/formatters";
import type { DesktopEnv } from "../../../types/frames";

// Native names for the language badge and picker labels (never translated)
const LANG_NATIVE: Record<AppLang, string> = { "zh-CN": "简体中文", en: "English" };

// ---------- Terminal font picker: .sel trigger + filtered, self-previewing menu ----------
// The family list comes from the Tauri `list_font_families` command (system
// enumeration, cached at module level — it cannot change within a run). When
// the command is unavailable (browser preview) or fails, the picker swaps
// itself for the passed free-text fallback so a typo-prone path still exists.
let fontListCache: string[] | null | undefined; // undefined = never asked, null = failed

function FontPicker({ value, onPick, fallback }: { value: string; onPick: (v: string) => void; fallback: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [fonts, setFonts] = useState<string[] | null | undefined>(fontListCache);
  const [filter, setFilter] = useState("");
  useDropdownClose(open, () => { setOpen(false); setFilter(""); });
  // Lazy load on first open (trigger click is a user gesture, so the invoke
  // lands outside of any startup burst); a failure pins the fallback.
  useEffect(() => {
    if (!open || fonts !== undefined) return;
    if (!invoke) {
      fontListCache = null;
      setFonts(null);
      return;
    }
    invoke("list_font_families").then(
      (list: unknown) => {
        fontListCache = Array.isArray(list) ? (list as string[]) : null;
        setFonts(fontListCache);
      },
      () => {
        fontListCache = null;
        setFonts(null);
        toast(t("settingsPage.general.terminalFontLoadFail"));
      },
    );
  }, [open, fonts, t]);

  if (fonts === null) return <>{fallback}</>;
  const lower = filter.trim().toLowerCase();
  const hits = (fonts ?? []).filter((f) => !lower || f.toLowerCase().includes(lower));
  const cssFamily = (name: string) => `"${name.replace(/"/g, '\\"')}", monospace`;
  return (
    <div
      className="sel"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      {value || t("settingsPage.general.terminalFontDefault")} <Icon name="caret" size={14} className="caret-svg" />
      <div className={"menu fm-menu" + (open ? " open" : "")} onClick={(e) => e.stopPropagation()}>
        <input
          className="inp fm-filter"
          placeholder={t("settingsPage.general.terminalFontFilterPh")}
          value={filter}
          autoFocus
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="fm-list">
          {!lower && (
            <div className="mi" onClick={() => { setOpen(false); setFilter(""); onPick(""); }}>
              <span className="ck">{value ? "" : "✓"}</span>
              {t("settingsPage.general.terminalFontDefault")}
            </div>
          )}
          {fonts === undefined ? (
            <div className="mi empty">{t("common.loading")}</div>
          ) : hits.length === 0 ? (
            <div className="mi empty">{t("settingsPage.general.terminalFontNoMatch")}</div>
          ) : (
            hits.map((f) => (
              <div
                key={f}
                className="mi"
                style={{ fontFamily: cssFamily(f) }}
                onClick={() => { setOpen(false); setFilter(""); onPick(f); }}
              >
                <span className="ck">{value === f ? "✓" : ""}</span>
                {f}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- App update row (check / download / restart) ----------
// Backed by the Rust `update_check` / `update_install` / `update_relaunch` commands
// (src-tauri/src/update.rs) rather than the updater plugin's JS API: this frontend
// runs on the withGlobalTauri globals and does not bundle @tauri-apps/*, and the
// plugin's download progress arrives over an IPC Channel that would have to be
// hand-built here. Download progress instead arrives as a `update-progress` event,
// the same shape the audio spectrum uses.
type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "installed" | "uptodate";

interface UpdateInfoShape {
  version: string;
  currentVersion: string;
  body: string;
  date?: string | null;
  available: boolean;
}

interface UpdateProgressShape {
  downloaded: number;
  total?: number | null;
  finished: boolean;
}

function UpdateRow() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [info, setInfo] = useState<UpdateInfoShape | null>(null);
  const [progress, setProgress] = useState<UpdateProgressShape | null>(null);

  // Subscribed for the whole row lifetime: the shell is only ~150 MB and a check
  // that starts a download right after mounting would otherwise miss the first
  // chunks. Unsubscribed on unmount so a page switch stops the traffic.
  useEffect(() => {
    const events = window.__TAURI__?.event;
    if (!events?.listen) return;
    const offs = Promise.all([
      events.listen("update-progress", (e) => setProgress(e.payload as UpdateProgressShape)),
      events.listen("update-installed", () => setPhase("installed")),
    ]);
    return () => {
      offs.then((list) => list.forEach((off) => (off as () => void)()));
    };
  }, []);

  const check = async () => {
    if (!invoke) {
      toast(t("settingsPage.general.updateUnsupported"));
      return;
    }
    setPhase("checking");
    setProgress(null);
    try {
      const found = (await invoke("update_check")) as UpdateInfoShape;
      setInfo(found);
      setPhase(found.available ? "available" : "uptodate");
      if (!found.available) toast(t("settingsPage.general.updateUpToDate", { version: found.currentVersion }));
    } catch (err) {
      setPhase("idle");
      toast(t("settingsPage.general.updateFailed", { error: String(err) }));
    }
  };

  const install = async () => {
    if (!invoke) {
      toast(t("settingsPage.general.updateUnsupported"));
      return;
    }
    setPhase("downloading");
    setProgress(null);
    try {
      await invoke("update_install");
      // Windows quits during install and never returns here; macOS/Linux land on
      // the `update-installed` event instead.
      setPhase("installed");
    } catch (err) {
      setPhase(info?.available ? "available" : "idle");
      toast(t("settingsPage.general.updateInstallFailed", { error: String(err) }));
    }
  };

  const restart = () => invoke?.("update_relaunch");

  const busy = phase === "checking" || phase === "downloading";

  return (
    <div className="srow set-row">
      <div className="srow-tx">
        <b>{t("settingsPage.general.updateTitle")}</b>
        <span>
          {phase === "uptodate"
            ? t("settingsPage.general.updateUpToDate", { version: info?.currentVersion ?? "" })
            : phase === "available"
              ? t("settingsPage.general.updateAvailable", { version: info?.version ?? "" })
              : t("settingsPage.general.updateDesc", { version: info?.currentVersion ?? "—" })}
        </span>
        {info?.available && info.body && <div className="up-notes">{info.body}</div>}
      </div>
      <div className="srow-ctl" style={{ gap: 8 }}>
        {phase === "downloading" && (
          <>
            <span className="up-bar">
              <i
                style={{
                  width: progress?.total ? `${Math.min(100, (progress.downloaded / progress.total) * 100)}%` : "100%",
                }}
              />
            </span>
            {/* Total half omitted when the server sends no Content-Length */}
            <span className="up-size">
              {progress
                ? progress.total
                  ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
                  : formatBytes(progress.downloaded)
                : t("settingsPage.general.updateDownloading")}
            </span>
          </>
        )}
        {phase === "available" && (
          <button className="save-btn" onClick={install}>{t("settingsPage.general.updateDownload")}</button>
        )}
        {phase === "installed" && (
          <button className="save-btn" onClick={restart}>{t("settingsPage.general.updateRestart")}</button>
        )}
        <button className="save-btn" disabled={busy} onClick={check}>
          {phase === "checking"
            ? t("settingsPage.general.updateChecking")
            : phase === "downloading"
              ? t("settingsPage.general.updateDownloading")
              : t("settingsPage.general.updateCheck")}
        </button>
      </div>
    </div>
  );
}

// ---------- macOS system permissions card ----------
// Status comes from the Rust `system_permission_status` command (prompt-free
// TCC preflights); each row's button jumps to the matching System Settings
// pane via `open_permission_setting`. Granted rows swap the button for a
// non-interactive "Granted" badge. Re-queried on window focus so toggling a
// permission in System Settings is reflected the moment the app is fronted.
interface PermissionStatusShape {
  accessibility: boolean;
  screen_capture: boolean;
  full_disk_access: boolean;
}

type PermKey = keyof PermissionStatusShape;

function PermissionsCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PermissionStatusShape | null>(null);

  useEffect(() => {
    const inv = invoke; // local capture: TS keeps the null-narrowing inside the refresh closure
    if (!inv) return;
    const refresh = () => {
      inv("system_permission_status")
        .then((s) => setStatus(s as PermissionStatusShape))
        .catch((err: unknown) => console.warn("system_permission_status:", err));
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  // Browser preview (no Tauri shell): nothing can be queried or opened, so the
  // whole group stays hidden instead of showing three dead rows.
  if (!invoke) return null;

  const rows: { key: PermKey; title: string; desc: string }[] = [
    { key: "accessibility", title: t("settingsPage.general.permAccessibilityTitle"), desc: t("settingsPage.general.permAccessibilityDesc") },
    { key: "screen_capture", title: t("settingsPage.general.permScreenTitle"), desc: t("settingsPage.general.permScreenDesc") },
    { key: "full_disk_access", title: t("settingsPage.general.permFdaTitle"), desc: t("settingsPage.general.permFdaDesc") },
  ];
  const inv = invoke; // local capture: TS keeps the null-narrowing inside openPanel
  const openPanel = (panel: string) => {
    inv("open_permission_setting", { panel }).catch((err: unknown) =>
      toast(t("settingsPage.general.permOpenFailed", { error: String(err) })),
    );
  };

  return (
    <>
      <div className="set-group-tt">{t("settingsPage.general.groupPermissions")}</div>
      <div className="set-card">
        {rows.map((row) => {
          const granted = status ? status[row.key] : false;
          return (
            <Srow key={row.key} title={row.title} desc={row.desc}>
              {granted ? (
                <span className="save-btn perm-ok">{t("settingsPage.general.permGranted")}</span>
              ) : (
                <button className="save-btn" disabled={!status} onClick={() => openPanel(row.key)}>
                  {status ? t("settingsPage.general.permOpen") : t("settingsPage.general.permChecking")}
                </button>
              )}
            </Srow>
          );
        })}
      </div>
    </>
  );
}

export default function GeneralPage() {
  const hs = useAppStore((s) => s.hostSettings); // selector subscription refreshes on replies
  const { t } = useTranslation();
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const env: DesktopEnv = hs?.desktopEnv ?? { httpProxy: "", noProxy: "", caCerts: "" }; // fallback before the first frame, same as the old {} semantics

  // ---------- Local form state ----------
  const proxyRef = useRef<HTMLInputElement>(null);
  const noProxyRef = useRef<HTMLInputElement>(null);
  const caRef = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const [proxy, setProxy] = useState(env.httpProxy || "");
  const [noProxy, setNoProxy] = useState(env.noProxy || "");
  const [ca, setCa] = useState(env.caCerts || "");
  const [askTimeout, setAskTimeout] = useState(hs?.values?.["ask.timeout"] ? String(hs.values["ask.timeout"]) : "");
  // Refill after the host settings reply (never disturb focused inputs; the fill guard of the old applyHostSettings)
  useEffect(() => {
    const e2: DesktopEnv = hs?.desktopEnv ?? { httpProxy: "", noProxy: "", caCerts: "" };
    if (document.activeElement !== proxyRef.current) setProxy(e2.httpProxy || "");
    if (document.activeElement !== noProxyRef.current) setNoProxy(e2.noProxy || "");
    if (document.activeElement !== caRef.current) setCa(e2.caCerts || "");
    if (document.activeElement !== askRef.current) {
      setAskTimeout(hs?.values?.["ask.timeout"] ? String(hs.values["ask.timeout"]) : "");
    }
  }, [hs]);
  const [terminalInherit, setTerminalInherit] = useState(
    useAppStore.getState().uiPrefs.terminalInheritProfile !== false
  );
  const [terminalFont, setTerminalFont] = useState(
    useAppStore.getState().uiPrefs.terminalFont || ""
  );
  const [terminalFontSize, setTerminalFontSize] = useState(
    useAppStore.getState().uiPrefs.terminalFontSize ?? 13
  );
  const termFontRef = useRef<HTMLInputElement>(null);

  // ---------- Interaction ----------
  const switchProfile = (name: string) => {
    const target = String(name || "").trim();
    if (!target) return;
    toast(t("settingsPage.general.switchingProfile", { name: target }));
    send({ type: "switch_profile", profile: target });
    // Re-send the locale after a profile switch: the host re-reads the new
    // profile's config on switch, so push the frontend's language preference
    // again to keep the host aligned. WS is ordered — set_locale lands after
    // the switch_profile handling.
    send({ type: "set_locale", lang: useAppStore.getState().uiPrefs.lang });
  };
  const newProfile = () => {
    const input = window.prompt(t("settingsPage.general.newProfilePrompt"));
    if (!input) return;
    const name = input.trim();
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      toast(t("settingsPage.general.profileNameInvalid"));
      return;
    }
    switchProfile(name);
  };
  const toggleTerminalInherit = () => {
    const next = !terminalInherit;
    setTerminalInherit(next);
    useAppStore.setState((st) => ({
      uiPrefs: { ...st.uiPrefs, terminalInheritProfile: next },
    }));
    saveUiPrefs();
    toast(next ? t("settingsPage.general.terminalInheritOn") : t("settingsPage.general.terminalInheritOff"));
  };
  const saveTerminalFont = () => {
    const f = terminalFont.trim();
    useAppStore.setState((st) => ({
      uiPrefs: { ...st.uiPrefs, terminalFont: f },
    }));
    saveUiPrefs();
    toast(f ? t("settingsPage.general.terminalFontSaved", { font: f }) : t("settingsPage.general.terminalFontReset"));
  };
  // Font picker select: same persistence as the free-text save, minus the trim
  // (the picker hands over exact family names).
  const pickTerminalFont = (f: string) => {
    setTerminalFont(f);
    useAppStore.setState((st) => ({
      uiPrefs: { ...st.uiPrefs, terminalFont: f },
    }));
    saveUiPrefs();
    toast(f ? t("settingsPage.general.terminalFontSaved", { font: f }) : t("settingsPage.general.terminalFontReset"));
  };
  const pickTerminalFontSize = (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 10 || n > 20) return;
    setTerminalFontSize(n);
    useAppStore.setState((st) => ({
      uiPrefs: { ...st.uiPrefs, terminalFontSize: n },
    }));
    saveUiPrefs();
    toast(t("settingsPage.general.terminalFontSizeSaved", { size: n }));
  };
  // Language switch: persist to uiPrefs, switch i18next, notify the host.
  // <App key={lang}> in main.tsx re-mounts the tree, so the new locale applies
  // immediately without a restart.
  const pickLang = (v: string) => {
    if (v !== "zh-CN" && v !== "en") return;
    if (v === useAppStore.getState().uiPrefs.lang) return;
    useAppStore.setState((st) => ({ uiPrefs: { ...st.uiPrefs, lang: v } }));
    saveUiLocale();
    void i18next.changeLanguage(v);
    send({ type: "set_locale", lang: v });
    // Rebuild the native menu with the new locale (no-op outside Tauri).
    invoke?.("set_menu_language", { lang: v })?.catch((err: unknown) =>
      console.warn("set_menu_language:", err),
    );
  };
  // Network trio: send the whole desktopEnv package (old saveDesktopField semantics)
  const saveEnv = (field: string, val: string) => {
    const merged = { httpProxy: proxy, noProxy: noProxy, caCerts: ca, [field]: val };
    send({ type: "set_desktop_env", ...merged });
  };
  const saveAskTimeout = () => {
    const raw = parseFloat(askTimeout);
    const secs = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    send({ type: "set_setting", key: "ask.timeout", value: secs });
    toast(t("settingsPage.general.askTimeoutSaved", { secs, suffix: secs === 0 ? t("settingsPage.general.neverTimeout") : "" }));
  };

  // ---------- Profile dropdown data (data contract: hostSettings.availableProfiles: string[]) ----------
  const activeProfile = hs?.activeProfile || "default";
  const profiles = Array.isArray(hs?.availableProfiles) && hs.availableProfiles.length
    ? hs.availableProfiles
    : [activeProfile];
  const profileDesc = hs?.profileAgentDir
    ? t("settingsPage.general.profileDescDir", { dir: hs.profileAgentDir })
    : t("settingsPage.general.profileDescDefault");

  return (
    <div className="set-page" id="pg-general">
      <div className="set-tt">{t("settingsPage.nav.general")} <span className="stag" id="langTag">{LANG_NATIVE[lang]}</span></div>
      <div className="set-group-tt">{t("settingsPage.general.groupProfile")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.currentProfile")}</b><span id="profilePathDesc">{profileDesc}</span></div>
          <div className="srow-ctl" style={{ gap: 8 }}>
            <Sel
              label={activeProfile}
              dataSel={activeProfile}
              options={profiles.map((p) => ({
                v: p,
                label: p === "default" ? t("settingsPage.general.profileDefaultEntry") : p,
                ck: p === activeProfile ? "✓" : "",
              }))}
              onPick={(p) => { if (p !== activeProfile) switchProfile(p); }}
            />
            <button className="save-btn" id="newProfileBtn" title={t("settingsPage.general.newProfileTitle")} onClick={newProfile}>{t("settingsPage.general.newProfileBtn")}</button>
          </div>
        </div>
      </div>
      <div className="set-group-tt">{t("settingsPage.general.groupApp")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("common.languageLabel")}</b><span>{t("settingsPage.general.langDesc")}</span></div>
          <Sel
            label={LANG_NATIVE[lang]}
            dataSel={LANG_NATIVE[lang]}
            options={[
              { v: "zh-CN", label: "简体中文", ck: lang === "zh-CN" ? "✓" : "" },
              { v: "en", label: "English", ck: lang === "en" ? "✓" : "" },
            ]}
            onPick={pickLang}
          />
        </div>
        <UpdateRow />
      </div>
      <div className="set-group-tt">{t("settingsPage.general.groupTerminal")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.general.terminalInheritTitle")}</b>
            <span>{t("settingsPage.general.terminalInheritDesc")}</span>
          </div>
          <div className={"tg" + (terminalInherit ? " on" : "")} id="tgTerminalInherit" onClick={toggleTerminalInherit}>
            <i></i>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.general.terminalFontTitle")}</b>
            <span>{t("settingsPage.general.terminalFontDesc")}</span>
          </div>
          <div className="srow-ctl">
            <FontPicker
              value={terminalFont}
              onPick={pickTerminalFont}
              fallback={
                <>
                  <input
                    className="inp"
                    id="termFontInput"
                    placeholder='ui-monospace, "SF Mono", Menlo, monospace'
                    value={terminalFont}
                    ref={termFontRef}
                    onChange={(e) => setTerminalFont(e.target.value)}
                  />
                  <button className="save-btn" id="termFontSave" onClick={saveTerminalFont}>{t("common.save")}</button>
                </>
              }
            />
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.general.terminalFontSizeTitle")}</b>
            <span>{t("settingsPage.general.terminalFontSizeDesc")}</span>
          </div>
          <Sel
            label={`${terminalFontSize} px`}
            dataSel={`${terminalFontSize} px`}
            options={[10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((n) => ({
              v: String(n),
              label: `${n} px`,
              ck: n === terminalFontSize ? "✓" : "",
            }))}
            onPick={pickTerminalFontSize}
          />
        </div>
      </div>
      <div className="set-group-tt">{t("settingsPage.general.groupNetwork")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.httpProxyTitle")}</b><span>{t("settingsPage.general.httpProxyDesc")}</span></div>
          <div className="srow-ctl">
            <input className="inp" id="proxyInput" placeholder={t("settingsPage.general.httpProxyPlaceholder")} value={proxy} ref={proxyRef}
              onChange={(e) => setProxy(e.target.value)} />
            <button className="save-btn" id="proxySave" onClick={() => saveEnv("httpProxy", proxy.trim())}>{t("common.save")}</button>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.noProxyTitle")}</b><span>{t("settingsPage.general.noProxyDesc")}</span></div>
          <div className="srow-ctl">
            <input className="inp" id="noProxyInput" placeholder="localhost,127.0.0.1,::1" value={noProxy} ref={noProxyRef}
              onChange={(e) => setNoProxy(e.target.value)} />
            <button className="save-btn" id="noProxySave" onClick={() => saveEnv("noProxy", noProxy.trim())}>{t("common.save")}</button>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.caTitle")}</b><span>{t("settingsPage.general.caDesc")}</span></div>
          <div className="srow-ctl">
            <input className="inp" id="caInput" placeholder={t("settingsPage.general.caPlaceholder")} value={ca} ref={caRef}
              onChange={(e) => setCa(e.target.value)} />
            <button className="save-btn" id="caSave" onClick={() => saveEnv("caCerts", ca.trim())}>{t("common.save")}</button>
          </div>
        </div>
      </div>
      <div className="set-group-tt">{t("settingsPage.general.groupBehavior")}</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.general.askTimeoutTitle")}</b><span>{t("settingsPage.general.askTimeoutDesc")}</span></div>
          <div className="srow-ctl">
            <input className="inp" id="askTimeoutInput" type="number" min="0" step="1" placeholder="0" value={askTimeout} ref={askRef}
              onChange={(e) => setAskTimeout(e.target.value)} />
            <button className="save-btn" id="askTimeoutSave" onClick={saveAskTimeout}>{t("common.save")}</button>
          </div>
        </div>
      </div>
      {IS_MAC && <PermissionsCard />}
      <SchemaRows sections={PAGE_PLACEMENT["pg-general"]} />
    </div>
  );
}
