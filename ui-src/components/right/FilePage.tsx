// 文件页：空态为当前项目文件树（懒加载单层展开），点击文件进详情
//（read_file 整文件 / read_image 图片预览；rb-head 面包屑固定 + rb-scroll 滚动骨架）。
import { Fragment, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { S, useStore, notify, send, activeOpen, rightState } from "../../store";
import { fileTypeIcon } from "../../../ui/icons";
import Icon from "../../Icon";
import { langOfPath } from "../../lib/highlighter";
import { CodeTokens, useCodeTokens } from "../../lib/CodeTokens";
import type { FileViewState } from "../../types/session";

const FILE_VIEW_MAX_LINES = 800; // 全文件超长时的展示窗口：有读取范围则以范围起始行开头，否则从头
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]); // 与宿主 read_image 白名单一致

export default function FilePage() {
  useStore();
  if (S.fileView) return <FvDetail />;
  return <FileTree />; // 空态：当前项目文件树
}

// 空态：当前项目文件树（懒加载单层展开；点击文件进详情）
function FileTree() {
  const s = activeOpen();
  if (!s) {
    return <div className="placeholder">（无活跃会话）</div>;
  }
  return (
    <>
      <div className="ft-row ft-root" title={s.cwd}>
        <span className="ft-ic">
          <Icon name="folder" size={14} />
        </span>
        <span className="ft-name">{s.cwd.split("/").filter(Boolean).pop() || s.cwd}</span>
      </div>
      <FileTreeLevel dirPath={s.cwd} depth={1} />
    </>
  );
}

// 单层渲染：缓存未命中时发起 list_dir（pending 集合防重，dir_list 回包由 store 落缓存）
function FileTreeLevel({ dirPath, depth }: { dirPath: string; depth: number }) {
  const entries = rightState.fileTreeDirs.get(dirPath);
  if (entries === undefined) {
    if (!rightState.fileTreePending.has(dirPath)) {
      rightState.fileTreePending.add(dirPath);
      send({ type: "list_dir", path: dirPath });
    }
    return <div className="placeholder">加载中…</div>;
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
                className="ft-row"
                style={{ paddingLeft: 6 + depth * 14 + "px" }}
                onClick={() => {
                  if (rightState.fileTreeExpanded.has(full)) rightState.fileTreeExpanded.delete(full);
                  else rightState.fileTreeExpanded.add(full);
                  notify();
                }}
              >
                <span className={"ft-caret" + (expanded ? " open" : "")}>
                  <Icon name="chevronRight" size={10} />
                </span>
                <span className="ft-name">{e.name}</span>
              </div>
              {expanded && <FileTreeLevel dirPath={full} depth={depth + 1} />}
            </Fragment>
          );
        }
        return (
          <div
            key={full}
            className="ft-row"
            style={{ paddingLeft: 6 + depth * 14 + "px" }}
            title={full}
            onClick={() => openFileView(full)}
          >
            <span className="ft-caret ft-file-ic">
              <Icon name={fileTypeIcon(e.name)} />
            </span>
            <span className="ft-name">{e.name}</span>
          </div>
        );
      })}
    </>
  );
}

// 点击文件：图片分叉发 read_image 走图片预览（宿主 8MB 上限 + 后缀白名单），其余发 read_file
function openFileView(full: string) {
  if (IMAGE_EXTS.has(full.split(".").pop() ?? "")) {
    S.fileView = { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null, image: true };
    S.fileViewPending = full;
    send({ type: "read_image", path: full });
  } else {
    S.fileView = { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null };
    S.fileViewPending = full;
    send({ type: "read_file", path: full });
  }
  notify();
}

