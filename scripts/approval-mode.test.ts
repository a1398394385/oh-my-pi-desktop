// Approval-mode parity with the base (18.12.3 added "always-ask-cached").
//
// The base's tools.approvalMode enum is the source of truth: the host validates
// against it (host/rpc/settings.ts), so a new base mode works on the write path
// with no desktop change. The composer menu, however, lists the modes by hand —
// a base mode without a MODE_META row would be invisible in the pill and in the
// permission menu, and a mode the desktop lists but the base does not would be
// rejected by the host. Both are covered here.
// Run: OMP_PROFILE=omp-desktop-test bun test scripts/approval-mode.test.ts
import { Window } from "happy-dom";
import { describe, expect, test } from "bun:test";
// Importing the settings domain registers every base setting, so the lookup
// below resolves tools.approvalMode with its enum values.
import "@oh-my-pi/pi-coding-agent/config/all-settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { OPTS_ZH } from "../ui-src/i18n/locales/settings-zh-CN";

const win = new Window({ url: "http://localhost/?preview=1" });
Object.assign(globalThis, {
  window: win, document: win.document, HTMLElement: win.HTMLElement,
  localStorage: win.localStorage, navigator: win.navigator, location: win.location,
  matchMedia: ((q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const baseModes = lookup("tools.approvalMode")?.enumValues ?? [];

// The mode menu pulls in the app store, whose module scope touches the DOM —
// it must load after the globals above are installed, so it cannot be a static
// import.
const { MODE_META } = await import("../ui-src/components/composer/ModeMenu");

describe("approval modes", () => {
  test("the composer menu lists exactly the base's modes", () => {
    expect(Object.keys(MODE_META).sort()).toEqual([...baseModes].sort());
  });

  test("every base mode has a Chinese value label in the settings page", () => {
    const labels = OPTS_ZH["tools.approvalMode"] ?? {};
    for (const mode of baseModes) expect(labels[mode]).toBeTruthy();
  });
});
