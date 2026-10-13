// File page: empty state is the current project's file tree (lazily loaded one level per
// expand); clicking a file enters the detail
// (read_file for whole files / read_image for image previews; rb-head breadcrumb pinned +
// scrolling rb-scroll skeleton).
import { flushSync, createPortal } from "react-dom";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump, send, pathBase, toast } from "../../../store";
import { placeMenu } from "../../../shell";
import { fileTypeIcon } from "../../../../ui/icons";
import Icon from "../../../Icon";
import { langOfPath } from "../../../lib/highlighter";
import { CodeTokens, useCodeTokens } from "../../../lib/CodeTokens";
import type { EditorInfo } from "../../../types/frames";
import type { FileViewState } from "../../../types/session";
import { IMAGE_EXTS } from "../../chat/util";

const FILE_VIEW_MAX_LINES = 800; // display window for over-long whole files: start at the request range's first line when present, otherwise from the top

export default function FilePage() {
  const fileView = useAppStore((s) => s.fileView);
  if (fileView) return <FvDetail />;
  return <FileTree />; // empty state: current project file tree
}

// More menu on the project row / the back-to-tree row: open the target in one of the installed
// editors/terminals/file managers (discovered on the host, real app icons), or copy its absolute
// / relative path. Relative paths are taken against the session project root, so the row's own
// dir yields ".". Fallback glyphs cover entries whose icon could not be resolved.
const FALLBACK_ICON: Record<EditorInfo["kind"], string> = {
  fileManager: "folderOpen",
  editor: "code",
  terminal: "term",
};

