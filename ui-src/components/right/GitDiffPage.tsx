// Git Diff 页：列表上方工具条（提交信息/提交/推送）+ 文件树/平铺 + 行内写操作 +
// 单文件自研轻量 diff 详情（rb-head 固定 + rb-scroll 滚动骨架）。
import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useAppStore, setBump, send, activeOpen, refreshGitDiff } from "../../store";
import type { TimerHandle } from "../../store";
import Icon from "../../Icon";
import ConfirmDialog from "./ConfirmDialog";
import LightweightDiff from "../diff/LightweightDiff";
import { langOfPath } from "../../lib/highlighter";
import type { GitStatusFile } from "../../types/frames";

// git diff 文件条目用 types/frames 的 GitStatusFile(staged/unstaged 为状态字符,空串 = 无)
type GitFileEntry = GitStatusFile;

// 路径树节点（buildTree 产物）
interface GitTreeNode {
  dirs: Map<string, GitTreeNode>;
  files: GitFileEntry[];
}

// 丢弃确认弹窗的 state 形状（与 ConfirmDialog props 一致）
interface DiscardConfirm {
  title: string;
  message: string;
  confirmText: string;
  danger: boolean;
  onDone: (yes: boolean) => void;
}

type GitWriteOp = "stage" | "unstage" | "discard" | "commit" | "push";

// ---------- git 写操作 busy 闭环（原 right.js gitBusy 语义） ----------
// 进行中的写操作标记：{ op, prev }（prev = 发起前的 rightState.gitWrite 引用）。
// store 对 git 写回包不保证触发需要的行为（成功路径的 refreshGitDiff 在 cwd 未变时不发请求），
// 以 120ms 轮询比对 gitWrite 引用变化闭环——本地 git 操作毫秒级、push 秒级，轮询生命周期极短。
// busy 是模块级单例而非 store 字段：置位/清空换引用并通知轻量订阅（useGitBusy）——
// 订 store selector 的组件不感知模块变量，原全局重渲染驱动（旧 notify bump）由此替代
let gitBusy: { op: GitWriteOp; prev: unknown } | null = null;
const gitBusySubs = new Set<() => void>();
/** 读 gitBusy 并订阅其变化（置位/清空换引用即重渲染；getSnapshot 返回模块变量，引用稳定） */
function useGitBusy() {
  return useSyncExternalStore(
    (fn) => {
      gitBusySubs.add(fn);
      return () => gitBusySubs.delete(fn);
    },
    () => gitBusy,
  );
}
let gitBusyTimer: TimerHandle | undefined; // setInterval 句柄(复用 store TimerHandle;undefined 语义同原版 null)
const GIT_WRITE_REPLY: Record<GitWriteOp, string> = { stage: "git_staged", unstage: "git_unstaged", discard: "git_discarded", commit: "git_committed", push: "git_pushed" };
function startGitBusy(op: GitWriteOp) {
  gitBusy = { op, prev: useAppStore.getState().rightState.gitWrite };
  for (const fn of gitBusySubs) fn();
  clearInterval(gitBusyTimer);
  gitBusyTimer = setInterval(() => {
    const w = useAppStore.getState().rightState.gitWrite;
    if (!gitBusy || !w || w === gitBusy.prev || w.type !== GIT_WRITE_REPLY[gitBusy.op]) return;
    if (w.ok && gitBusy.op === "commit") {
      // 提交成功清空输入框（换新 rightState 引用，原 mutate + 末尾 notify）
      useAppStore.setState((st) => ({ rightState: { ...st.rightState, commitMsg: "" } }));
    }
    gitBusy = null;
    clearInterval(gitBusyTimer);
    refreshGitDiff(true); // 强制重拉（非 force 刷新在 cwd 未变时不发请求）
    for (const fn of gitBusySubs) fn();
  }, 120);
}

// 点击文件行进详情：请求单文件 diff
function requestFileDiff(s: { cwd: string }, filePath: string) {
  setBump({ selectedFile: filePath });
  useAppStore.setState((st) => ({ fileDiffCache: { ...st.fileDiffCache, loading: true, path: filePath } }));
  send({ type: "get_file_diff", cwd: s.cwd, path: filePath });
}

export default function GitDiffPage() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightState = useAppStore((st) => st.rightState);
  const gitDiffCache = useAppStore((st) => st.gitDiffCache);
  const gitViewMode = useAppStore((st) => st.gitViewMode);
  const selectedFile = useAppStore((st) => st.selectedFile);
  const gitBusy = useGitBusy();
  const [confirm, setConfirm] = useState<DiscardConfirm | null>(null);
  if (!s) {
    return <div className="placeholder">（无活跃会话）</div>;
  }
  if (!s.isGit) {
    return <div className="placeholder">（该 project 不是 git 仓库）</div>;
  }
  if (selectedFile) {
    return <GdFileDetail />;
  }

  const busy = !!gitBusy;
  const hasStaged = gitDiffCache.files.some((f) => f.staged);
  // 丢弃是破坏性操作，走二次确认（cwd 取发起时刻的 activeOpen，对齐原 gitCwd 语义）
  const onDiscard = (f: GitFileEntry) => {
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
            // 键入为静默写：换引用不 bump，不打扰旧 useStore 全局订阅（原局部 force 重渲染由此订阅替代）
            useAppStore.setState((st) => ({ rightState: { ...st.rightState, commitMsg: e.target.value } }));
          }}
        />
        <button
          className={"save-btn" + (gitBusy?.op === "commit" ? " busy" : "")}
          title="提交全部已暂存的改动"
          disabled={!rightState.commitMsg.trim() || !hasStaged || busy}
          onClick={() => {
            const message = rightState.commitMsg.trim();
            if (!message) return;
            send({ type: "git_commit", cwd: s.cwd, message }); // 不带 paths = 提交全部已暂存
            startGitBusy("commit");
          }}
        >
          {gitBusy?.op === "commit" ? <Icon name="refresh" size={13} /> : "提交"}
        </button>
        <button
          className={"save-btn" + (gitBusy?.op === "push" ? " busy" : "")}
          title="推送当前分支"
          disabled={busy}
          onClick={() => {
            send({ type: "git_push", cwd: s.cwd });
            startGitBusy("push");
          }}
        >
          {gitBusy?.op === "push" ? <Icon name="refresh" size={13} /> : "推送"}
        </button>
      </div>
      {gitDiffCache.cwd !== s.cwd || gitDiffCache.loading ? (
        <div className="placeholder">{gitDiffCache.loading ? "加载中…" : "点右上角 ⟳ 加载改动"}</div>
      ) : gitDiffCache.files.length === 0 ? (
        <div className="placeholder">（工作区干净）</div>
      ) : gitViewMode === "flat" ? (
        gitDiffCache.files.map((f) => <GitFileRow key={f.path} f={f} displayPath={f.path} depth={0} onDiscard={onDiscard} />)
      ) : (
        <TreeLevel node={buildTree(gitDiffCache.files)} prefix="" depth={0} onDiscard={onDiscard} />
      )}
      {confirm && <ConfirmDialog {...confirm} />}
    </>
  );
}

