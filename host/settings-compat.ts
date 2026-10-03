// 18.5.0 settings registry adapter: pi-coding-agent replaced Settings'
// string-key get/set with registry handles (config/registry), so the host's
// dotted-path reads/writes route through this module. Reads use layered()
// (layers + schema default, ignoring env vars) — what the base settings panel
// shows and edits.
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { lookupSetting, orderedSettings } from "./bootstrap.ts";

export function settingsGet(settings: Settings, path: string): unknown {
  return lookupSetting(path)?.layered(settings);
}

export function settingsSet(settings: Settings, path: string, value: unknown): void {
  const setting = lookupSetting(path);
  if (!setting) throw new Error(`Unknown setting: ${path}`);
  settings.writeValue(setting, value, "global");
}

// Settings-page schema snapshot: registry handles re-shaped into the legacy
// SETTINGS_SCHEMA record the desktop UI consumes (SchemaDef in
// ui-src/components/settings/placement.ts).
export function settingsSchemaRecord(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of orderedSettings()) {
    out[s.id] = {
      type: s.type,
      credential: s.isCredential || undefined,
      default: s.default,
      values: s.enumValues ? [...s.enumValues] : undefined,
      ui: s.ui,
    };
  }
  return out;
}
