// Shared read / merge-write helpers for omp-desktop.json (the per-profile
// desktop state file: projects, mcpSharing, ui/browser/computer sections).
// Reads distinguish "file absent" (a legal empty state, {}) from "file present
// but unreadable/corrupt" (null): merging into a scratch {} base would rewrite
// the whole file and silently drop every non-managed section (acp, keepalive,
// ui, computerDisplay, ...). writeDesktopSection therefore refuses to write
// when the file is unreadable/corrupt and reports, leaving the on-disk bytes
// untouched for manual recovery. Writes merge at the file level (sibling
// sections survive); the section itself is replaced wholesale, so unmentioned
// section fields survive only via the caller's read-modify-write pattern.
import { readFileSync, writeFileSync } from "node:fs";
import { H } from "./state.ts";
import { safeStderr } from "./stderr.ts";

/**
 * Read omp-desktop.json in full. Returns {} only for the legal empty state
 * (file absent); returns null when the file exists but cannot be served (read
 * error like EBUSY/EPERM, corrupt JSON, or a non-object document) — callers
 * must never merge-write over a null result.
 */
export function readDesktopJson(): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(H.desktopProjectsPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read one section (missing file / invalid section -> empty object; unreadable file also reads as empty — only writes are gated). */
export function readDesktopSection(section: string): Record<string, unknown> {
  const doc = readDesktopJson();
  if (doc === null) return {};
  const value = doc[section];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Merge-write one section, preserving other file keys and unmentioned section fields. */
export function writeDesktopSection(section: string, value: Record<string, unknown>): void {
  const raw = readDesktopJson();
  if (raw === null) {
    safeStderr(
      `[desktop-json] refusing to merge-write section "${section}": ${H.desktopProjectsPath} exists but is unreadable or corrupt; on-disk file left untouched for manual recovery\n`,
    );
    return;
  }
  writeFileSync(H.desktopProjectsPath, JSON.stringify({ ...raw, [section]: value }, null, 2));
}
