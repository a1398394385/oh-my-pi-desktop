// Desktop-owned browser routing (the `browser` section of omp-desktop.json).
//
// The base resolves a browser through resolveBrowserKind(): explicit app.* →
// relay → browser.cdpUrl → Tern → cmux → a browser OMP launches itself. The
// desktop always wants the last one unless the user opts into an external
// browser, so this module projects a single desktop-owned switch onto the two
// base keys that would otherwise be picked up from wherever they happen to be
// configured (hand-edited config.yml, a previous session, another profile).
//
// Storage: the `browser` section of omp-desktop.json (per profile, same
// ui/keepalive/acp pattern in host/ui-config.ts). The user's own config.yml is
// never rewritten — the switch is applied as a runtime override on top, so
// dropping the switch back off restores exactly the config.yml state instead of
// erasing it.
import { readFileSync, writeFileSync } from "node:fs";
import { H } from "./state.ts";
import { lookupSetting } from "./bootstrap.ts";

// Base keys the desktop switch governs. browser.tern / browser.cmux are not
// touched: they only resolve inside a Tern pane or a cmux socket, neither of
// which exists for a Tauri-hosted process, so they are inert either way.
const RELAY_KEY = "browser.relay";
const CDP_KEY = "browser.cdpUrl";

/** Read omp-desktop.json in full (missing/corrupt file -> empty object, same tolerance as profile.ts). */
function readDesktopJson(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Read the `browser` section (missing/invalid section -> empty object). */
function readSection(): Record<string, unknown> {
  const section = readDesktopJson().browser;
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}

/** Merge-write the `browser` section, preserving other keys of omp-desktop.json and unmentioned fields inside the section. */
function writeSection(section: Record<string, unknown>): void {
  const raw = readDesktopJson();
  writeFileSync(H.desktopProjectsPath, JSON.stringify({ ...raw, browser: section }, null, 2));
}

/**
 * Whether the desktop should route the agent's browser tool to an
 * externally started browser. Missing/invalid value counts as off — only an
 * explicit true opts in, matching readAcpEnabled / readSessionContextEnabled.
 */
export function readExternalBrowserEnabled(): boolean {
  return readSection().external === true;
}

/**
 * Apply the switch to the base settings as a runtime override (never "global",
 * so config.yml is left untouched and turning the switch off restores it).
 * Off: relay is forced false and cdpUrl blanked so neither external route can
 * win, even if the user configured one in config.yml. On: the override is
 * cleared and whatever config.yml holds applies again.
 */
export function applyExternalBrowserSetting(enabled: boolean): void {
  const relay = lookupSetting(RELAY_KEY);
  const cdp = lookupSetting(CDP_KEY);
  if (!relay || !cdp) return;
  if (enabled) {
    H.settings.clearOverrideValue(relay);
    H.settings.clearOverrideValue(cdp);
    return;
  }
  H.settings.writeValue(relay, false, "override");
  H.settings.writeValue(cdp, "", "override");
}

/**
 * Persist the switch and apply it immediately (set_external_browser RPC).
 * Read-merge-write keeps the rest of the browser section and the file intact.
 */
export function writeExternalBrowserEnabled(enabled: boolean): void {
  writeSection({ ...readSection(), external: enabled });
  applyExternalBrowserSetting(enabled);
}
