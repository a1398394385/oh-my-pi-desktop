// Git Diff 页：列表上方工具条（提交信息/提交/推送）+ 文件树/平铺 + 行内写操作 +
// 单文件 diff2html 详情（rb-head 固定 + rb-scroll 滚动骨架）。
import { useEffect, useReducer, useRef, useState } from "react";
import { S, useStore, notify, send, activeOpen, gitDiffCache, fileDiffCache, rightState, refreshGitDiff } from "../../store.js";
import Icon from "../../Icon.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";

// ---------- git 写操作 busy 闭环（原 right.js gitBusy 语义） ----------
// 进行中的写操作标记：{ op, prev }（prev = 发起前的 rightState.gitWrite 引用）。
// store 对 git 写回包不保证触发需要的行为（成功路径的 refreshGitDiff 在 cwd 未变时不发请求），
// 以 120ms 轮询比对 gitWrite 引用变化闭环——本地 git 操作毫秒级、push 秒级，轮询生命周期极短
let gitBusy = null;
let gitBusyTimer = null;
const GIT_WRITE_REPLY = { stage: "git_staged", unstage: "git_unstaged", discard: "git_discarded", commit: "git_committed", push: "git_pushed" };
function startGitBusy(op) {
  gitBusy = { op, prev: rightState.gitWrite };
  notify();
  clearInterval(gitBusyTimer);
  gitBusyTimer = setInterval(() => {
    const w = rightState.gitWrite;
    if (!gitBusy || !w || w === gitBusy.prev || w.type !== GIT_WRITE_REPLY[gitBusy.op]) return;
    if (w.ok && gitBusy.op === "commit") rightState.commitMsg = ""; // 提交成功清空输入框
    gitBusy = null;
    clearInterval(gitBusyTimer);
    refreshGitDiff(true); // 强制重拉（非 force 刷新在 cwd 未变时不发请求）
    notify();
  }, 120);
}

// 点击文件行进详情：请求单文件 diff
function requestFileDiff(s, filePath) {
  S.selectedFile = filePath;
  fileDiffCache.loading = true;
  fileDiffCache.path = filePath;
  send({ type: "get_file_diff", cwd: s.cwd, path: filePath });
  notify();
}

