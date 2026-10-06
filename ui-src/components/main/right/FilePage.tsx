// File page: empty state is the current project's file tree (lazily loaded one level per
// expand); clicking a file enters the detail
// (read_file for whole files / read_image for image previews; rb-head breadcrumb pinned +
// scrolling rb-scroll skeleton).
import { Fragment, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump, send, pathBase } from "../../../store";
import { fileTypeIcon } from "../../../../ui/icons";
import Icon from "../../../Icon";
import { langOfPath } from "../../../lib/highlighter";
import { CodeTokens, useCodeTokens } from "../../../lib/CodeTokens";
import type { FileViewState } from "../../../types/session";

const FILE_VIEW_MAX_LINES = 800; // display window for over-long whole files: start at the request range's first line when present, otherwise from the top
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]); // matches the host's read_image whitelist

export default function FilePage() {
  const fileView = useAppStore((s) => s.fileView);
  if (fileView) return <FvDetail />;
  return <FileTree />; // empty state: current project file tree
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
        <span className="min-w-0 overflow-hidden text-ellipsis">{pathBase(s.cwd) || s.cwd}</span>
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
  if (IMAGE_EXTS.has(full.split(".").pop() ?? "")) {
    setBump({ fileView: { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null, image: true }, fileViewPending: full });
    send({ type: "read_image", path: full });
  } else {
    setBump({ fileView: { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null }, fileViewPending: full });
    send({ type: "read_file", path: full });
  }
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
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Once the whole file is ready, scroll the request range's start line to the top of the view
  useEffect(() => {
    if (!fv.full || fv.reqRange == null) return;
    bodyRef.current?.querySelector(".fv-ln.hl")?.scrollIntoView({ block: "start" });
  });
  return (
    <>
      <div className="rb-head">
        <button
          className="self-start mb-1.5 border-0 bg-transparent text-dim text-ui-sm cursor-pointer py-0.5 px-1.5 rounded-sm hover:bg-panel-2 hover:text-text"
          onClick={() => {
            setBump({ fileView: null });
          }}
        >
          {t("right.backToTree")}
        </button>
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
            <FvBody fv={fv} bodyRef={bodyRef} />
          </>
        )}
      </div>
    </>
  );
}

// Text content: line numbers + text; over-long whole files cut to an 800-line window (start
// aligned with the request range's first line).
// Syntax coloring: the visible window is tokenized in one pass (cap see highlighter.js),
// spans re-attached per line
function FvBody({ fv, bodyRef }: { fv: FileViewState; bodyRef: RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation();
  const lines = (fv.text ?? "").split("\n"); // text is always present (protocol data); the ?? "" is only a type fallback, same as the original under the protocol
  if (lines[lines.length - 1] === "") lines.pop(); // a trailing newline doesn't count as a line
  const [reqStart, reqEnd] = fv.reqRange || [];
  let winStartLine = fv.startLine || 1;
  let shown = lines;
  if (fv.full && lines.length > FILE_VIEW_MAX_LINES) {
    const winStart = reqStart != null ? Math.max(0, Math.min(reqStart - 1, lines.length - FILE_VIEW_MAX_LINES)) : 0;
    shown = lines.slice(winStart, winStart + FILE_VIEW_MAX_LINES);
    winStartLine = winStart + 1;
  }
  const lineNoOf = (i: number): number | null | undefined => (fv.lineNumbers ? fv.lineNumbers[i] : winStartLine + i);
  const tokens = useCodeTokens(shown.join("\n"), langOfPath(fv.path));
  return (
    <>
      <div className="pt-1 pb-1 font-mono text-[length:var(--code-fs,12px)] leading-[1.55] overflow-x-auto" /* style-token-ignore */ ref={bodyRef}>
        {shown.map((tx, i) => {
          const n = lineNoOf(i);
          // Only the line-number column is highlighted within the requested range, content untouched; null = hole lines omitted by the tool
          const hl = n != null && reqStart != null && reqEnd != null && n >= reqStart && n <= reqEnd;
          return (
            <div key={i} className="flex items-baseline">
              <span className={"fv-ln" + (hl ? " hl" : "")}>{n == null ? "…" : String(n)}</span>
              <span className="whitespace-pre text-dim [tab-size:4]">{tokens?.[i] ? <CodeTokens line={tokens[i]} /> : tx === "" ? " " : tx}</span>
            </div>
          );
        })}
      </div>
      {fv.full && lines.length > shown.length && (
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
