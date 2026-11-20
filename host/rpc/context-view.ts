// Context viewer RPC domain: snapshots a session's model context (the base's
// /context projection: prompt-source splitting, tool schemas, thinking groups,
// token estimates) and serves it page by page. Mirrors omp-studio's
// context-view service: open samples once, list/entry read that snapshot,
// release drops it. Snapshots are transient (the card releases on close), and a
// session leaving the pool clears its snapshots via clearContextViewSnapshots.
import { randomUUID } from "node:crypto";
import { buildSessionContextView } from "../bootstrap.ts";
import { acpParamsFromConfig } from "../acp-plan.ts";
import { readAcpRaw } from "../profile.ts";
import { hostI18n } from "../i18n/host.ts";
import { sessions, type PoolEntry } from "../state.ts";
import { safeStderr } from "../stderr.ts";
import type {
  ContextViewCategoryId,
  ContextViewCategorySummary,
  ContextViewEntrySummary,
  ContextViewIndex,
  ContextViewSourceMarker,
} from "../wire/payloads.ts";
import type { ContextViewEntry } from "@oh-my-pi/pi-tui/chrome/context-view-model";
import type { RpcHandler } from "./types.ts";

/** Entry summaries per list page. */
const PAGE_ENTRIES = 200;
/** Characters per entry-body page. */
const PAGE_CHARS = 20_000;
/** Characters of body kept for the in-list preview. */
const PREVIEW_CHARS = 480;
/** Per-entry and whole-snapshot body caps; a snapshot is a transient copy, not a second transcript. */
const ENTRY_BYTES = 256 * 1024;
const SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** Hard entry-count cap per snapshot. */
const MAX_ENTRIES = 2000;

interface StoredEntry {
  summary: ContextViewEntrySummary;
  text: string;
  sourceMarkers: ContextViewSourceMarker[];
  /** Lowercased label + info + path + text, built once because snapshots are immutable. */
  lowered: string;
  truncated: boolean;
}

interface Snapshot {
  sessionId: string;
  index: ContextViewIndex;
  entries: Map<string, StoredEntry>;
  /** Entry ids per category id and per child group key. */
  groups: Map<string, string[]>;
  childOwner: Map<string, ContextViewCategoryId>;
}

const snapshots = new Map<string, Snapshot>();

/** Drop every snapshot captured for a session (its pool entry is leaving). */
export function clearContextViewSnapshots(sessionId: string): void {
  for (const [snapshotId, snapshot] of snapshots) if (snapshot.sessionId === sessionId) snapshots.delete(snapshotId);
}

function reqIdOf(msg: Record<string, unknown>): number {
  const n = Number(msg.reqId);
  return Number.isFinite(n) ? n : 0;
}

/** Slice a preview without splitting a surrogate pair. */
function slicePreview(text: string, max: number): string {
  let end = Math.min(text.length, max);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end--;
  return text.slice(0, end);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cut at a UTF-8 boundary so a clipped body stays valid text. */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
}

