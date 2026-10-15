// Smoke: the external-browser switch forces the base off a config.yml-configured
// relay/cdpUrl, and releasing it restores the config layer. OMP_PROFILE pins the
// test profile so the developer's default profile is never touched; the base
// settings live in a throwaway agent dir.
//
// Dynamic imports are deliberate here: the env vars below (agent dir) must be
// set before bootstrap/state/browser-config evaluate, and static imports would
// hoist them above the setup.
process.env.OMP_PROFILE = process.env.OMP_PROFILE ?? "omp-desktop-test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "omp-browsercfg-"));
// A config.yml that already configures both external routes, as if the user set
// them up outside the desktop app
writeFileSync(join(agentDir, "config.yml"), 'browser:\n  relay: true\n  cdpUrl: "http://127.0.0.1:9222"\n');
const desktopPath = join(agentDir, "omp-desktop.json");
writeFileSync(desktopPath, JSON.stringify({ ui: { locale: "en" } }, null, 2));

process.env.OMP_AGENT_DIR = agentDir;
const { Settings } = await import("../host/bootstrap.ts");
const { H } = await import("../host/state.ts");
H.desktopProjectsPath = desktopPath;
H.agentDir = agentDir;
H.settings = await Settings.init({ cwd: agentDir, agentDir });

const { readExternalBrowserEnabled, writeExternalBrowserEnabled } = await import("../host/browser-config.ts");
const { settingsGet } = await import("../host/settings-compat.ts");

const relay = (): unknown => settingsGet(H.settings, "browser.relay");
const cdp = (): unknown => settingsGet(H.settings, "browser.cdpUrl");

interface Case { name: string; ok: boolean; actual: unknown; expected: unknown }
const results: Case[] = [];
const check = (name: string, actual: unknown, expected: unknown): void => {
  results.push({ name, ok: actual === expected, actual, expected });
};

// Baseline: config.yml alone would win
check("baseline relay from config.yml", relay(), true);
check("baseline cdpUrl from config.yml", cdp(), "http://127.0.0.1:9222");

// Provenance is the real contract: while the switch is off the values must come
// from the runtime override layer (not merely happen to be false), and
// releasing the switch must hand the keys back to the config layer.
const { lookupSetting } = await import("../host/bootstrap.ts");
const provenance = (key: string): string => H.settings.getProvenance(lookupSetting(key)!).toString();
check("baseline: relay served from the config layer", provenance("browser.relay"), "global");
check("baseline: cdpUrl served from the config layer", provenance("browser.cdpUrl"), "global");

// Switch off (the desktop default) must beat config.yml
writeExternalBrowserEnabled(false);
check("off: relay pinned false", relay(), false);
check("off: cdpUrl blanked", cdp(), "");
check("off: relay served from the runtime override", provenance("browser.relay"), "runtime");
check("off: cdpUrl served from the runtime override", provenance("browser.cdpUrl"), "runtime");
check("off: switch persisted", readExternalBrowserEnabled(), false);
const onDisk = JSON.parse(readFileSync(desktopPath, "utf8")) as { browser?: { external?: boolean }; ui?: { locale?: string } };
check("off: persisted under browser.external", onDisk.browser?.external, false);
check("off: other omp-desktop.json sections preserved", onDisk.ui?.locale, "en");

// Switch on restores the config layer rather than erasing it
writeExternalBrowserEnabled(true);
check("on: relay restored from config.yml", relay(), true);
check("on: cdpUrl restored from config.yml", cdp(), "http://127.0.0.1:9222");
check("on: relay handed back to the config layer", provenance("browser.relay"), "global");
check("on: cdpUrl handed back to the config layer", provenance("browser.cdpUrl"), "global");
check("on: switch persisted", readExternalBrowserEnabled(), true);

// Results first: the base settings watcher may still hold the agent dir open
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : ` (got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)})`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} failed` : "\nall passed");
// Best-effort cleanup: the base settings file watcher keeps the agent dir open
// on Windows, so a locked temp dir must not turn a green run red
try {
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
} catch {
  console.warn(`(temp dir left behind: ${agentDir})`);
}
process.exit(failed ? 1 : 0);