export default function GitDiffPage() {
  useStore();
  // 提交输入框局部重渲染（键入不打全局 notify，避免流式场景全 app 重渲）
  const [, force] = useReducer((x) => x + 1, 0);
  const [confirm, setConfirm] = useState(null);
  const s = activeOpen();
  if (!s) {
    return <div className="placeholder">（无活跃会话）</div>;
  }
  if (!s.isGit) {
    return <div className="placeholder">（该 project 不是 git 仓库）</div>;
  }
  if (S.selectedFile) {
    return <GdFileDetail />;
  }

  const busy = !!gitBusy;
  const hasStaged = gitDiffCache.files.some((f) => f.staged);
  // 丢弃是破坏性操作，走二次确认（cwd 取发起时刻的 activeOpen，对齐原 gitCwd 语义）
  const onDiscard = (f) => {
    setConfirm({
      title: "丢弃更改",
      message: `将丢弃 ${f.path} 的未提交更改，此操作不可恢复。`,
      confirmText: "丢弃",
      danger: true,
      onDone: (yes) => {
        setConfirm(null);
        if (!yes) return;
        const cwd = activeOpen()?.cwd;
        if (!cwd) return;
        send({ type: "git_discard", cwd, paths: [f.path] });
        startGitBusy("discard");
      },
    });
  };

  return (
    <>
      {/* 工具条：提交信息输入（值存 rightState.commitMsg 跨重绘保持）+ 提交（全部已暂存）+ 推送 */}
      <div className="gd-bar">
        <input
          className="inp gd-commit-inp"
          type="text"
          placeholder="提交信息"
          value={rightState.commitMsg}
          onChange={(e) => {
            rightState.commitMsg = e.target.value;
            force(); // 局部重渲染刷新提交钮 disabled
          }}
        />
        <button
          className={"save-btn" + (busy && gitBusy.op === "commit" ? " busy" : "")}
          title="提交全部已暂存的改动"
          disabled={!rightState.commitMsg.trim() || !hasStaged || busy}
          onClick={() => {
            const message = rightState.commitMsg.trim();
            if (!message) return;
            send({ type: "git_commit", cwd: s.cwd, message }); // 不带 paths = 提交全部已暂存
            startGitBusy("commit");
          }}
        >
          {busy && gitBusy.op === "commit" ? <Icon name="refresh" size={13} /> : "提交"}
        </button>
        <button
          className={"save-btn" + (busy && gitBusy.op === "push" ? " busy" : "")}
          title="推送当前分支"
          disabled={busy}
          onClick={() => {
            send({ type: "git_push", cwd: s.cwd });
            startGitBusy("push");
          }}
        >
          {busy && gitBusy.op === "push" ? <Icon name="refresh" size={13} /> : "推送"}
        </button>
      </div>
      {gitDiffCache.cwd !== s.cwd || gitDiffCache.loading ? (
        <div className="placeholder">{gitDiffCache.loading ? "加载中…" : "点右上角 ⟳ 加载改动"}</div>
      ) : gitDiffCache.files.length === 0 ? (
        <div className="placeholder">（工作区干净）</div>
      ) : S.gitViewMode === "flat" ? (
        gitDiffCache.files.map((f) => <GitFileRow key={f.path} f={f} displayPath={f.path} depth={0} onDiscard={onDiscard} />)
      ) : (
        <TreeLevel node={buildTree(gitDiffCache.files)} prefix="" depth={0} onDiscard={onDiscard} />
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </>
  );
}

// 文件详情：返回 + 路径固定在顶，diff 区滚动（diff2html 为外部库命令式 API，ref 容器注入）
function GdFileDetail() {
  const diffRef = useRef(null);
  useEffect(() => {
    const el = diffRef.current;
    if (!el) return;
    el.innerHTML = window.Diff2Html.html(fileDiffCache.diff, {
      drawFileList: false,
      outputFormat: "line-by-line",
      matching: "words",
      highlight: true,
    });
  });
  return (
    <>
      <div className="rb-head">
        <button
          className="sub-back"
          onClick={() => {
            S.selectedFile = null;
            notify();
          }}
        >
          ‹ 返回列表
        </button>
        <div className="sub-title">{S.selectedFile}</div>
      </div>
      <div className="rb-scroll">
        {fileDiffCache.loading && fileDiffCache.path === S.selectedFile ? (
          <div className="placeholder">加载中…</div>
        ) : fileDiffCache.path !== S.selectedFile || !fileDiffCache.diff ? (
          <div className="placeholder">（无差异内容）</div>
        ) : (
          <div
            ref={diffRef}
            className={"fd-holder" + (document.documentElement.dataset.theme === "dark" ? " d2h-dark-color-scheme" : "")}
          />
        )}
      </div>
    </>
  );
}

// 文件行：状态徽标 + 文件名 + 行内写操作（hover 显示，树/平铺两视图共用）
function GitFileRow({ f, displayPath, depth, onDiscard }) {
  const busy = !!gitBusy;
  const cwd = () => activeOpen()?.cwd; // cwd 取法对齐 refreshGitDiff（activeOpen().cwd）
  return (
    <div
      className={"gd-row" + (S.animateGdKids ? " kids-in" : "")}
      style={{ paddingLeft: 4 + depth * 14 + 14 + "px", animationDelay: depth * 15 + "ms" }}
      title={f.path}
      onClick={() => {
        const s = activeOpen();
        if (s) requestFileDiff(s, f.path);
      }}
    >
      <span className={"gd-badge " + badgeClass(f.code)}>
        {f.code.includes("A") || f.code === "?" ? "A" : f.code.includes("D") ? "D" : "M"}
      </span>
      <span className="gd-name">{displayPath.split("/").pop()}</span>
      <span className="gd-acts">
        {f.unstaged && (
          <button
            className="gd-act"
            title="暂存"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation(); // 不触发行点击的进详情
              const c = cwd();
              if (!c) return;
              send({ type: "git_stage", cwd: c, paths: [f.path] });
              startGitBusy("stage");
            }}
          >
            <Icon name="stage" />
          </button>
        )}
        {f.staged && (
          <button
            className="gd-act"
            title="取消暂存"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              const c = cwd();
              if (!c) return;
              send({ type: "git_unstage", cwd: c, paths: [f.path] });
              startGitBusy("unstage");
            }}
          >
            <Icon name="unstage" />
          </button>
        )}
        <button
          className="gd-act danger"
          title="丢弃（不可恢复）"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onDiscard(f);
          }}
        >
          <Icon name="discard" />
        </button>
      </span>
    </div>
  );
}

// 树视图：目录行（caret + 名 + 计数）+ 文件行，按目录深度缩进；展开时子行播入场动画
function TreeLevel({ node, prefix, depth, onDiscard }) {
  const rows = [];
  for (const [seg, dir] of node.dirs) {
    const dirPath = prefix ? prefix + "/" + seg : seg;
    const expanded = rightState.expandedDirs.has(dirPath);
    rows.push(
      <div
        key={"d:" + dirPath}
        className={"gd-row" + (S.animateGdKids ? " kids-in" : "")}
        style={{ paddingLeft: 4 + depth * 14 + "px", animationDelay: depth * 15 + "ms" }}
        onClick={() => {
          if (rightState.expandedDirs.has(dirPath)) {
            rightState.expandedDirs.delete(dirPath);
          } else {
            rightState.expandedDirs.add(dirPath);
            S.animateGdKids = true; // 本次重渲染的子行播入场动画
          }
          notify();
          setTimeout(() => {
            S.animateGdKids = false;
          }, 0);
        }}
      >
        <span className={"gd-caret" + (expanded ? " open" : "")}>
          <Icon name="chevronRight" size={10} />
        </span>
        <span className="gd-name">{seg}</span>
        <span className="gd-count">{countFiles(dir)}</span>
      </div>,
    );
    if (expanded) rows.push(<TreeLevel key={"l:" + dirPath} node={dir} prefix={dirPath} depth={depth + 1} onDiscard={onDiscard} />);
  }
  for (const f of node.files) {
    rows.push(<GitFileRow key={f.path} f={f} displayPath={f.path} depth={depth} onDiscard={onDiscard} />);
  }
  return <>{rows}</>;
}

function badgeClass(code) {
  if (code.includes("A") || code === "?") return "add";
  if (code.includes("D")) return "del";
  return "mod";
}

// 路径 → 目录树（目录有序 Map + 文件数组）
function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(f);
  }
  return root;
}

function countFiles(node) {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countFiles(d);
  return n;
}
