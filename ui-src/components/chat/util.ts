// Pure utility functions: ported from the parts of ui/tool-rows.js and ui/sidebar.js that
// React components consume (after the legacy native frontend was removed, no more imports
// from the old ui/ modules)
import type { ChatItem, ToolItem } from "./chat-types";
import { t } from "../../i18n";

// Deduplicate and normalize a file list: unify slashes, drop short paths covered by longer ones
export function uniqueFiles(files: Iterable<unknown> | null | undefined): string[] {
  const out: string[] = [];
  for (const p of files || []) {
    if (typeof p !== "string" || !p) continue;
    const norm = p.replace(/\\/g, "/");
    const i = out.findIndex((x) => x === norm || x.endsWith("/" + norm) || norm.endsWith("/" + x));
    if (i < 0) out.push(norm);
    else if (norm.length > out[i].length) out[i] = norm;
  }
  return out;
}

// ---------- `:selector` suffixes on read tool paths (syntax aligned with the core
// pi-coding-agent's read tool) ----------
// Line-number segment: L5 / 5 / 5-16 / 5..16 / 5-, 5+ (open-ended, trailing number
// omittable) / 5+150 (150 lines from here);
// comma-chaining 5-16,960-973 is allowed (third group optional, aligned with the core's
// PMt regex)
const SEL_NUM = String.raw`L?\d+(?:(?:\.\.|[-+])L?\d*)?`;
// Selector segment: raw / conflicts / img / line-number segment / -N (last N lines);
// segments are colon-chained (e.g. a.rs:2-4:raw)
const SEL_SEG = new RegExp(`^(?:raw|conflicts|img|${SEL_NUM}(?:,${SEL_NUM})*|-\\d+(?:[-+]\\d+)?)$`, "i");
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// Strip all trailing `:selector` segments from a read path, returning the pure file path
// (returned as-is when there is no selector).
// Icons/file names/right-panel requests all go by the clean path; otherwise
// `style.css:683:raw` would not resolve the .css type icon.
export function stripReadSelector(p: unknown): string {
  let path = String(p || "");
  const schemeLen = (path.match(URL_SCHEME)?.[0] || "").length; // skip the scheme, so http: is not treated as the start of a selector
  for (;;) {
    const i = path.lastIndexOf(":");
    if (i <= schemeLen || !SEL_SEG.test(path.slice(i + 1))) return path;
    path = path.slice(0, i);
  }
}

// First line range in the selector (for right-panel file view highlighting):
// `a.css:683:raw` → [683,683], `a.rs:50+150` → [50,199];
// segments without digits (raw/conflicts/img/-N) return null
export function readSelectorRange(p: unknown): [number, number] | null {
  const s = String(p || "");
  const m = s.slice(stripReadSelector(s).length).replace(/^:/, "").match(/^L?(\d+)(?:(\.\.|[-+])(\d+)?)?/i);
  if (!m) return null;
  const start = Number(m[1]);
  if (!m[2]) return [start, start];
  if (m[2] === "+") return [start, m[3] ? start + Number(m[3]) - 1 : start];
  return [start, m[3] ? Number(m[3]) : start];
}

// Split a path into directory and file name (keeps the trailing separator; strips
// line-number selectors and other suffixes to keep the path clean)
export function splitPath(p: unknown): { dir: string; name: string } {
  const norm = stripReadSelector(String(p || "").replace(/\\/g, "/"));
  const i = norm.lastIndexOf("/");
  if (i < 0) return { dir: "", name: norm };
  return { dir: norm.slice(0, i + 1), name: norm.slice(i + 1) };
}

// Tool device paths (xd://tui etc.): reading/writing one is a device call, not a file read/write
const DEVICE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
export function isDevicePath(p: unknown): boolean {
  return typeof p === "string" && DEVICE_SCHEME.test(p);
}

// Device name (xd://tui → tui): summaries and same-device grouping share the same rule
export function deviceNameOf(p: unknown): string {
  return typeof p === "string" ? p.replace(DEVICE_SCHEME, "") : "";
}

// Writing to a tool device (write/edit to xd://…): not a file edit, no diff to view,
// rendered as a device row
export function isDeviceEvent(item: ChatItem): item is ToolItem {
  return item.role === "tool" && ["edit", "write", "apply_patch"].includes(item.name || "") && isDevicePath(item.args?.path);
}

// Edit-type tool events (edit rows / change groups classify by this); device writes are excluded
export function isEditEvent(item: ChatItem): item is ToolItem {
  return item.role === "tool" && ["edit", "write", "apply_patch"].includes(item.name || "") && !isDevicePath(item.args?.path);
}

// Read-type tool events (lookup groups classify by this, same folding logic as change
// groups); directory reads are not grouped (details.isDirectory)
export function isReadEvent(item: ChatItem): item is ToolItem {
  return item.role === "tool" && (item.name || "") === "read" && item.details?.isDirectory !== true;
}

// Terminal-type tool events (terminal groups classify by this, same folding logic as the
// change/lookup groups)
export function isCmdEvent(item: ChatItem): item is ToolItem {
  return item.role === "tool" && ["bash", "shell", "eval"].includes(item.name || "");
}

// Duration formatting: seconds / minutes-seconds
export function fmtDuration(sec: number): string {
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return t("sidebar.durSec", { n: sec });
  const m = Math.floor(sec / 60);
  return t("sidebar.durMinSec", { m, s: String(sec % 60).padStart(2, "0") });
}
