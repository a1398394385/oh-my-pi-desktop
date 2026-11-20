// Standalone context viewer: a read-only snapshot of one session's context in a
// two-column workbench (a 1:1 port of omp-studio's ContextInspector against our
// WS RPC bus — store/contextView.ts). The snapshot is captured on open and
// released on close; nothing here re-reads live. Rendered as a middle-column
// page (MainColumn's contextViewer branch); the topbar owns back/refresh.
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/index";
import { t } from "../../i18n";
import type { ContextViewCategoryId, ContextViewEntrySummary, ContextViewIndex, ContextViewSourceMarker } from "../../types/frames";
import { fetchContextViewEntryBody, fetchContextViewIndex, fetchContextViewPage, releaseContextView } from "../../store/contextView";
import { ContextCategoryList } from "./ContextCategoryList";
import { ContextEntryList } from "./ContextEntryList";
import { ContextEntryPane } from "./ContextEntryPane";
import { ContextOverview } from "./ContextOverview";

type Phase = "idle" | "opening" | "ready" | "error";
type Load = "idle" | "loading" | "error";

/** Middle-column page: renders nothing until store.contextViewer names a session.
 *  The container is measured (not the window) so the narrow/compact breakpoints
 *  track the actual column width; the topbar back button and Esc both clear the
 *  state and return to the session. */
export default function ContextViewer() {
  const target = useAppStore((s) => s.contextViewer);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1120, height: 800 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      useAppStore.setState({ contextViewer: null });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target]);
  if (!target) return null;
  return (
    <div className="cv-viewer" ref={wrapRef}>
      <ContextViewerBody sessionId={target.sessionId} width={size.width} height={size.height} />
    </div>
  );
}

