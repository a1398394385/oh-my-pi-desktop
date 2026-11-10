// File page: empty state is the current project's file tree (lazily loaded one level per
// expand); clicking a file enters the detail
// (read_file for whole files / read_image for image previews; fp-title title bar pinned +
// rb-head actions + scrolling rb-scroll skeleton).
import { flushSync, createPortal } from "react-dom";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { IS_WINDOWS } from "../../../platform";
import { useAppStore, setBump, send, pathBase, toast } from "../../../store";
import { placeMenu } from "../../../shell";
import { fileTypeIcon } from "../../../../ui/icons";
import Icon from "../../../Icon";
import { langOfPath } from "../../../lib/highlighter";
import { CodeTokens, useCodeTokens } from "../../../lib/CodeTokens";
import type { EditorInfo } from "../../../types/frames";
import type { FileViewState } from "../../../types/session";
import { IMAGE_EXTS } from "../../chat/util";
import MdSurface from "../../chat/MdSurface";
import { SUCCESS_FLASH_MS } from "../sidebar/util";

const FILE_VIEW_MAX_LINES = 800; // display window for over-long whole files: start at the request range's first line when present, otherwise from the top

// Markdown files open in rendered preview with a preview/source toggle (ZCode file-tab parity)
const MD_VIEW_RE = /\.(md|markdown)$/i;
// Above this size streamdown rendering janks the panel; the file stays in source view
const MD_PREVIEW_MAX_CHARS = 300_000;

// File page shell (ZCode two-pane parity): content pane (title bar + empty hint / opened file)
// on the left, persistent navigation pane (search + root row + tree) on the right, draggable
// splitter between. Nav width and collapse state are pure UI prefs persisted to localStorage.
const NAV_WIDTH_KEY = "omp-file-nav-w";
const NAV_COLLAPSED_KEY = "omp-file-nav-collapsed";
const NAV_W_MIN = 200;
const NAV_W_MAX = 480;

// Title-bar trail: the project name followed by the path segments inside it; a file outside
// the project root falls back to its own absolute segments
function titleSegments(abs: string, root: string | undefined): string[] {
  const a = abs.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = (root || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!r || !a.startsWith(r + "/")) return a.split("/").filter(Boolean);
  const name = r.split("/").filter(Boolean).pop() || r;
  return [name, ...a.slice(r.length + 1).split("/")];
}

// Title-bar path: segments joined by the same right-chevron the collapsible tree rows use,
// so the path reads as a trail instead of a slash string. `fold` swaps the middle segments
// for a single ellipsis when the whole trail does not fit (measured in FilePage)
function PathCrumbs({ segments, fold }: { segments: string[]; fold: boolean }) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const middles = segments.slice(1, -1);
  return (
    <>
      <span className="fp-crumb-seg">{first}</span>
      {middles.length > 0 &&
        (fold ? (
          <>
            <span className="fp-crumb-sep">
              <Icon name="chevronRight" size={15} />
            </span>
            <span className="fp-crumb-seg">…</span>
          </>
        ) : (
          middles.map((seg, i) => (
            <Fragment key={i}>
              <span className="fp-crumb-sep">
                <Icon name="chevronRight" size={15} />
              </span>
              <span className="fp-crumb-seg">{seg}</span>
            </Fragment>
          ))
        ))}
      {segments.length > 1 && (
        <>
          <span className="fp-crumb-sep">
            <Icon name="chevronRight" size={15} />
          </span>
          <span className="fp-crumb-seg">{last}</span>
        </>
      )}
    </>
  );
}

