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
import { Sel, Srow, type SelOption } from "../common";
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
  const [defaultOn, setDefaultOn] = useState(false);
  const [spin, setSpin] = useState(false);
  // Sync the toggle state after the settings reply
  useEffect(() => {
    setOn(!!useAppStore.getState().hostSettings?.computerEnabled);
    setDefaultOn(useAppStore.getState().hostSettings?.computerDefaultEnabled === true);
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
  // Desktop-owned "default on" switch: fresh sessions start opted in. Nothing
  // live changes — the host reads it at spawn only.
  const toggleDefault = (): void => {
    const next = !defaultOn;
    setDefaultOn(next);
    send({ type: "set_computer_default", enabled: next });
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
  // Computer-use provider pick (omp-desktop.json computer.provider): the Kimi
  // option is disabled while KimiCU is absent; the kimi-cu server definition
  // itself is code-owned (host/mcp-builtin.ts, never in mcp.json), so the
  // button next to the dropdown is a connection test, not a config writer
  const provider = hs?.computerProvider === "kimi" ? "kimi" : "default";
  const kimiInstalled = hs?.kimiCuInstalled === true;
  const providerOptions: SelOption[] = [
    {
      v: "default",
      label: t("settingsPage.computer.providerDefaultName"),
      note: t("settingsPage.computer.providerDefaultNote"),
      ck: provider === "default" ? "✓" : undefined,
    },
    {
      v: "kimi",
      label: t("settingsPage.computer.providerKimiName"),
      // Installed: note names the backend; missing: disabled row — the ✕ in the
      // check column and the gray text carry the "not detected" signal, no note needed
      note: kimiInstalled ? t("settingsPage.computer.providerKimiNote") : undefined,
      ck: provider === "kimi" ? "✓" : undefined,
      disabled: !kimiInstalled,
    },
  ];
  const testKimi = (): void => {
    // Result toast arrives on the standard mcp_server_tested frame
    send({ type: "test_kimi_cu" });
  };
  const cur = typeof hs?.values?.["computer.display"] === "string" ? (hs.values["computer.display"] as string) : "all";
  const curKnown = cur === "all" || displays.some((d) => d.id === cur);
  // Trigger pill keeps the compact "name · WxH" form; the menu rows below use the
  // two-line layout (index + name on top, resolution as the note)
  const optionLabel = (v: string): ReactNode => {
    if (v === "all") return t("settingsPage.computer.allDisplays");
    const d = displays.find((x) => x.id === v);
    if (d) return `${d.name} · ${d.width}×${d.height}`;
    return `${v} · ${t("settingsPage.computer.notDetected")}`;
  };
  const options: SelOption[] = [
    { v: "all", label: t("settingsPage.computer.allDisplays"), ck: cur === "all" ? "✓" : undefined },
    ...displays.map((d, i) => ({
      v: d.id,
      label: `${t("settingsPage.computer.displayIndex", { n: i + 1 })} · ${d.name}`,
      note: `${d.width}×${d.height}`,
      ck: cur === d.id ? "✓" : undefined,
    })),
  ];
  if (!curKnown) {
    // The stored id no longer resolves (monitor replaced / reboot reassigned the
    // handle): keep it visible as a disabled row — ✕ + "not detected" note — so the
    // user can see what the stale value was and switch away
    options.push({ v: cur, label: cur, ck: "✓", disabled: true, note: t("settingsPage.computer.notDetected") });
  }

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
          <div className="srow-tx"><b>{t("settingsPage.computer.defaultTitle")}</b><span>{t("settingsPage.computer.defaultDesc")}</span></div>
          <div className={"tg" + (defaultOn ? " on" : "")} id="tgComputerDefault" onClick={toggleDefault}><i></i></div>
        </div>
        <div className="srow">
          <div className="srow-tx"><b>{t("settingsPage.computer.providerTitle")}</b><span>{t("settingsPage.computer.providerDesc")}</span></div>
          <div className="srow-ctl">
            {/* Test button appears only with the Kimi provider picked, sitting
                left of the dropdown: one click warms/probes the code-owned
                kimi-cu connection; the result toasts via mcp_server_tested. */}
            {provider === "kimi" && (
              <button type="button" className="save-btn" id="kimiCuCfg" onClick={testKimi}>
                {t("settingsPage.computer.testBtn")}
              </button>
            )}
            <Sel
              label={provider === "kimi" ? t("settingsPage.computer.providerKimi") : t("settingsPage.computer.providerDefault")}
              options={providerOptions}
              onPick={(v) => send({ type: "set_computer_provider", provider: v })}
            />
          </div>
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
          <Srow title={t("settingsPage.computer.permissionTitle")} desc={t("settingsPage.computer.permissionDesc")}>
            <button type="button" className="save-btn" id="crGrant" onClick={grantCapture}>{t("settingsPage.computer.permissionBtn")}</button>
          </Srow>
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
