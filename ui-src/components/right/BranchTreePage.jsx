// 分支树页：当前会话家族（get_session_tree 懒加载，切会话后旧数据视为过期）
// + 按 parentSession 组树渲染 + 点击分支行切换会话。
import { Fragment } from "react";
import {
  S,
  useStore,
  notify,
  send,
  activeOpen,
  diskProjects,
  openSessions,
  unseenFinished,
  saveUnseen,
  refreshGitDiff,
  hideWelcomeScreen,
  rightState,
} from "../../store.js";
import { fmtAgo } from "./helpers.js";

// 分支行标题：title → 磁盘列表首消息截断 → 「未命名分支」（分支刚建未入 list_sessions 时无首消息）
function branchLabel(b) {
  if (b.title && b.title.trim()) return b.title;
  const fm = diskProjects.flatMap((p) => p.sessions).find((x) => x.path === b.path)?.firstMessage;
  if (fm && fm.trim()) return fm.length > 40 ? fm.slice(0, 40) + "…" : fm;
  return "未命名分支";
}

// 点击分支行切换会话：与侧栏列表点击同一套动作（已打开直接激活，否则走宿主 load_session）
function loadBranchSession(path) {
  S.isCreatingNew = false;
  hideWelcomeScreen();
  unseenFinished.delete(path);
  saveUnseen();
  if (openSessions.has(path)) {
    S.activePath = path;
    refreshGitDiff();
  } else {
    send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置
    send({ type: "load_session", path });
  }
  S.selectedSubagent = null;
  S.selectedFile = null;
  notify();
}

export default function BranchTreePage() {
  useStore();
  const s = activeOpen();
  if (!s) {
    return <div className="placeholder">（无活跃会话）</div>;
  }
  const tree = rightState.sessionTree;
  const stale = !tree || tree.sessionId !== s.sessionId; // 切换会话后旧数据视为过期
  if (stale && !rightState.sessionTreePending) {
    rightState.sessionTreePending = true;
    rightState.treeFor = s.sessionId; // 回包未带 sessionId 时归属用
    send({ type: "get_session_tree", sessionId: s.sessionId });
  }
  if (stale) {
    return <div className="placeholder">加载中…</div>;
  }
  const branches = tree.branches ?? [];
  if (branches.length <= 1) {
    return <div className="bt-empty">暂无其他分支。把鼠标移到历史消息上，点分叉按钮可从该消息处创建新分支。</div>;
  }
  // 按 parentSession 组树：根支（无父或父不在家族列表）在顶层，子支随父缩进（深度不限，样式统一）
  const byId = new Map(branches.map((b) => [b.sessionId, b]));
  const kidsOf = new Map();
  const roots = [];
  for (const b of branches) {
    if (b.parentSession && byId.has(b.parentSession)) {
      if (!kidsOf.has(b.parentSession)) kidsOf.set(b.parentSession, []);
      kidsOf.get(b.parentSession).push(b);
    } else roots.push(b);
  }
  const byTime = (x, y) => Date.parse(y.modified || 0) - Date.parse(x.modified || 0); // 同级新的在前
  roots.sort(byTime);
  for (const l of kidsOf.values()) l.sort(byTime);
  return (
    <div className="bt-list">
      <BranchLevel items={roots} kidsOf={kidsOf} depth={0} />
    </div>
  );
}

// 单层分支行（当前分支 cur 高亮不可点）+ 嵌套子支容器（自带竖线引导线，逐级缩进）
function BranchLevel({ items, kidsOf, depth }) {
  return (
    <div className={depth > 0 ? "bt-kids" : undefined}>
      {items.map((b) => {
        const kids = kidsOf.get(b.sessionId);
        return (
          <Fragment key={b.sessionId}>
            <button className={"bt-row" + (b.isCurrent ? " cur" : "")} title={b.path} onClick={b.isCurrent ? undefined : () => loadBranchSession(b.path)}>
              <span className="bt-name">{branchLabel(b)}</span>
              <span className="bt-meta">
                {[b.messageCount != null ? `${b.messageCount} 条` : null, b.modified ? fmtAgo(b.modified) : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
            {kids?.length ? <BranchLevel items={kids} kidsOf={kidsOf} depth={depth + 1} /> : null}
          </Fragment>
        );
      })}
    </div>
  );
}