// 文件详情：返回 + 路径固定在顶，diff 区滚动（自研 LightweightDiff 组件渲染）
function GdFileDetail() {
  const selectedFile = useAppStore((st) => st.selectedFile); // 入口 if (selectedFile) 已守卫非空,与原版一致
  const fileDiffCache = useAppStore((st) => st.fileDiffCache);
  return (
    <>
      <div className="rb-head">
        <button
          className="sub-back"
          onClick={() => {
            setBump({ selectedFile: null });
          }}
        >
          ‹ 返回列表
        </button>
        <div className="sub-title">{selectedFile}</div>
      </div>
      <div className="rb-scroll">
        {fileDiffCache.loading && fileDiffCache.path === selectedFile ? (
          <div className="placeholder">加载中…</div>
        ) : fileDiffCache.path !== selectedFile || !fileDiffCache.diff ? (
          <div className="placeholder">（无差异内容）</div>
        ) : (
          <LightweightDiff diff={fileDiffCache.diff} lang={langOfPath(selectedFile)} className="fd-holder" />
        )}
      </div>
    </>
  );
}

// 文件行：状态徽标 + 文件名 + 行内写操作（hover 显示，树/平铺两视图共用）
function GitFileRow({ f, displayPath, depth, onDiscard }: { f: GitFileEntry; displayPath: string; depth: number; onDiscard: (f: GitFileEntry) => void }) {
  const gitBusy = useGitBusy();
  const busy = !!gitBusy;
  const cwd = () => activeOpen()?.cwd; // cwd 取法对齐 refreshGitDiff（activeOpen().cwd）
  // 脉冲标记渲染时读 getState（不订阅）：置位随 expandedDirs 写入驱动本次渲染，
  // 宏任务静默复位不触发订阅——kids-in 类保留至下次渲染，入场动画不被截断（原 notify 语义）
  const animateGdKids = useAppStore.getState().animateGdKids;
  return (
    <div
      className={"gd-row" + (animateGdKids ? " kids-in" : "")}
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
function TreeLevel({ node, prefix, depth, onDiscard }: { node: GitTreeNode; prefix: string; depth: number; onDiscard: (f: GitFileEntry) => void }) {
  const rightState = useAppStore((st) => st.rightState);
  // 脉冲标记渲染时读 getState（不订阅）：同 GitFileRow，复位静默不截断 kids-in 动画
  const animateGdKids = useAppStore.getState().animateGdKids;
  const rows: ReactNode[] = [];
  for (const [seg, dir] of node.dirs) {
    const dirPath = prefix ? prefix + "/" + seg : seg;
    const expanded = rightState.expandedDirs.has(dirPath);
    rows.push(
      <div
        key={"d:" + dirPath}
        className={"gd-row" + (animateGdKids ? " kids-in" : "")}
        style={{ paddingLeft: 4 + depth * 14 + "px", animationDelay: depth * 15 + "ms" }}
        onClick={() => {
          // 展开/收起换新 Set + 新 rightState 引用（订阅者按引用感知）；展开时置脉冲动画标记
          useAppStore.setState((st) => {
            const expandedDirs = new Set(st.rightState.expandedDirs);
            let animateGdKids = st.animateGdKids;
            if (expandedDirs.has(dirPath)) {
              expandedDirs.delete(dirPath);
            } else {
              expandedDirs.add(dirPath);
              animateGdKids = true; // 本次重渲染的子行播入场动画
            }
            return { rightState: { ...st.rightState, expandedDirs }, animateGdKids };
          });
          setTimeout(() => {
            useAppStore.setState({ animateGdKids: false }); // 静默复位：无订阅者不触发渲染，kids-in 类保留（动画播完），语义同原版
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

function badgeClass(code: string): string {
  if (code.includes("A") || code === "?") return "add";
  if (code.includes("D")) return "del";
  return "mod";
}

// 路径 → 目录树（目录有序 Map + 文件数组）
function buildTree(files: GitFileEntry[]): GitTreeNode {
  const root: GitTreeNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i])!; // 断言：上一行已保证存在（has/set 后立即 get）
    }
    node.files.push(f);
  }
  return root;
}

function countFiles(node: GitTreeNode): number {
  let n = node.files.length;
  for (const d of node.dirs.values()) n += countFiles(d);
  return n;
}