export default function FilePage() {
  const { t } = useTranslation();
  const fileView = useAppStore((s) => s.fileView);
  const cwd = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.cwd : undefined));
  const [navW, setNavW] = useState(() => {
    const v = Number(localStorage.getItem(NAV_WIDTH_KEY));
    return v >= NAV_W_MIN && v <= NAV_W_MAX ? v : 260;
  });
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem(NAV_COLLAPSED_KEY) === "1");
  const [navDragging, setNavDragging] = useState(false);
  const dragRef = useRef(false);
  // Fold the middle path segments only when the whole trail genuinely overflows: the hidden
  // mirror renders the unfolded trail, so the decision never depends on the current render
  const pathRef = useRef<HTMLSpanElement>(null);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const [foldPath, setFoldPath] = useState(false);
  // Image view hides the nav so the preview gets the whole pane; the title-bar toggle then
  // peeks the tree back over the image instead of touching the persisted collapse pref
  const [navPeek, setNavPeek] = useState(false);
  const imageView = !!fileView?.image;
  const navOpen = imageView ? navPeek : !navCollapsed;
  // A peek exists to reach the tree; picking the next file ends it, so every newly opened
  // file starts on its default layout (images full-bleed again)
  useEffect(() => { setNavPeek(false); }, [fileView?.path]);
  const pathSegments = fileView ? titleSegments(fileView.path, cwd) : [t("right.tabFile")];
  // Splitter drag tracks the pointer on window (fast drags never lose the gesture);
  // width = shell right edge minus pointer x, clamped
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const shell = document.getElementById("fpShell")?.getBoundingClientRect();
      if (!shell) return;
      setNavW(Math.max(NAV_W_MIN, Math.min(NAV_W_MAX, shell.right - e.clientX)));
    };
    const up = () => { dragRef.current = false; setNavDragging(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);
  useEffect(() => { localStorage.setItem(NAV_WIDTH_KEY, String(navW)); }, [navW]);
  useEffect(() => { localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsed ? "1" : "0"); }, [navCollapsed]);
  useLayoutEffect(() => {
    const el = pathRef.current;
    const mirror = mirrorRef.current;
    if (!el || !mirror) return;
    // ResizeObserver delivers an initial callback on observe(), so no separate first pass
    const ro = new ResizeObserver(() => setFoldPath(mirror.offsetWidth > el.clientWidth + 1));
    ro.observe(el);
    return () => ro.disconnect();
  });

  return (
    <div id="fpShell" className="fp-shell">
      {/* Title bar (ZCode parity): the open file's path relative to the project root on the
          left (the tab label while no file is open), the file actions and the file-navigation
          toggle on the right. It spans both panes: the content pane alone is too narrow to
          carry the path. */}
      <div className="fp-title">
        <span className="fp-title-path" ref={pathRef} title={fileView?.path}>
          <PathCrumbs segments={pathSegments} fold={foldPath} />
          {/* hidden unfolded copy: its width decides whether the real trail has to fold */}
          <span className="fp-crumb-mirror" aria-hidden="true" ref={mirrorRef}>
            <PathCrumbs segments={pathSegments} fold={false} />
          </span>
        </span>
        <FileTabActions />
        <button
          type="button"
          className="icon-btn"
          title={navOpen ? t("right.collapseFileNav") : t("right.expandFileNav")}
          onClick={() => (imageView ? setNavPeek((v) => !v) : setNavCollapsed((v) => !v))}
        >
          <Icon name={navOpen ? "panelRightClose" : "panelRightOpen"} size={15} />
        </button>
      </div>
      <div className={`fp-panes${navDragging ? " dragging" : ""}`}>
        <div className="fp-main">{fileView ? <FvDetail /> : <FvEmpty />}</div>
        <div
          className={`fp-split${navOpen ? "" : " collapsed"}`}
          onPointerDown={(e) => { e.preventDefault(); dragRef.current = true; setNavDragging(true); }}
        />
        <div
          className={`fp-nav${navOpen ? "" : " collapsed"}`}
          style={{ width: navOpen ? `min(${navW}px, 55%)` : 0, flexShrink: 1 }}
          aria-hidden={!navOpen}
          inert={!navOpen}
        >
          <FileNav />
        </div>
      </div>
    </div>
  );
}

// Empty content pane: ZCode's pick-a-file hint; the navigation pane beside it is the entry.
// The hint is nowrap and the pane shrinks with the splitter drag, so it would spill over the
// nav pane: hide it instead of clipping partial text. Width comes from the content box (no
// padding on .fp-empty) so the hidden mirror is the exact text width.
function FvEmpty() {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLSpanElement | null>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const mirror = mirrorRef.current;
    if (!box || !mirror) return;
    // ResizeObserver delivers an initial callback on observe(), so no separate first pass
    const ro = new ResizeObserver(() => setFits(mirror.offsetWidth <= box.clientWidth));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="fp-empty" ref={boxRef}>
      {fits && <span>{t("right.pickFile")}</span>}
      <span className="fp-empty-mirror" aria-hidden="true" ref={mirrorRef}>
        {t("right.pickFile")}
      </span>
    </div>
  );
}

