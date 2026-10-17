// Global search palette (⌘⇧F / sidebar search button): centered popup searching
// settings items and sessions. Visual language follows the Raycast-style reference:
// embedded search field, category pills, grouped rows. Open state lives in the ui
// slice (paletteOpen); the component mounts only while open.
import { useState, useMemo, useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useAppStore, send, saveUnseen, hideWelcomeScreen, refreshGitDiff, activateSession, pathBase, openSettings,
} from "../../store";
import type { DiskSessionRow } from "../../types/frames";
import type { SessionTextHit } from "../../store/projects";
import { useAllSettingsItems } from "../settings/Settings";
import Icon from "../../Icon";
import { fmtAgo, sessionLabel } from "../main/sidebar/util";

interface SessionMatch {
  path: string;
  title: string;
  repo: string;
  cwd: string;
  modified: string;
  searchText: string;
  archived?: boolean;
  /** Hit snippet for a full-text match (search_session_text); absent for title-only hits */
  snippet?: string;
}

type PaletteTab = "settings" | "sessions";

type PaletteHit =
  | { kind: "settings"; key: string; label: string; pageTitle: string; pageId: string }
  | {
      kind: "session";
      path: string;
      title: string;
      repo: string;
      cwd: string;
      modified: string;
      archived?: boolean;
      snippet?: string;
    };

/** Merge title matches with full-text hits (session_text_search): content hits fill in first so a row hit by both keeps its snippet, sidebar rows fill in the rest. */
function mergeSearchMatches(
  allSessions: SessionMatch[],
  textHits: SessionTextHit[],
  kw: string,
  untitled: string,
): SessionMatch[] {
  if (!kw) return [];
  const known = new Map(allSessions.map((s) => [s.path, s]));
  const byPath = new Map<string, SessionMatch>();
  for (const hit of textHits) {
    const row = known.get(hit.path);
    byPath.set(hit.path, {
      path: hit.path,
      // Content hits may be sessions no project row carries (removed projects, unlisted history) — keep them reachable anyway
      title: row?.title || hit.title || untitled,
      repo: row?.repo || pathBase(hit.cwd),
      cwd: hit.cwd,
      modified: hit.modified,
      searchText: "",
      archived: row?.archived,
      snippet: hit.snippet,
    });
  }
  for (const s of allSessions) {
    if (!s.searchText.includes(kw)) continue;
    const prev = byPath.get(s.path);
    byPath.set(s.path, prev ? { ...prev, title: s.title, repo: s.repo, modified: s.modified, archived: s.archived } : s);
  }
  return [...byPath.values()]
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
    .slice(0, 20);
}