// 文件路径面包屑：项目内「项目名 › 相对段」，项目外全路径；分隔符用向右箭头图标
function FileCrumb({ absPath }: { absPath: string }) {
  const root = (activeOpen()?.cwd || "").replace(/\/+$/, "");
  const abs = absPath.replace(/\/+$/, "");
  let segs: (string | undefined)[];
  if (root && abs.startsWith(root + "/")) {
    segs = [root.split("/").filter(Boolean).pop(), ...abs.slice(root.length + 1).split("/")];
  } else {
    segs = abs.split("/").filter(Boolean);
  }
  return (
    <div className="fv-crumb" title={absPath}>
      {segs.map((seg, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="fv-sep">
              <Icon name="chevronRight" size={10} />
            </span>
          )}
          <span className="fv-seg">{seg}</span>
        </Fragment>
      ))}
    </div>
  );
}

// 文件详情：先渲染读取到的内容，read_file 回包后切整文件（请求范围行号高亮 + 起始行滚到顶部）
function FvDetail() {
  const fv = S.fileView!; // 断言:FilePage 入口 if (S.fileView) 已守卫,与原版一致
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 全文件就绪后把读取范围起始行滚到可视区顶部
  useEffect(() => {
    if (!fv.full || fv.reqRange == null) return;
    bodyRef.current?.querySelector(".fv-ln.hl")?.scrollIntoView({ block: "start" });
  });
  return (
    <>
      <div className="rb-head">
        <button
          className="sub-back"
          onClick={() => {
            S.fileView = null;
            notify();
          }}
        >
          ‹ 文件树
        </button>
        <FileCrumb absPath={fv.path} />
      </div>
      <div className="rb-scroll">
        {/* 图片预览：read_image 回包（store 存入 rightState.imageContent）到达后渲染 */}
        {fv.image ? (
          <FvImage fv={fv} />
        ) : !fv.text && !fv.error ? (
          <div className="placeholder">加载中…</div>
        ) : (
          <>
            {fv.error && (
              <div className="fv-more">（{fv.error}）</div>
            )}
            <FvBody fv={fv} bodyRef={bodyRef} />
          </>
        )}
      </div>
    </>
  );
}

// 文本内容：行号 + 文本；全文件超长时截 800 行窗口（起点对齐请求范围的起始行）。
// 语法染色：可视窗口整段一次 tokenize（上限见 highlighter.js），按行回贴 span
function FvBody({ fv, bodyRef }: { fv: FileViewState; bodyRef: RefObject<HTMLDivElement | null> }) {
  const lines = (fv.text ?? "").split("\n"); // text 恒在(协议数据);?? "" 仅为类型兜底,协议下与原版一致
  if (lines[lines.length - 1] === "") lines.pop(); // 末尾换行不算一行
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
      <div className="fv-body" ref={bodyRef}>
        {shown.map((tx, i) => {
          const n = lineNoOf(i);
          // 请求的行号范围内只高亮行号列，不动内容；null = 工具省略的空洞行
          const hl = n != null && reqStart != null && reqEnd != null && n >= reqStart && n <= reqEnd;
          return (
            <div key={i} className="fv-line">
              <span className={"fv-ln" + (hl ? " hl" : "")}>{n == null ? "…" : String(n)}</span>
              <span className="fv-tx">{tokens?.[i] ? <CodeTokens line={tokens[i]} /> : tx === "" ? " " : tx}</span>
            </div>
          );
        })}
      </div>
      {fv.full && lines.length > shown.length && (
        <div className="fv-more">
          文件共 {lines.length} 行，当前展示第 {winStartLine}–{winStartLine + shown.length - 1} 行
        </div>
      )}
    </>
  );
}

// 图片详情：image_content 回包按 path 匹配（超限/失败回 error 时显示错误态文案）
function FvImage({ fv }: { fv: FileViewState }) {
  const ic = rightState.imageContent;
  if (!ic || ic.path !== fv.path) {
    return <div className="placeholder">加载中…</div>;
  }
  if (ic.error) {
    return <div className="fv-more">（{ic.error}）</div>;
  }
  return <img className="fv-img" src={`data:${ic.mime};base64,${ic.data}`} alt={fv.path.split("/").pop()} />;
}
