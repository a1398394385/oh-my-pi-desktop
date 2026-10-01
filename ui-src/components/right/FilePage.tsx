// 文件页：空态为当前项目文件树（懒加载单层展开），点击文件进详情
//（read_file 整文件 / read_image 图片预览；rb-head 面包屑固定 + rb-scroll 滚动骨架）。
import { Fragment, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump, send, pathBase } from "../../store";
import { fileTypeIcon } from "../../../ui/icons";
import Icon from "../../Icon";
import { langOfPath } from "../../lib/highlighter";
import { CodeTokens, useCodeTokens } from "../../lib/CodeTokens";
import type { FileViewState } from "../../types/session";

const FILE_VIEW_MAX_LINES = 800; // 全文件超长时的展示窗口：有读取范围则以范围起始行开头，否则从头
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]); // 与宿主 read_image 白名单一致

export default function FilePage() {
  const fileView = useAppStore((s) => s.fileView);
  if (fileView) return <FvDetail />;
  return <FileTree />; // 空态：当前项目文件树
}

// 空态：当前项目文件树（懒加载单层展开；点击文件进详情）
function FileTree() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  if (!s) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">{t("right.noActiveSession")}</div>;
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

// 单层渲染：缓存未命中时发起 list_dir（pending 集合防重，dir_list 回包由 store 落缓存）
function FileTreeLevel({ dirPath, depth }: { dirPath: string; depth: number }) {
  const { t } = useTranslation();
  const rightState = useAppStore((s) => s.rightState);
  // 原渲染体内的 list_dir 请求移入 effect；防重与缓存命中读 getState（渲染与 effect 之间状态可能已推进）
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
    return <div className="py-3 px-2.5 text-faint text-ui-base">{t("common.loading")}</div>;
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
                  // 展开/收起：换新 Set + 新 rightState 引用（订阅者按引用感知）
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

// 点击文件：图片分叉发 read_image 走图片预览（宿主 8MB 上限 + 后缀白名单），其余发 read_file
function openFileView(full: string) {
  if (IMAGE_EXTS.has(full.split(".").pop() ?? "")) {
    setBump({ fileView: { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null, image: true }, fileViewPending: full });
    send({ type: "read_image", path: full });
  } else {
    setBump({ fileView: { path: full, text: "", startLine: 1, lineNumbers: null, reqRange: null }, fileViewPending: full });
    send({ type: "read_file", path: full });
  }
}

// 文件路径面包屑：项目内「项目名 › 相对段」，项目外全路径；分隔符用向右箭头图标
function FileCrumb({ absPath }: { absPath: string }) {
  const cwd = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.cwd : undefined));
  // Windows 反斜杠路径先归一为 "/"，否则前缀匹配失败会把整条路径渲染成一个段
  const root = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = absPath.replace(/\\/g, "/").replace(/\/+$/, "");
  let segs: (string | undefined)[];
  if (root && abs.startsWith(root + "/")) {
    segs = [root.split("/").filter(Boolean).pop(), ...abs.slice(root.length + 1).split("/")];
  } else {
    segs = abs.split("/").filter(Boolean);
  }
  return (
    <div className="flex items-center gap-0.5 text-ui-xs text-faint mb-2 px-2 overflow-hidden whitespace-nowrap" title={absPath}>
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

// 文件详情：先渲染读取到的内容，read_file 回包后切整文件（请求范围行号高亮 + 起始行滚到顶部）
function FvDetail() {
  const { t } = useTranslation();
  const fv = useAppStore((s) => s.fileView)!; // 断言:FilePage 入口 if (fileView) 已守卫,与原版一致
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
        {/* 图片预览：read_image 回包（store 存入 rightState.imageContent）到达后渲染 */}
        {fv.image ? (
          <FvImage fv={fv} />
        ) : !fv.text && !fv.error ? (
          <div className="py-3 px-2.5 text-faint text-ui-base">{t("common.loading")}</div>
        ) : (
          <>
            {fv.error && (
              <div className="text-ui-xs text-faint mt-2 px-2">{t("right.errorParen", { error: fv.error })}</div>
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
  const { t } = useTranslation();
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
      <div className="pt-1 pr-2 pb-1 font-mono text-[length:var(--code-fs,12px)] leading-[1.55] overflow-x-auto" /* style-token-ignore */ ref={bodyRef}>
        {shown.map((tx, i) => {
          const n = lineNoOf(i);
          // 请求的行号范围内只高亮行号列，不动内容；null = 工具省略的空洞行
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
        <div className="text-ui-xs text-faint mt-2 px-2">
          {t("right.fileWindow", { total: lines.length, start: winStartLine, end: winStartLine + shown.length - 1 })}
        </div>
      )}
    </>
  );
}

// 图片详情：image_content 回包按 path 匹配（超限/失败回 error 时显示错误态文案）
function FvImage({ fv }: { fv: FileViewState }) {
  const { t } = useTranslation();
  const ic = useAppStore((s) => s.rightState.imageContent);
  if (!ic || ic.path !== fv.path) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">{t("common.loading")}</div>;
  }
  if (ic.error) {
    return <div className="text-ui-xs text-faint mt-2 px-2">{t("right.errorParen", { error: ic.error })}</div>;
  }
  return <img className="block max-w-full h-auto bg-panel-2 border border-line rounded-md p-1.5 box-border" src={`data:${ic.mime};base64,${ic.data}`} alt={pathBase(fv.path)} />;
}