export default function SearchPalette() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.paletteOpen);
  const diskProjects = useAppStore((s) => s.diskProjects);
  const archivedSessions = useAppStore((s) => s.archivedSessions);
  const sessionTextSearch = useAppStore((s) => s.sessionTextSearch);
  const allSettingsItems = useAllSettingsItems();
  const [tab, setTab] = useState<PaletteTab>("sessions");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isKeyboardNavRef = useRef(false);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Aggregate all disk sessions (unnamed/untitled sessions display with the firstMessage fallback label, aligned with the sidebar SessionRow)
  const allSessions = useMemo(() => {
    const list: SessionMatch[] = [];
    const seenPaths = new Set<string>();

    const pushSession = (s: DiskSessionRow, cwd: string, archived = false) => {
      if (seenPaths.has(s.path)) return;
      const displayTitle = sessionLabel(s);
      if (!displayTitle || displayTitle === t("sidebar.emptySession")) return;
      seenPaths.add(s.path);
      const repo = pathBase(cwd);
      list.push({
        path: s.path,
        title: displayTitle,
        searchText: `${s.title || ""} ${s.firstMessage || ""} ${repo}`.toLowerCase(),
        repo,
        cwd,
        modified: s.modified,
        archived,
      });
    };

    for (const p of diskProjects) {
      for (const s of p.sessions) {
        pushSession(s, p.cwd, false);
      }
    }
    for (const s of archivedSessions) {
      pushSession(s, s.cwd, true);
    }
    return list;
  }, [diskProjects, archivedSessions, t]);

  const kw = query.trim().toLowerCase();

  // Full-text search over user prompts / agent replies (host scans every session file, ~1s):
  // debounced, and single characters stay title-only to avoid a full scan per keystroke
  useEffect(() => {
    if (kw.length < 2) return;
    const timer = setTimeout(() => send({ type: "search_session_text", query: kw }), 300);
    return () => clearTimeout(timer);
  }, [kw]);

  const textHits = sessionTextSearch?.query === kw ? sessionTextSearch.hits : [];
  // In flight: the current keyword hasn't been answered yet (the stale frame from the previous keyword is ignored above)
  const textSearching = tab === "sessions" && kw.length >= 2 && sessionTextSearch?.query !== kw;

  // Current tab's visible rows: a flat hit list (keyboard nav order) plus its group caption
  const { groupLabel, hits }: { groupLabel: string; hits: PaletteHit[] } = useMemo(() => {
    if (tab === "sessions") {
      const matches = mergeSearchMatches(allSessions, textHits, kw, t("sidebar.untitledSession"));
      if (!kw) {
        // Idle state: recent sessions (same ordering as mergeSearchMatches: newest first)
        const recent = [...allSessions]
          .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
          .slice(0, 8);
        return {
          groupLabel: t("sidebar.viewRecent"),
          hits: recent.map((s) => ({ kind: "session" as const, ...s })),
        };
      }
      return { groupLabel: t("sidebar.paletteSessions"), hits: matches.map((s) => ({ kind: "session" as const, ...s })) };
    }
    if (!kw) return { groupLabel: "", hits: [] };
    const results: Array<{ hit: PaletteHit; score: number }> = [];
    for (const item of allSettingsItems) {
      const matchLabel = item.label.toLowerCase().includes(kw);
      const matchDesc = item.description.toLowerCase().includes(kw);
      if (matchLabel || matchDesc) {
        results.push({
          hit: { kind: "settings", key: item.key, label: item.label, pageTitle: item.pageTitle, pageId: item.pageId },
          score: (matchLabel ? 2 : 0) + (matchDesc ? 1 : 0),
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return {
      groupLabel: t("sidebar.paletteSettings"),
      hits: results.slice(0, 12).map((r) => r.hit),
    };
  }, [tab, kw, allSessions, allSettingsItems, textHits, t]);

  useEffect(() => {
    setSelectedIndex(0);
    listRef.current?.scrollTo({ top: 0 });
  }, [kw, tab]);

  // During keyboard up/down navigation, auto-scroll the highlighted item into view
  useEffect(() => {
    if (!isKeyboardNavRef.current) return;
    const activeEl = listRef.current?.querySelector<HTMLElement>(".palette-item.on");
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Esc closes from anywhere (input blur included); keys.ts handleEsc already yields
  // to .lp-mask surfaces, so this is the sole Esc consumer while open.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        useAppStore.getState().closePalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const close = () => useAppStore.getState().closePalette();

  if (!open) return null;

  // Open the session detail page: switch to the session, expand its project, and close the welcome screen
  const handleOpenSession = (path: string, cwd?: string) => {
    // Narrow: the chat page replaces the session list (ZCode remote navigation)
    useAppStore.getState().setMobileCol("main");
    useAppStore.setState({ isCreatingNew: false });
    hideWelcomeScreen();
    useAppStore.setState((st) => ({
      unseenFinished: new Set([...st.unseenFinished].filter((p) => p !== path)),
    }));
    saveUnseen();
    if (cwd) useAppStore.getState().expandProject(cwd);
    if (useAppStore.getState().openSessions.has(path)) {
      activateSession(path);
      refreshGitDiff();
    } else {
      send({ type: "reload_settings" });
      send({ type: "load_session", path });
    }
    close();
  };

  // Activate the highlighted row: settings items jump to their settings page,
  // sessions open the session detail page.
  const activateHit = (hit: PaletteHit) => {
    if (hit.kind === "settings") {
      openSettings(hit.pageId);
      close();
    } else {
      handleOpenSession(hit.path, hit.cwd);
    }
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && hits.length > 0) {
      e.preventDefault();
      isKeyboardNavRef.current = true;
      setSelectedIndex((prev) => (prev + 1) % hits.length);
    } else if (e.key === "ArrowUp" && hits.length > 0) {
      e.preventDefault();
      isKeyboardNavRef.current = true;
      setSelectedIndex((prev) => (prev - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      if (hits.length > 0) {
        e.preventDefault();
        const target = hits[selectedIndex >= 0 && selectedIndex < hits.length ? selectedIndex : 0];
        if (target) activateHit(target);
      }
    } else if (e.key === "Escape") {
      // Native bubble blocked by the window-level listener; nothing to do here
    }
  };

  return (
    <div
      className="lp-mask palette-mask"
      onMouseDown={(e: MouseEvent) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="palette-box">
        <div className="palette-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder={t("sidebar.palettePlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          {query ? (
            <button
              type="button"
              className="palette-clear"
              title={t("sidebar.clear")}
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <Icon name="xmark" size={12} />
            </button>
          ) : null}
        </div>
        <div className="palette-tabs">
          <button
            type="button"
            className={"palette-tab" + (tab === "settings" ? " on" : "")}
            onClick={() => { setTab("settings"); inputRef.current?.focus(); }}
          >
            <Icon name="settings" size={13} />
            <span>{t("sidebar.paletteSettings")}</span>
          </button>
          <button
            type="button"
            className={"palette-tab" + (tab === "sessions" ? " on" : "")}
            onClick={() => { setTab("sessions"); inputRef.current?.focus(); }}
          >
            <Icon name="comment" size={13} />
            <span>{t("sidebar.paletteSessions")}</span>
          </button>
        </div>
        <div ref={listRef} className="palette-list">
          {tab === "settings" && !kw ? (
            <div className="palette-empty">{t("sidebar.paletteSettingsHint")}</div>
          ) : (
            <>
              {textSearching ? <div className="palette-hint">{t("sidebar.searchingContent")}</div> : null}
              {groupLabel ? <div className="palette-group-tt">{groupLabel}</div> : null}
              {hits.length === 0 ? (
                <div className="palette-empty">{textSearching ? "" : tab === "settings" ? t("sidebar.paletteNoMatch") : t("sidebar.noMatch")}</div>
              ) : (
                hits.map((hit, idx) => (
                  <div
                    key={hit.kind === "settings" ? hit.key : hit.path}
                    className={"palette-item" + (idx === selectedIndex ? " on" : "")}
                    onClick={() => activateHit(hit)}
                    onMouseEnter={() => {
                      isKeyboardNavRef.current = false;
                      setSelectedIndex(idx);
                    }}
                  >
                    <span className="palette-item-ic">
                      <Icon name={hit.kind === "settings" ? "settings" : "comment"} size={14} />
                    </span>
                    <div className="palette-item-body">
                      <div className="palette-item-tt" title={hit.kind === "settings" ? hit.label : hit.title}>
                        {hit.kind === "settings" ? hit.label : hit.title}
                      </div>
                      {hit.kind === "session" && hit.snippet ? <div className="palette-item-snip">{hit.snippet}</div> : null}
                    </div>
                    <span className="palette-item-meta">
                      {hit.kind === "session" && hit.archived && <span className="text-faint">{t("sidebar.archivedLabel")}</span>}
                      {hit.kind === "settings" ? hit.pageTitle : fmtAgo(hit.modified)}
                    </span>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