// More menu on the project row / the back-to-tree row: open the target in an app that handles this
// file type (host asks Launch Services on macOS, so the list depends on the path), or copy its
// absolute / relative path. Relative paths are taken against the session project root, so the row's
// own dir yields ".". Fallback glyphs cover entries whose icon could not be resolved.
const FALLBACK_ICON: Record<NonNullable<EditorInfo["kind"]>, string> = {
  fileManager: "folderOpen",
  editor: "code",
  terminal: "term",
};

/** Open-with popover for one path: the Launch Services app list plus path / markdown actions.
 *  Portalled to body (row containers crop with overflow:hidden) and anchored to `anchor`, so any
 *  card that owns a trigger button can reuse it. */
export function OpenWithMenu({ target, root, mdView, file, open, onClose, anchor }: {
  target: string;
  root: string;
  mdView?: { preview: boolean; previewable: boolean; onPick: (v: boolean) => void };
  /** An opened file (not a directory): adds reveal + save-as */
  file?: boolean;
  open: boolean;
  onClose: () => void;
  anchor: { current: HTMLElement | null };
}) {
  const { t } = useTranslation();
  const openApps = useAppStore((s) => s.openApps);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Path whose copy is currently flashing; also holds the menu open until the flash ends.
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  // Associations are per file type and can change outside the app, so every open re-queries;
  // a reply for another path means this menu is still waiting
  useEffect(() => {
    if (open) send({ type: "list_open_apps", path: target });
  }, [open, target]);
  // Measured placement, right edge on the trigger, viewport-clamped (same recipe as the
  // automations .auto-sel-menu).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const btn = anchor.current;
    if (!open || !menu || !btn) return;
    placeMenu(menu, 0, 0); // measure at the origin: zoom is applied first, coordinates divided back after
    const mr = menu.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(br.right - mr.width, window.innerWidth - mr.width - 8));
    const top = Math.max(8, Math.min(br.bottom + 4, window.innerHeight - mr.height - 8));
    placeMenu(menu, left, top);
  }, [open, openApps, anchor]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => {
      const node = e.target as Node | null;
      if (anchor.current?.contains(node) || menuRef.current?.contains(node)) return;
      onClose();
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open, onClose, anchor]);

  const openIn = (editorId: string) => {
    onClose();
    send({ type: "open_with", editorId, path: target });
  };
  const copyPath = (text: string) => {
    // The icon swap needs the menu to stay open, so the close waits out the flash window.
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedPath(text);
        window.setTimeout(() => {
          setCopiedPath(null);
          onClose();
        }, SUCCESS_FLASH_MS);
      })
      .catch(() => toast(t("right.copyFailed")));
  };
  // The native save panel belongs to the Tauri shell; the host only performs the copy
  const savePanel = window.__TAURI__?.dialog?.save;
  const saveCopy = async () => {
    if (!savePanel) return;
    onClose();
    try {
      const dest = await savePanel({ defaultPath: target });
      if (dest) send({ type: "copy_file", from: target, to: dest });
    } catch (err) {
      toast(String(err), true);
    }
  };
  // Normalize Windows backslashes so the prefix strip works on every platform
  const abs = target.replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const relPath = !rel || abs === rel ? "." : abs.startsWith(rel + "/") ? abs.slice(rel.length + 1) : abs;

  if (!open) return null;
  return createPortal(
    <div className="menu open fv-menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
      <div className="mh">{t("right.openWithTitle")}</div>
      {openApps === null || openApps.path !== target ? (
        <div className="mi empty">{t("common.loading")}</div>
      ) : openApps.apps.length === 0 ? (
        <div className="mi empty">{t("right.noOpenApps")}</div>
      ) : (
        openApps.apps.map((app) => (
          <button type="button" key={app.id} className="mi" onClick={() => openIn(app.id)}>
            <span className="mi-ic">
              {app.iconDataUrl ? (
                <img src={app.iconDataUrl} alt="" />
              ) : (
                <Icon name={app.kind ? FALLBACK_ICON[app.kind] : "code"} size={14} />
              )}
            </span>
            {app.name}
          </button>
        ))
      )}
      <div className="sep" />
      {file && (
        <button type="button" className="mi" onClick={() => openIn("finder")}>
          <span className="mi-ic">
            <Icon name="folderOpen" size={14} />
          </span>
          {IS_WINDOWS ? t("right.revealInFinder") : t("right.openInFinder")}
        </button>
      )}
      {file && savePanel && (
        <button type="button" className="mi" onClick={saveCopy}>
          <span className="mi-ic">
            <Icon name="download" size={14} />
          </span>
          {t("right.saveAs")}
        </button>
      )}
      <button type="button" className="mi" onClick={() => copyPath(target)}>
        <span className="mi-ic">
          <Icon name={copiedPath === target ? "check" : "copy"} size={14} />
        </span>
        {copiedPath === target ? t("common.copied") : t("right.copyAbsPath")}
      </button>
      <button type="button" className="mi" onClick={() => copyPath(relPath)}>
        <span className="mi-ic">
          <Icon name={copiedPath === relPath ? "check" : "copy"} size={14} />
        </span>
        {copiedPath === relPath ? t("common.copied") : t("right.copyRelPath")}
      </button>
      {mdView && (
        <>
          <div className="sep" />
          <div className="mh">{t("right.mdGroup")}</div>
          <button
            type="button"
            className="mi"
            disabled={!mdView.previewable}
            title={mdView.previewable ? undefined : t("right.mdTooLarge")}
            onClick={() => {
              onClose();
              mdView.onPick(true);
            }}
          >
            <span className="mi-ic">
              <Icon name="eye" size={14} />
            </span>
            {t("right.mdPreview")}
            <span className="fv-ck">{mdView.preview ? <Icon name="check" size={13} /> : null}</span>
          </button>
          <button
            type="button"
            className="mi"
            onClick={() => {
              onClose();
              mdView.onPick(false);
            }}
          >
            <span className="mi-ic">
              <Icon name="file" size={14} />
            </span>
            {t("right.mdSource")}
            <span className="fv-ck">{mdView.preview ? null : <Icon name="check" size={13} />}</span>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

function FileMoreMenu({ target, root, mdView, file, trigger = "dots" }: {
  target: string;
  root: string;
  mdView?: { preview: boolean; previewable: boolean; onPick: (v: boolean) => void };
  /** File page only (an opened file, not the tree root directory): adds reveal + save-as */
  file?: boolean;
  /** "open" = the combined "Open" pill in the title bar, "dots" = the file-tree root row glyph */
  trigger?: "dots" | "open";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="fv-more-wrap">
      {trigger === "open" ? (
        <button
          type="button"
          className="fv-open-btn"
          ref={btnRef}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {t("right.open")}
          <Icon name="chevronDown" size={12} />
        </button>
      ) : (
        <button
          type="button"
          className="icon-btn"
          ref={btnRef}
          title={t("right.more")}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          <Icon name="dots" size={15} />
        </button>
      )}
      <OpenWithMenu target={target} root={root} mdView={mdView} file={file} open={open} onClose={() => setOpen(false)} anchor={btnRef} />
    </div>
  );
}

// Navigation pane: search box on top, then the project root row (more / refresh),
// then the tree — or the flat search results while a query is active (ZCode behavior).
// Results come from list_files (host fuzzyFind, the composer @-mention engine) tagged
// target:"fileTab" so the reply lands in rightState.fileSearch instead of the composer list.
function FileNav() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const fileSearch = useAppStore((st) => st.rightState.fileSearch);
  const [q, setQ] = useState("");
  const [reqId, setReqId] = useState(0);
  // Session switch resets the box: pending results belong to the old project's cwd
  useEffect(() => { setQ(""); }, [s?.cwd]);
  // Debounced search (the host fuzzyFind is a disk scan); reqId comes from the shared
  // mentionReqSeq counter so composer @-mention replies can't be confused with these
  useEffect(() => {
    const kw = q.trim();
    if (!kw) return;
    const timer = setTimeout(() => {
      const st = useAppStore.getState();
      const sess = st.activePath ? st.openSessions.get(st.activePath) : undefined;
      if (!sess) return;
      const id = st.mentionReqSeq + 1;
      useAppStore.setState({ mentionReqSeq: id });
      setReqId(id);
      send({ type: "list_files", sessionId: sess.sessionId, query: kw, reqId: id, target: "fileTab" });
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  if (!s) {
    return <div className="py-3 text-faint text-ui-base">{t("right.noActiveSession")}</div>;
  }
  const kw = q.trim();
  const results = kw && fileSearch && fileSearch.reqId === reqId ? fileSearch.matches : null;
  // Directory hit: expand its whole chain in the tree and drop back to the tree view
  const openDir = (rel: string) => {
    useAppStore.setState((st) => {
      const fileTreeExpanded = new Set(st.rightState.fileTreeExpanded);
      let acc = s.cwd;
      for (const seg of rel.split("/")) {
        acc += "/" + seg;
        fileTreeExpanded.add(acc);
      }
      return { rightState: { ...st.rightState, fileTreeExpanded } };
    });
    setQ("");
  };
  // Refresh: drop the level cache (and in-flight markers); expanded levels refetch on
  // render because their cache entry is gone — expanded state itself is preserved
  const refreshTree = () => {
    useAppStore.setState((st) => ({
      rightState: { ...st.rightState, fileTreeDirs: new Map(), fileTreePending: new Set() },
    }));
  };
  return (
    <>
      <div className="fp-search flex items-center gap-1.5 my-2 px-1.5 py-[3px] rounded-sm border border-line text-ui-sm text-dim">
        <Icon name="search" size={12} />
        <input
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-ui-sm text-text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("right.searchFiles")}
        />
        {q && (
          <button
            className="border-0 bg-transparent text-faint cursor-pointer p-0.5 hover:text-text"
            onClick={() => setQ("")}
            title={t("common.close")}
          >
            <Icon name="xmark" size={11} />
          </button>
        )}
      </div>
      <div
        className="flex items-center gap-1.5 text-ui-base text-text font-medium cursor-default py-[3px] px-1.5 rounded-sm whitespace-nowrap overflow-hidden text-ellipsis"
        title={s.cwd}
      >
        <span className="inline-flex items-center text-faint">
          <Icon name="folder" size={14} />
        </span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{pathBase(s.cwd) || s.cwd}</span>
        <FileMoreMenu target={s.cwd} root={s.cwd} />
        <button
          type="button"
          className="icon-btn"
          title={t("right.refreshTree")}
          onClick={refreshTree}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {kw ? (
        results === null ? (
          <div className="py-3 text-faint text-ui-base">{t("common.loading")}</div>
        ) : results.length === 0 ? (
          <div className="py-3 text-faint text-ui-base">{t("right.noFileMatches")}</div>
        ) : (
          results.map((m) => {
            const segs = m.path.split("/");
            const tail = segs[segs.length - 1];
            return (
              <div
                key={m.path}
                className="fp-row flex items-center gap-1.5 text-ui-base text-dim rounded-sm cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis hover:bg-hover-fill"
                title={s.cwd + "/" + m.path}
                onClick={() => (m.dir ? openDir(m.path) : openFileView(s.cwd + "/" + m.path))}
              >
                <span className="ft-caret ft-file-ic">
                  <Icon name={m.dir ? "folder" : fileTypeIcon(tail)} />
                </span>
                <span className="min-w-0 overflow-hidden text-ellipsis">
                  {segs.length > 1 && <span className="text-faint">{segs.slice(0, -1).join(" / ")} / </span>}
                  {tail}
                  {m.dir ? "/" : ""}
                </span>
              </div>
            );
          })
        )
      ) : (
        <FileTreeLevel dirPath={s.cwd} depth={1} />
      )}
    </>
  );
}

// Single-level render: send list_dir on cache miss (pending set prevents duplicates; the
// dir_list reply lands in the store cache)
function FileTreeLevel({ dirPath, depth }: { dirPath: string; depth: number }) {
  const { t } = useTranslation();
  const rightState = useAppStore((s) => s.rightState);
  const entries = rightState.fileTreeDirs.get(dirPath);
  // The list_dir request formerly in the render body moved into an effect; dedup and cache-hit
  // reads use getState (state may have advanced between render and effect). `entries` is a
  // dependency because refreshTree clears the cache without remounting this level — keyed on
  // dirPath alone the level would sit on "loading" forever after a refresh.
  useEffect(() => {
    const rs = useAppStore.getState().rightState;
    if (rs.fileTreeDirs.get(dirPath) !== undefined) return;
    if (rs.fileTreePending.has(dirPath)) return;
    useAppStore.setState((st) => ({
      rightState: { ...st.rightState, fileTreePending: new Set([...st.rightState.fileTreePending, dirPath]) },
    }));
    send({ type: "list_dir", path: dirPath });
  }, [dirPath, entries]);
  if (entries === undefined) {
    return <div className="py-3 text-faint text-ui-base">{t("common.loading")}</div>;
  }
  return (
    <>
      {entries.map((e) => {
        const full = dirPath + "/" + e.name;
        if (e.dir) {
          const expanded = rightState.fileTreeExpanded.has(full);
          return (
            <Fragment key={full}>
              <div
                className="fp-row flex items-center gap-1.5 text-ui-base text-dim rounded-sm cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis hover:bg-hover-fill"
                style={{ paddingLeft: 6 + (depth - 1) * 14 + "px" }}
                onClick={() => {
                  // Expand/collapse: fresh Set + fresh rightState reference (subscribers notice by reference)
                  useAppStore.setState((st) => {
                    const fileTreeExpanded = new Set(st.rightState.fileTreeExpanded);
                    if (fileTreeExpanded.has(full)) fileTreeExpanded.delete(full);
                    else fileTreeExpanded.add(full);
                    return { rightState: { ...st.rightState, fileTreeExpanded } };
                  });
                }}
              >
                <span className={"ft-caret" + (expanded ? " open" : "")}>
                  <Icon name="chevronRight" size={10} />
                </span>
                <span className="min-w-0 overflow-hidden text-ellipsis">{e.name}</span>
              </div>
              {expanded && <FileTreeLevel dirPath={full} depth={depth + 1} />}
            </Fragment>
          );
        }
        return (
          <div
            key={full}
            className="fp-row flex items-center gap-1.5 text-ui-base text-dim rounded-sm cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis hover:bg-hover-fill"
            style={{ paddingLeft: 6 + (depth - 1) * 14 + "px" }}
            title={full}
            onClick={() => openFileView(full)}
          >
            <span className="ft-caret ft-file-ic">
              <Icon name={fileTypeIcon(e.name)} />
            </span>
            <span className="min-w-0 overflow-hidden text-ellipsis">{e.name}</span>
          </div>
        );
      })}
    </>
  );
}

// Click a file: images branch to read_image for preview (host 8MB cap + extension
// whitelist), everything else sends read_file
function openFileView(full: string) {
  if (IMAGE_EXTS[full.split(".").pop()?.toLowerCase() ?? ""]) {
    openImageFileView(full);
  } else {
    setBump({ fileView: { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null }, fileViewPending: full });
    send({ type: "read_file", path: full });
  }
}

// Image file view: renders immediately, the read_image reply fills rightState.imageContent.
// Shared with the message stream (read rows / inline image chips in markdown).
export function openImageFileView(full: string) {
  setBump({ fileView: { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null, image: true }, fileViewPending: full });
  send({ type: "read_image", path: full });
}

// File actions shown in the page title bar: one "Open" pill that reveals the whole menu (open-with
// list, reveal in the file manager, save-as, path copy, markdown mode). It sits in the title bar
// instead of a detail header row, so the detail itself carries no title.
function FileTabActions() {
  const fv = useAppStore((s) => s.fileView);
  const cwd = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.cwd : undefined));
  if (!fv) return null;
  const isMd = MD_VIEW_RE.test(fv.path);
  const previewable = isMd && (fv.text ?? "").length <= MD_PREVIEW_MAX_CHARS;
  return (
    <FileMoreMenu
      target={fv.path}
      root={cwd || ""}
      trigger="open"
      file
      mdView={isMd ? { preview: fv.mdPreview ?? isMd, previewable, onPick: (v) => setBump({ fileView: { ...fv, mdPreview: v } }) } : undefined}
    />
  );
}

// File detail: render the read content first, switch to the whole file after the read_file
// reply (request-range line highlighting + start line scrolled to top). Header-free: the path
// lives in the page title bar, the actions in the tab head.
function FvDetail() {
  const { t } = useTranslation();
  const fv = useAppStore((s) => s.fileView)!; // assertion: FilePage's entry if (fileView) already guards, same as the original
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const isMd = MD_VIEW_RE.test(fv.path);
  // Markdown opens in rendered preview (ZCode parity); the picked mode travels with the view
  // state, so a non-md file never inherits a stale toggle
  const mdPreview = fv.mdPreview ?? isMd;
  const previewable = isMd && (fv.text ?? "").length <= MD_PREVIEW_MAX_CHARS;
  // Once the whole file is ready, scroll the request range's start line to the top of the view
  useEffect(() => {
    if (!fv.full || fv.reqRange == null) return;
    bodyRef.current?.querySelector(".fv-ln.hl")?.scrollIntoView({ block: "start" });
  });
  // ⌘/Ctrl+A over the file text selects only this file's rows: the WebView default selects the
  // whole app (sidebar, chat, this view). A click on non-focusable text leaves focus on body, so
  // the scope is the event target, the live selection anchor, or the last pointerdown — the same
  // pointer-scope fallback keys.ts uses for the hub gesture.
  // shortcut: an over-long file only exposes its rendered window (virtualized rows), so select-all
  // stops at that window; extend if full-file selection is ever needed.
  useEffect(() => {
    let inBody = false;
    const onPointerDown = (e: PointerEvent) => {
      inBody = e.target instanceof Node && !!bodyRef.current?.contains(e.target);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "a" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const body = bodyRef.current;
      if (!body) return;
      const anchor = window.getSelection()?.anchorNode;
      const scoped = inBody || (e.target instanceof Node && body.contains(e.target)) || (!!anchor && body.contains(anchor));
      if (!scoped) return;
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(body);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
  return (
    <div className="rb-scroll">
      {/* Image preview: rendered once the read_image reply (store puts it in rightState.imageContent) arrives */}
      {fv.image ? (
        <FvImage fv={fv} />
      ) : !fv.text && !fv.error ? (
        <div className="py-3 text-faint text-ui-base">{t("common.loading")}</div>
      ) : (
        <>
          {fv.error && (
            <div className="text-ui-xs text-faint mt-2">{t("right.errorParen", { error: fv.error })}</div>
          )}
          {isMd && mdPreview && previewable ? (
            <div className="pt-1 pb-3 px-[5px] max-w-[900px]">
              <MdSurface text={fv.text ?? ""} />
            </div>
          ) : (
            <FvBody key={fv.path} fv={fv} bodyRef={bodyRef} />
          )}
        </>
      )}
    </div>
  );
}

// Rendered window of the sliding-window view. A whole file over the first-window
// threshold keeps a constant band of rows in the DOM: BACKUP rows before the first
// visible row, the rest behind. Off-window rows collapse into top/bottom spacers
// built from the exact row-height formula (var(--code-fs) × 1.55, same as the row
// boxes), so total scroll height always equals the true file height and re-anchoring
// never shifts content. Re-anchor (translate the whole band) only when the visible
// row drifts within RELINE of a window edge — a hysteresis band so normal page
// scrolling doesn't thrash re-renders.
const WINDOW_LINES = 1500;
const BACKUP_LINES = 500;
const RELINE_LINES = 300;

// Text content: line numbers + text. Over-long whole files render as the sliding
// window above; syntax coloring tokenizes exactly the rendered window (existing
// HIGHLIGHT_MAX_CHARS cap applies as before). Content is already fully in memory,
// so window moves are pure rendering — no extra requests.
function FvBody({ fv, bodyRef }: { fv: FileViewState; bodyRef: RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation();
  const lines = (fv.text ?? "").split("\n"); // text is always present (protocol data); the ?? "" is only a type fallback, same as the original under the protocol
  if (lines[lines.length - 1] === "") lines.pop(); // a trailing newline doesn't count as a line
  const [reqStart, reqEnd] = fv.reqRange || [];
  const expandable = !!fv.full && lines.length > FILE_VIEW_MAX_LINES;
  // Anchor = first visible row (1-based); null until the user scrolls, pinning the
  // initial view to the request range (or the file top). Remounts reset it
  // (FvDetail keys FvBody by path).
  const [anchor, setAnchor] = useState<number | null>(null);
  const first = Math.max(1, anchor ?? (reqStart ?? 1));
  const winStart = expandable
    ? Math.max(0, Math.min(first - 1 - BACKUP_LINES, lines.length - WINDOW_LINES))
    : 0;
  const winLen = expandable ? Math.min(WINDOW_LINES, lines.length - winStart) : lines.length;
  const shown = expandable ? lines.slice(winStart, winStart + winLen) : lines;
  const winStartLine = winStart + 1;
  const lineNoOf = (i: number): number | null | undefined => (fv.lineNumbers ? fv.lineNumbers[i] : winStartLine + i);
  const tokens = useCodeTokens(shown.join("\n"), langOfPath(fv.path));

  // Scroll driver: measure the live row height each frame (zoom-safe), derive the
  // first visible row, and re-anchor on edge drift. The re-anchor commits
  // synchronously (flushSync): the browser paints after the scroll handler
  // returns, so the window must be committed by then — async React scheduling
  // would paint the old window at the new scroll offset and show blank spacer
  // rows while fling-scrolling.
  useEffect(() => {
    if (!expandable) return;
    const scroller = bodyRef.current?.closest(".rb-scroll");
    if (!(scroller instanceof Element)) return;
    const onScroll = () => {
      const row = scroller.querySelector<HTMLElement>("[data-fv-row]");
      // clientHeight is layout px (zoom-independent), matching scrollTop and the
      // calc()-based spacer rows; getBoundingClientRect would return visual px
      const lineH = row ? row.clientHeight : 0;
      if (lineH <= 0) return;
      const firstVisible = Math.floor(scroller.scrollTop / lineH) + 1;
      if (firstVisible - 1 < winStart + RELINE_LINES || firstVisible - 1 > winStart + winLen - RELINE_LINES) {
        flushSync(() => setAnchor(firstVisible));
      }
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [expandable, winStart, winLen, lines.length]);

  const topPad = expandable ? winStart : 0;
  const bottomPad = expandable ? lines.length - winStart - winLen : 0;
  const padStyle = (n: number): CSSProperties | undefined =>
    n > 0 ? { height: `calc(var(--code-fs, 12px) * 1.55 * ${n})` } : undefined;

  return (
    <>
      <div className="pt-1 pb-1 font-mono text-[length:var(--code-fs,12px)] leading-[1.55] overflow-x-auto" /* style-token-ignore */ ref={bodyRef}>
        {topPad > 0 && <div style={padStyle(topPad)} />}
        {shown.map((tx, i) => {
          const n = lineNoOf(i);
          // Only the line-number column is highlighted within the requested range, content untouched; null = hole lines omitted by the tool
          const hl = n != null && reqStart != null && reqEnd != null && n >= reqStart && n <= reqEnd;
          return (
            <div key={winStart + i} data-fv-row={i === 0 ? "" : undefined} className="flex items-baseline">
              <span className={"fv-ln" + (hl ? " hl" : "")}>{n == null ? "…" : String(n)}</span>
              <span className="whitespace-pre text-dim [tab-size:4]">{tokens?.[i] ? <CodeTokens line={tokens[i]} /> : tx === "" ? " " : tx}</span>
            </div>
          );
        })}
        {bottomPad > 0 && <div style={padStyle(bottomPad)} />}
      </div>
      {bottomPad > 0 && (
        <div className="text-ui-xs text-faint mt-2">
          {t("right.fileWindow", { total: lines.length, start: winStartLine, end: winStartLine + shown.length - 1 })}
        </div>
      )}
    </>
  );
}

// Image detail: image_content replies matched by path (over-limit/failure replies error → the error-state text shows)
function FvImage({ fv }: { fv: FileViewState }) {
  const { t } = useTranslation();
  const ic = useAppStore((s) => s.rightState.imageContent);
  if (!ic || ic.path !== fv.path) {
    return <div className="py-3 text-faint text-ui-base">{t("common.loading")}</div>;
  }
  if (ic.error) {
    return <div className="text-ui-xs text-faint mt-2">{t("right.errorParen", { error: ic.error })}</div>;
  }
  return <img className="block max-w-full h-auto bg-panel-2 border border-line rounded-md p-1.5 box-border" src={`data:${ic.mime};base64,${ic.data}`} alt={pathBase(fv.path)} />;
}