/** Sample the base's native context projection once and freeze it into a snapshot. */
function capture(entry: PoolEntry, sessionId: string): ContextViewIndex {
  const session = entry.session;
  const native = buildSessionContextView(session);
  const entries = new Map<string, StoredEntry>();
  const groups = new Map<string, string[]>();
  const childOwner = new Map<string, ContextViewCategoryId>();
  const childKeyById = new Map<string, string>();
  for (const category of native.categories)
    for (const child of category.children ?? []) {
      if (!child.key) continue;
      childOwner.set(child.key, category.id);
      for (const entry of child.entries) childKeyById.set(entry.id, child.key);
    }

  let bytes = 0;
  let truncated = false;
  for (const category of native.categories) {
    const ids: string[] = [];
    const add = (entry: ContextViewEntry) => {
      if (ids.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const cut = truncateUtf8(entry.text, Math.min(ENTRY_BYTES, Math.max(0, SNAPSHOT_BYTES - bytes)));
      bytes += Buffer.byteLength(cut.text);
      truncated ||= cut.truncated;
      const childKey = childKeyById.get(entry.id);
      ids.push(entry.id);
      entries.set(entry.id, {
        text: cut.text,
        truncated: cut.truncated,
        sourceMarkers: (entry.sourceMarkers ?? []).filter((marker) => marker.end <= cut.text.length),
        lowered: `${entry.label} ${entry.info ?? ""} ${entry.path ?? ""} ${cut.text}`.toLowerCase(),
        summary: {
          id: entry.id,
          label: entry.label,
          tokens: entry.tokens,
          bytes: Buffer.byteLength(cut.text),
          ...(entry.info ? { info: entry.info } : {}),
          ...(entry.path ? { path: entry.path } : {}),
          ...(entry.interrupted ? { interrupted: true } : {}),
          ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
          ...(entry.callId ? { callId: entry.callId } : {}),
          ...(childKey ? { childKey } : {}),
          ...(entry.thinkingGroup
            ? {
                thinkingGroup: {
                  id: entry.thinkingGroup.id,
                  label: entry.thinkingGroup.label,
                  tokens: entry.thinkingGroup.tokens,
                  ...(entry.thinkingGroup.interrupted ? { interrupted: true } : {}),
                },
              }
            : {}),
          preview: slicePreview(cut.text, PREVIEW_CHARS),
        },
      });
    };
    for (const entry of category.entries) add(entry);
    groups.set(category.id, ids);
    for (const child of category.children ?? []) {
      if (!child.key) continue;
      // Entries skipped by the caps never reached the store, so their groups shrink with them.
      groups.set(
        child.key,
        child.entries.map((entry) => entry.id).filter((id) => entries.has(id)),
      );
    }
  }

  const breakdown = native.breakdown;
  const categories: ContextViewCategorySummary[] = native.categories.map((category) => ({
    id: category.id,
    label: category.label,
    tokens: category.tokens,
    entries: groups.get(category.id)?.length ?? 0,
    ...(category.children?.length
      ? {
          children: category.children
            .filter((child) => child.key !== undefined)
            .map((child) => ({
              id: category.id,
              key: child.key!,
              label: child.label,
              tokens: child.tokens,
              entries: groups.get(child.key!)?.length ?? 0,
            })),
        }
      : {}),
  }));

  const index: ContextViewIndex = {
    sessionId,
    snapshotId: randomUUID(),
    capturedAt: new Date().toISOString(),
    contextWindow: breakdown.contextWindow,
    usedTokens: breakdown.usedTokens,
    freeTokens: breakdown.freeTokens,
    bufferTokens: breakdown.autoCompactBufferTokens,
    thresholdTokens: breakdown.thresholdTokens ?? null,
    // ACP sessions carry the tier ladder (absolute tokens or percent x window —
    // same conversion the runtime's resolveParams uses) so the viewer can mark
    // L1/L2/L3 instead of the single base auto-compact threshold.
    ...(entry.acpRuntime && !entry.acpRuntime.degraded
      ? (() => {
          const p = acpParamsFromConfig(readAcpRaw().acp, breakdown.contextWindow);
          return { acpTiers: { l1: p.l1, l2: p.l2, l3: p.l3 } };
        })()
      : {}),
    savedTokens: breakdown.snapcompact?.savedTokens ?? 0,
    truncated,
    categories,
    notices: [...(native.notices ?? []), hostI18n.t("flows.contextView.tokenEstimate")],
  };
  snapshots.set(index.snapshotId, { sessionId, index, entries, groups, childOwner });
  return index;
}

export const contextViewHandlers: Record<string, RpcHandler> = {
  async context_view_open(ws, msg) {
    const reqId = reqIdOf(msg);
    const sessionId = String(msg.sessionId ?? "");
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      ws.send(
        JSON.stringify({
          type: "context_view_index",
          reqId,
          ok: false,
          error: hostI18n.t("errors.session.notFound", { sessionId }),
        }),
      );
      return;
    }
    let index: ContextViewIndex;
    try {
      index = capture(entry, sessionId);
    } catch (err) {
      // Correlated reply instead of the shell's generic error frame (which drops the reqId).
      safeStderr(`[host] context_view_open failed: ${String(err)}\n`);
      ws.send(JSON.stringify({ type: "context_view_index", reqId, ok: false, error: String(err), sessionId }));
      return;
    }
    ws.send(JSON.stringify({ type: "context_view_index", reqId, ok: true, ...index }));
  },

  async context_view_list(ws, msg) {
    const reqId = reqIdOf(msg);
    const sessionId = String(msg.sessionId ?? "");
    const snapshotId = String(msg.snapshotId ?? "");
    const category = String(msg.category ?? "") as ContextViewCategoryId;
    const fail = (error: string) =>
      ws.send(JSON.stringify({ type: "context_view_page", reqId, ok: false, error, sessionId, snapshotId }));
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot || snapshot.sessionId !== sessionId) {
      fail(hostI18n.t("errors.contextView.snapshotExpired"));
      return;
    }
    const offset = Number(msg.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      fail(hostI18n.t("errors.contextView.invalidPage"));
      return;
    }
    const search = String(msg.search ?? "").trim().toLowerCase();
    // A search spans the whole category; a group key only narrows browsing.
    const childKey = typeof msg.childKey === "string" && msg.childKey ? msg.childKey : undefined;
    const key = childKey && !search ? childKey : category;
    if (key !== category && snapshot.childOwner.get(key) !== category) {
      fail(hostI18n.t("errors.contextView.unknownGroup"));
      return;
    }
    const ids = snapshot.groups.get(key);
    if (!ids) {
      fail(hostI18n.t("errors.contextView.unknownCategory"));
      return;
    }
    const matched = ids
      .map((id) => snapshot.entries.get(id))
      .filter((entry): entry is StoredEntry => entry !== undefined)
      .filter((entry) => !search || entry.lowered.includes(search));
    // Opening from a specific entry lands on the page holding it (its row is then visible to select).
    const focusId = typeof msg.focusEntryId === "string" && msg.focusEntryId ? msg.focusEntryId : undefined;
    const focus = focusId && msg.offset === undefined ? matched.findIndex((entry) => entry.summary.id === focusId) : -1;
    const pageOffset = focus < 0 ? offset : Math.floor(focus / PAGE_ENTRIES) * PAGE_ENTRIES;
    const page = matched.slice(pageOffset, pageOffset + PAGE_ENTRIES).map((entry) => entry.summary);
    ws.send(
      JSON.stringify({
        type: "context_view_page",
        reqId,
        ok: true,
        sessionId,
        snapshotId,
        category,
        entries: page,
        total: matched.length,
        ...(pageOffset + page.length < matched.length ? { nextOffset: pageOffset + page.length } : {}),
      }),
    );
  },

  async context_view_entry(ws, msg) {
    const reqId = reqIdOf(msg);
    const sessionId = String(msg.sessionId ?? "");
    const snapshotId = String(msg.snapshotId ?? "");
    const entryId = String(msg.entryId ?? "");
    const fail = (error: string) =>
      ws.send(JSON.stringify({ type: "context_view_entry_body", reqId, ok: false, error, sessionId, snapshotId }));
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot || snapshot.sessionId !== sessionId) {
      fail(hostI18n.t("errors.contextView.snapshotExpired"));
      return;
    }
    const offset = Number(msg.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      fail(hostI18n.t("errors.contextView.invalidPage"));
      return;
    }
    const entry = snapshot.entries.get(entryId);
    if (!entry) {
      fail(hostI18n.t("errors.contextView.entryUnavailable"));
      return;
    }
    let end = Math.min(entry.text.length, offset + PAGE_CHARS);
    // Never split a source marker across pages: it would lose its link.
    const crossing = entry.sourceMarkers.find(
      (marker) => marker.start > offset && marker.start < end && marker.end > end,
    );
    if (crossing) end = crossing.start;
    if (end < entry.text.length && /[\uD800-\uDBFF]/u.test(entry.text[end - 1] ?? "")) end--;
    const sourceMarkers = entry.sourceMarkers
      .filter((marker) => marker.start >= offset && marker.end <= end)
      .map((marker) => ({
        start: marker.start - offset,
        end: marker.end - offset,
        category: marker.category,
        ...(marker.entryId && snapshot.entries.has(marker.entryId) ? { entryId: marker.entryId } : {}),
      }));
    ws.send(
      JSON.stringify({
        type: "context_view_entry_body",
        reqId,
        ok: true,
        sessionId,
        snapshotId,
        entryId,
        text: entry.text.slice(offset, end),
        totalChars: entry.text.length,
        truncated: entry.truncated,
        ...(sourceMarkers.length ? { sourceMarkers } : {}),
        ...(end < entry.text.length ? { nextOffset: end } : {}),
      }),
    );
  },

  async context_view_release(ws, msg) {
    const reqId = reqIdOf(msg);
    const sessionId = String(msg.sessionId ?? "");
    const snapshotId = String(msg.snapshotId ?? "");
    const snapshot = snapshots.get(snapshotId);
    const released = snapshot !== undefined && snapshot.sessionId === sessionId;
    if (released) snapshots.delete(snapshotId);
    ws.send(JSON.stringify({ type: "context_view_released", reqId, ok: true, sessionId, snapshotId, released }));
  },
};
