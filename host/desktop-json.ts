// Shared read / merge-write helpers for omp-desktop.json (the per-profile
// desktop state file: projects, mcpSharing, ui/browser/computer sections).
// Read is fault-tolerant (missing/corrupt file -> empty object), writes are
// section-scoped merge-writes so unmentioned keys of the file and of the
// section survive. Same tolerance model as host/profile.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { H } from "./state.ts";

/** Read omp-desktop.json in full (missing/corrupt file -> empty object). */
export function readDesktopJson(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(H.desktopProjectsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Read one section (missing/invalid section -> empty object). */
export function readDesktopSection(section: string): Record<string, unknown> {
  const value = readDesktopJson()[section];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Merge-write one section, preserving other file keys and unmentioned section fields. */
export function writeDesktopSection(section: string, value: Record<string, unknown>): void {
  const raw = readDesktopJson();
  writeFileSync(H.desktopProjectsPath, JSON.stringify({ ...raw, [section]: value }, null, 2));
}