function FileMoreMenu({ target, root }: { target: string; root: string }) {
  const { t } = useTranslation();
  const editors = useAppStore((s) => s.editors);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Discovered once per host run; the first menu in the right panel triggers the fetch
  useEffect(() => {
    if (editors === null) send({ type: "list_editors" });
  }, [editors]);
  // The menu portals to body (fixed + placeMenu): the row containers crop with overflow:hidden,
  // so an absolutely positioned menu would be clipped. Measured placement, right edge on the
  // trigger, viewport-clamped (same recipe as the automations .auto-sel-menu).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const btn = btnRef.current;
    if (!open || !menu || !btn) return;
    placeMenu(menu, 0, 0); // measure at the origin: zoom is applied first, coordinates divided back after
    const mr = menu.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(br.right - mr.width, window.innerWidth - mr.width - 8));
    const top = Math.max(8, Math.min(br.bottom + 4, window.innerHeight - mr.height - 8));
    placeMenu(menu, left, top);
  }, [open, editors]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  const openIn = (editorId: string) => {
    setOpen(false);
    send({ type: "open_with", editorId, path: target });
  };
  const copyPath = (text: string) => {
    setOpen(false);
    navigator.clipboard
      .writeText(text)
      .then(() => toast(t("right.pathCopied")))
      .catch(() => toast(t("right.copyFailed")));
  };
  // Normalize Windows backslashes so the prefix strip works on every platform
  const abs = target.replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const relPath = !rel || abs === rel ? "." : abs.startsWith(rel + "/") ? abs.slice(rel.length + 1) : abs;

  return (
    <div className="fv-more-wrap" ref={wrapRef}>
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
      {open &&
        createPortal(
          <div className="menu open fv-menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <div className="mh">{t("right.openWithTitle")}</div>
            {editors === null ? (
              <div className="mi empty">{t("common.loading")}</div>
            ) : editors.length === 0 ? (
              <div className="mi empty">{t("right.noOpenApps")}</div>
            ) : (
              editors.map((editor) => (
                <button type="button" key={editor.id} className="mi" onClick={() => openIn(editor.id)}>
                  <span className="mi-ic">
                    {editor.iconDataUrl ? (
                      <img src={editor.iconDataUrl} alt="" />
                    ) : (
                      <Icon name={FALLBACK_ICON[editor.kind]} size={14} />
                    )}
                  </span>
                  {editor.name}
                </button>
              ))
            )}
            <div className="sep" />
            <button type="button" className="mi" onClick={() => copyPath(target)}>
              <span className="mi-ic">
                <Icon name="copy" size={14} />
              </span>
              {t("right.copyAbsPath")}
            </button>
            <button type="button" className="mi" onClick={() => copyPath(relPath)}>
              <span className="mi-ic">
                <Icon name="copy" size={14} />
              </span>
              {t("right.copyRelPath")}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

// Empty state: current project file tree (lazily loaded one level per expand; click a file to enter detail)
function FileTree() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  if (!s) {
    return <div className="py-3 text-faint text-ui-base">{t("right.noActiveSession")}</div>;
  }
  return (
    <>
      <div
        className="flex items-center gap-1.5 text-ui-base text-text font-medium cursor-default py-[3px] px-2 rounded-sm whitespace-nowrap overflow-hidden text-ellipsis"
        title={s.cwd}
      >
        <span className="inline-flex items-center text-faint">
          <Icon name="folder" size={14} />
        </span>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{pathBase(s.cwd) || s.cwd}</span>
        <FileMoreMenu target={s.cwd} root={s.cwd} />
      </div>
      <FileTreeLevel dirPath={s.cwd} depth={1} />
    </>
  );
}

// Single-level render: send list_dir on cache miss (pending set prevents duplicates; the
// dir_list reply lands in the store cache)
function FileTreeLevel({ dirPath, depth }: { dirPath: string; depth: number }) {
  const { t } = useTranslation();
  const rightState = useAppStore((s) => s.rightState);
  // The list_dir request formerly in the render body moved into an effect; dedup and cache-hit
  // reads use getState (state may have advanced between render and effect)
  useEffect(() => {
    const rs = useAppStore.getState().rightState;
    if (rs.fileTreeDirs.get(dirPath) !== undefined) return;
    if (rs.fileTreePending.has(dirPath)) return;
    useAppStore.setState((st) => ({
      rightState: { ...st.rightState, fileTreePending: new Set([...st.rightState.fileTreePending, dirPath]) },
    }));
    send({ type: "list_dir", path: dirPath });
  }, [dirPath]);
  const entries = rightState.fileTreeDirs.get(dirPath);
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
                className="flex items-center gap-1.5 text-ui-base text-dim py-[3px] px-2 rounded-sm cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis hover:bg-panel-2"
                style={{ paddingLeft: 6 + depth * 14 + "px" }}
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
            className="flex items-center gap-1.5 text-ui-base text-dim py-[3px] px-2 rounded-sm cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis hover:bg-panel-2"
            style={{ paddingLeft: 6 + depth * 14 + "px" }}
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

// File path breadcrumb: inside the project "project name › relative segments", full path
// outside; separator uses the right-chevron icon
function FileCrumb({ absPath }: { absPath: string }) {
  const cwd = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.cwd : undefined));
  // Normalize Windows backslash paths to "/" first, else the prefix match fails and the whole
  // path renders as one segment
  const root = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  let segs: (string | undefined)[];
  if (root && abs.startsWith(root + "/")) {
    segs = [root.split("/").filter(Boolean).pop(), ...abs.slice(root.length + 1).split("/")];
  } else {
    segs = abs.split("/").filter(Boolean);
  }
  return (
    <div className="flex items-center gap-0.5 text-ui-xs text-faint mb-2 overflow-hidden whitespace-nowrap" title={absPath}>
      {segs.map((seg, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="flex-none inline-flex items-center">
              <Icon name="chevronRight" size={10} />
            </span>
          )}
          <span className="min-w-0 overflow-hidden text-ellipsis last:text-dim last:font-medium">{seg}</span>
        </Fragment>
      ))}
    </div>
  );
}

// File detail: render the read content first, switch to the whole file after the read_file
// reply (request-range line highlighting + start line scrolled to top)
function FvDetail() {
  const { t } = useTranslation();
  const fv = useAppStore((s) => s.fileView)!; // assertion: FilePage's entry if (fileView) already guards, same as the original
  const cwd = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.cwd : undefined));
  const bodyRef = useRef<HTMLDivElement | null>(null);
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
    <>
      <div className="rb-head">
        <div className="flex items-center gap-1.5 mb-1.5">
          <button
            className="border-0 bg-transparent text-dim text-ui-sm cursor-pointer py-0.5 px-1.5 rounded-sm hover:bg-panel-2 hover:text-text"
            onClick={() => {
              setBump({ fileView: null });
            }}
          >
            {t("right.backToTree")}
          </button>
          <span className="sp" />
          <FileMoreMenu target={fv.path} root={cwd || ""} />
        </div>
        <FileCrumb absPath={fv.path} />
      </div>
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
            <FvBody key={fv.path} fv={fv} bodyRef={bodyRef} />
          </>
        )}
      </div>
    </>
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
      const lineH = row ? row.getBoundingClientRect().height : 0;
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
