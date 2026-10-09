// Settings page: computer & browser control (pg-computer). The master toggle writes host
// computer.enabled (gate semantics: see host/rpc/prompt.ts /computer dispatch);
// the display dropdown enumerates physical displays via list_displays and
// writes computer.display. computer.enabled / computer.display are excluded
// from SchemaRows via SPECIAL_KEY_PAGES and rendered here; browser.enabled is
// the browser capability's plain config switch (the base reconciles the eval
// prelude live, no per-session opt-in) and is likewise rendered here.
// Old reference: <div class="set-page" id="pg-computer"> in git show 464131d:ui/index.html,
// binding per wireToggle("tgComputer") in ui/settings/index.js initSettings.
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import SchemaRows, { SchemaRowsBare, SchemaGroupTitle } from "../SchemaRows";
import { PAGE_PLACEMENT, type Section } from "../placement";
import { claimDropdown, releaseDropdown } from "../../../lib/dropdownExclusive";
import { IS_MAC } from "../../../platform";

// This page owns the layout of both its sections (Section.id): each one is a
// group heading + exactly one rounded card. The computer card starts with the
// master switch / display / screenshot-size rows, the browser card with its own
// master switch followed by the browser.* rows.
const SECTION_COMPUTER = (PAGE_PLACEMENT["pg-computer"] ?? []).filter((s) => s.id === "computer");
const SECTION_BROWSER = (PAGE_PLACEMENT["pg-computer"] ?? []).filter((s) => s.id === "browser");
// External routes (relay + cdpUrl): not a placement section — they are pulled
// out of the browser group at render time so the switch can gate them
const EXTERNAL_KEYS = ["browser.relay", "browser.relayUrl", "browser.cdpUrl"];
const SECTION_EXTERNAL: Section[] = [{ keys: EXTERNAL_KEYS }];
const OTHER_SECTIONS = (PAGE_PLACEMENT["pg-computer"] ?? []).filter((s) => !s.id);

interface SelOption {
  v: string;
  label: ReactNode;
  ck?: string;
  sub?: string;
  disabled?: boolean;
}