function ContextViewerBody({ sessionId, width, height }: { sessionId: string; width: number; height: number }) {
  const narrow = width < 900;
  const compact = height < 520;
  const [reading, setReading] = useState(false);
  const [snapshot, setSnapshot] = useState<{ key: string; index: ContextViewIndex }>();
  const [phase, setPhase] = useState<Phase>("idle");
  // Refresh lives in the topbar (terminal-toggle slot); the bump counter re-samples here.
  const attempt = useAppStore((s) => s.contextViewerRefreshSeq);
  const snapshotKey = JSON.stringify([sessionId, attempt]);
  const index = snapshot?.key === snapshotKey ? snapshot.index : undefined;
  const [category, setCategory] = useState<ContextViewCategoryId>("system-prompt");
  const [childKey, setChildKey] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<ContextViewEntrySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | undefined>(undefined);
  const [selected, setSelected] = useState<ContextViewEntrySummary>();
  const [body, setBody] = useState("");
  const [sourceMarkers, setSourceMarkers] = useState<ContextViewSourceMarker[]>([]);
  const [sourceFocus, setSourceFocus] = useState<{ category: ContextViewCategoryId; entryId: string }>();
  const [totalChars, setTotalChars] = useState(0);
  const [nextBody, setNextBody] = useState<number | undefined>(undefined);
  const [entryTruncated, setEntryTruncated] = useState(false);
  const [listState, setListState] = useState<Load>("idle");
  const [bodyState, setBodyState] = useState<Load>("idle");
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const listGeneration = useRef(0);
  const bodyGeneration = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const generation = ++epoch.current;
    setSnapshot(undefined);
    setPhase("opening");
    setCategory("system-prompt");
    setChildKey(undefined);
    setSearch("");
    setEntries([]);
    setTotal(0);
    setNextOffset(undefined);
    setSelected(undefined);
    setBody("");
    setSourceMarkers([]);
    setSourceFocus(undefined);
    setTotalChars(0);
    setNextBody(undefined);
    setEntryTruncated(false);
    setListState("idle");
    setBodyState("idle");
    setError("");
    setReading(false);
    let acquired: ContextViewIndex | undefined;
    void fetchContextViewIndex({ sessionId })
      .then((result) => {
        if (generation !== epoch.current) {
          void releaseContextView({ sessionId: result.sessionId, snapshotId: result.snapshotId }).catch(() => {});
          return;
        }
        acquired = result;
        setSnapshot({ key: snapshotKey, index: result });
        setPhase("ready");
        setCategory(result.categories.find((item) => item.openable !== false && item.entries > 0)?.id ?? "system-prompt");
      })
      .catch((cause: unknown) => {
        if (generation !== epoch.current) return;
        setError(cause instanceof Error ? cause.message : t("contextViewer.error.open"));
        setPhase("error");
      });
    return () => {
      epoch.current++;
      bodyGeneration.current++;
      if (acquired) void releaseContextView({ sessionId: acquired.sessionId, snapshotId: acquired.snapshotId }).catch(() => {});
    };
    // snapshotKey is derived from sessionId+attempt; attempt bumps re-sample the same session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attempt]);

  const read = async (entry: ContextViewEntrySummary, offset?: number) => {
    if (!index) return;
    const generation = ++bodyGeneration.current;
    setSelected(entry);
    if (offset === undefined) {
      setBody("");
      setSourceMarkers([]);
      setTotalChars(0);
      setNextBody(undefined);
      setEntryTruncated(false);
    }
    setBodyState("loading");
    setError("");
    try {
      const result = await fetchContextViewEntryBody({ sessionId: index.sessionId, snapshotId: index.snapshotId, entryId: entry.id, ...(offset === undefined ? {} : { offset }) });
      if (generation !== bodyGeneration.current) return;
      setBody((previous) => (offset === undefined ? result.text : previous + result.text));
      const markers = (result.sourceMarkers ?? []).map((marker) => ({ ...marker, start: marker.start + (offset ?? 0), end: marker.end + (offset ?? 0) }));
      setSourceMarkers((previous) => (offset === undefined ? markers : [...previous, ...markers]));
      setTotalChars(result.totalChars);
      setNextBody(result.nextOffset);
      setEntryTruncated(result.truncated);
      setBodyState("idle");
    } catch (cause) {
      if (generation !== bodyGeneration.current) return;
      setError(cause instanceof Error ? cause.message : t("contextViewer.error.entry"));
      setBodyState("error");
    }
  };

  useEffect(() => {
    if (!index) return;
    const generation = ++listGeneration.current;
    bodyGeneration.current++;
    const focusEntryId = sourceFocus?.category === category ? sourceFocus.entryId : undefined;
    setSelected(undefined);
    setBody("");
    setSourceMarkers([]);
    setTotalChars(0);
    setNextBody(undefined);
    setEntryTruncated(false);
    setBodyState("idle");
    setEntries([]);
    setTotal(0);
    setNextOffset(undefined);
    setListState("loading");
    setError("");
    const timer = setTimeout(() => {
      fetchContextViewPage({ sessionId: index.sessionId, snapshotId: index.snapshotId, category, ...(childKey && !search.trim() ? { childKey } : {}), search, ...(focusEntryId ? { focusEntryId } : {}) })
        .then((page) => {
          if (generation !== listGeneration.current) return;
          setEntries(page.entries);
          setTotal(page.total);
          setNextOffset(page.nextOffset);
          setListState("idle");
          const target = focusEntryId ? page.entries.find((entry) => entry.id === focusEntryId) : page.entries[0];
          if (target) void read(target);
          else if (focusEntryId) setError(t("contextViewer.entry.sourceUnavailable"));
        })
        .catch((cause: unknown) => {
          if (generation !== listGeneration.current) return;
          setError(cause instanceof Error ? cause.message : t("contextViewer.error.list"));
          setListState("error");
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      listGeneration.current++;
    };
    // `read` is stable enough: it only touches refs and setState from the latest closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, category, childKey, search, sourceFocus]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) return;
      const targetEl = event.target as HTMLElement | null;
      const typing = targetEl?.matches("input, textarea") || targetEl?.isContentEditable === true;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        setReading(false);
        if (narrow && reading) requestAnimationFrame(() => searchRef.current?.focus());
        else searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, reading]);

  const moreEntries = async () => {
    if (!index || nextOffset === undefined) return;
    const generation = listGeneration.current;
    setListState("loading");
    try {
      const page = await fetchContextViewPage({
        sessionId: index.sessionId,
        snapshotId: index.snapshotId,
        category,
        ...(childKey && !search.trim() ? { childKey } : {}),
        search,
        offset: nextOffset,
      });
      if (generation !== listGeneration.current) return;
      setEntries((previous) => [...previous, ...page.entries]);
      setNextOffset(page.nextOffset);
      setListState("idle");
    } catch (cause) {
      if (generation !== listGeneration.current) return;
      setError(cause instanceof Error ? cause.message : t("contextViewer.error.list"));
      setListState("error");
    }
  };

  const moreBody = () => {
    if (!selected || nextBody === undefined) return;
    void read(selected, nextBody);
  };

  return (
    <section
      className="cv"
      ref={rootRef}
      aria-label={t("contextViewer.title")}
      data-narrow={narrow || undefined}
      data-reading={(narrow && reading) || undefined}
      data-compact={compact || undefined}
    >
      <header className="cv-head">
        <div className="cv-head-actions">
          {index?.truncated ? <span className="cv-chip amber">{t("contextViewer.truncated")}</span> : null}
        </div>
      </header>
      {index ? <ContextOverview index={index} /> : null}
      <div className="cv-divider" aria-hidden="true" />
      {index ? (
        <div className="cv-body">
          <aside className="cv-left" inert={narrow && reading}>
            <ContextCategoryList
              index={index}
              category={category}
              childKey={childKey}
              onSelect={(nextCategory, nextChildKey) => {
                setSourceFocus(undefined);
                setCategory(nextCategory);
                setChildKey(nextChildKey);
                setSearch("");
              }}
            />
            <ContextEntryList
              category={category}
              entries={entries}
              total={total}
              childKey={childKey}
              selectedId={selected?.id}
              listState={listState}
              search={search}
              onSearch={setSearch}
              onSelect={(entry) => {
                void read(entry);
                setReading(true);
              }}
              onMore={() => void moreEntries()}
              nextOffset={nextOffset}
              searchRef={searchRef}
            />
          </aside>
          <ContextEntryPane
            hidden={narrow && !reading}
            onBack={narrow ? () => setReading(false) : undefined}
            entry={selected}
            body={body}
            sourceMarkers={sourceMarkers}
            focusRequested={sourceFocus?.entryId === selected?.id && sourceFocus !== undefined}
            onOpenSource={(marker) => {
              if (!marker.entryId) return;
              setSourceFocus({ category: marker.category, entryId: marker.entryId });
              setCategory(marker.category);
              setChildKey(undefined);
              setSearch("");
              setReading(true);
            }}
            totalChars={totalChars}
            nextBody={nextBody}
            entryTruncated={entryTruncated}
            bodyState={bodyState}
            onMore={moreBody}
          />
        </div>
      ) : (
        <div className="cv-body cv-state">
          {phase === "error" ? (
            <div className="cv-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="cv-btn"
                onClick={() => useAppStore.setState((s) => ({ contextViewerRefreshSeq: s.contextViewerRefreshSeq + 1 }))}
              >
                {t("contextViewer.retry")}
              </button>
            </div>
          ) : (
            <p className="cv-open-state" role="status">
              <i aria-hidden="true" />
              <b>{t("contextViewer.loading")}</b>
              <small>{t("contextViewer.loadingHint")}</small>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