// Dropdown selector: same markup language as AppearancePage's Sel (controlled .sel)
function Sel({ label, options, onPick }: { label: ReactNode; options: SelOption[]; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    claimDropdown(close);
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("click", close);
      releaseDropdown(close);
    };
  }, [open]);
  return (
    <div
      className="sel"
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      {label} <Icon name="caret" size={14} className="caret-svg" />
      <div className={"menu" + (open ? " open" : "")}>
        {options.map((o) => (
          <div
            key={o.v}
            className={"mi" + (o.disabled ? " disabled" : "")}
            onClick={(e) => {
              e.stopPropagation();
              if (o.disabled) return;
              setOpen(false);
              onPick(o.v);
            }}
          >
            {o.ck !== undefined && <span className="ck">{o.ck}</span>}
            {o.label}
            {o.sub && <span className="sub">{o.sub}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ComputerPage() {
  const { t } = useTranslation();
  const hs = useAppStore((s) => s.hostSettings);
  const displaysFrame = useAppStore((s) => s.computerDisplays);
  const [on, setOn] = useState(!!hs?.computerEnabled); // boolean initial value, type inferable
  // browser.enabled reads straight off the values map (no dedicated frame field,
  // unlike computerEnabled); undefined until the settings reply lands
  const [browserOn, setBrowserOn] = useState<boolean | null>(null);
  // "Use an external browser" is a desktop-owned switch (omp-desktop.json's
  // browser.external, host/browser-config.ts), not a base setting: the host
  // pins browser.relay/cdpUrl off while it is false, so a browser configured in
  // config.yml cannot outrank the desktop default. It surfaces in the frame as a
  // dedicated field; undefined until the first settings reply lands.
  const [externalOn, setExternalOn] = useState(false);
  const [spin, setSpin] = useState(false);
  // Sync the toggle state after the settings reply
  useEffect(() => {
    setOn(!!useAppStore.getState().hostSettings?.computerEnabled);
  }, [hs]);
  useEffect(() => {
    const v = useAppStore.getState().hostSettings?.values ?? {};
    const en = v["browser.enabled"];
    setBrowserOn(typeof en === "boolean" ? en : null);
    setExternalOn(useAppStore.getState().hostSettings?.externalBrowserEnabled === true);
  }, [hs]);
  // Detect displays on first entry (refresh re-requests)
  useEffect(() => {
    if (!useAppStore.getState().computerDisplays) send({ type: "list_displays" });
  }, []);
  const toggle = (): void => {
    const next = !on;
    setOn(next);
    send({ type: "set_setting", key: "computer.enabled", value: next });
    toast(t("settingsPage.computer.writtenToast"));
  };
  // browser.enabled is a plain config switch: the base reconciles the eval
  // prelude and MCP filter live, no per-session /command opt-in involved
  const toggleBrowser = (): void => {
    if (browserOn === null) return;
    const next = !browserOn;
    setBrowserOn(next);
    send({ type: "set_setting", key: "browser.enabled", value: next });
  };
  // One RPC: the host persists the switch and re-applies the relay/cdpUrl pins,
  // then answers with a settings frame carrying the state the base ended up in
  const toggleExternal = (): void => {
    const next = !externalOn;
    setExternalOn(next);
    send({ type: "set_external_browser", enabled: next });
  };
  const refresh = (): void => {
    setSpin(true);
    send({ type: "list_displays" });
    setTimeout(() => setSpin(false), 600);
  };
  // Screen capture sits behind a macOS TCC grant; the host reports the
  // non-prompting preflight label with every displays reply, so the shortcut
  // below shows up only when the grant is actually missing. The grant is made
  // in System Settings — the host opens the exact pane (a fresh grant needs an
  // app restart before this process's preflight flips to granted).
  const captureDenied = IS_MAC && displaysFrame?.capturePermission === "denied";
  const grantCapture = (): void => {
    send({ type: "open_screen_recording_settings" });
    toast(t("settingsPage.computer.permissionToast"));
  };

  const displays = displaysFrame?.displays ?? [];
  const cur = typeof hs?.values?.["computer.display"] === "string" ? (hs.values["computer.display"] as string) : "all";
  const curKnown = cur === "all" || displays.some((d) => d.id === cur);
  const optionLabel = (v: string): ReactNode => {
    if (v === "all") return t("settingsPage.computer.allDisplays");
    const d = displays.find((x) => x.id === v);
    if (d) return `${d.name} · ${d.width}×${d.height}${d.isPrimary ? ` · ${t("settingsPage.computer.primaryTag")}` : ""}`;
    return `${v} · ${t("settingsPage.computer.notDetected")}`;
  };
  const options: SelOption[] = [
    { v: "all", label: optionLabel("all"), ck: cur === "all" ? "✓" : undefined },
    ...displays.map((d) => ({ v: d.id, label: optionLabel(d.id), ck: cur === d.id ? "✓" : undefined })),
  ];
  if (!curKnown) options.push({ v: cur, label: optionLabel(cur), ck: "✓", disabled: true });

  return (
    <div className="set-page" id="pg-computer">
      <div className="set-tt">
        {t("settingsPage.nav.computer")}
        <button type="button" className={"icon-btn pg-refresh" + (spin ? " spin" : "")} onClick={refresh} title={t("settingsPage.model.refresh")}>
          <Icon name="refresh" size={17} />
        </button>
      </div>
      <SchemaGroupTitle sections={SECTION_COMPUTER} />
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.computer.enableTitle")}</b><span>{t("settingsPage.computer.enableDesc")}</span></div>
          <div className={"tg" + (on ? " on" : "")} id="tgComputer" onClick={toggle}><i></i></div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.computer.displayTitle")}</b><span>{t("settingsPage.computer.displayDesc")}</span></div>
          <Sel
            label={optionLabel(cur)}
            options={options}
            onPick={(v) => send({ type: "set_setting", key: "computer.display", value: v })}
          />
        </div>
        {captureDenied && (
          <div className="srow set-row">
            <div className="srow-tx"><b>{t("settingsPage.computer.permissionTitle")}</b><span>{t("settingsPage.computer.permissionDesc")}</span></div>
            <div className="srow-ctl">
              <button type="button" className="save-btn" id="crGrant" onClick={grantCapture}>{t("settingsPage.computer.permissionBtn")}</button>
            </div>
          </div>
        )}
        <SchemaRowsBare sections={SECTION_COMPUTER} />
      </div>
      <SchemaGroupTitle sections={SECTION_BROWSER} />
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.browser.enableTitle")}</b><span>{t("settingsPage.browser.enableDesc")}</span></div>
          <div className={"tg" + (browserOn ? " on" : "")} id="tgBrowser" onClick={toggleBrowser}><i></i></div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.browser.externalTitle")}</b><span>{t("settingsPage.browser.externalDesc")}</span></div>
          <div className={"tg" + (externalOn ? " on" : "")} id="tgBrowserExternal" onClick={toggleExternal}><i></i></div>
        </div>
        {externalOn && (
          // External routes revealed inline (mem-expand language: rows expand
          // downward inside the same card, no modal)
          <div className="ext-rows">
            <SchemaRowsBare sections={SECTION_EXTERNAL} />
          </div>
        )}
        <SchemaRowsBare sections={SECTION_BROWSER} />
      </div>
      <SchemaRows sections={OTHER_SECTIONS} />
    </div>
  );
}
