// 分支树页：当前会话家族（get_session_tree 懒加载，切会话后旧数据视为过期）
// + 按 parentSession 组树渲染 + 点击分支行切换会话。
import { Fragment, useEffect } from "react";
import { useAppStore, setBump, send, activateSession, refreshGitDiff, hideWelcomeScreen, saveUnseen } from "../../store";
import type { DiskProject, SessionBranch } from "../../types/frames";
import { fmtAgo } from "./helpers";

// 家族分支条目:唯一来源 types/frames 的 SessionBranch(host get_session_tree 回包)
type BranchEntry = SessionBranch;

// 分支行标题：title → 磁盘列表首消息截断 → 「未命名分支」（分支刚建未入 list_sessions 时无首消息）
function branchLabel(b: BranchEntry, diskProjects: DiskProject[]): string {
  if (b.title && b.title.trim()) return b.title;
  const fm = diskProjects.flatMap((p) => p.sessions).find((x) => x.path === b.path)?.firstMessage;
  if (fm && fm.trim()) return fm.length > 40 ? fm.slice(0, 40) + "…" : fm;
  return "未命名分支";
}

// 点击分支行切换会话：与侧栏列表点击同一套动作（已打开直接激活，否则走宿主 load_session）
function loadBranchSession(path: string) {
  useAppStore.setState({ isCreatingNew: false });
  hideWelcomeScreen();
  // 未读标记摘除换新 Set（原 mutate + 末尾 notify；订阅 unseenFinished 的侧栏按引用感知）
  useAppStore.setState((st) => ({ unseenFinished: new Set([...st.unseenFinished].filter((p) => p !== path)) }));
  saveUnseen();
  if (useAppStore.getState().openSessions.has(path)) {
    activateSession(path);
    refreshGitDiff();
  } else {
    send({ type: "reload_settings" }); // 本地 config 可能已改，拉取最新模型设置
    send({ type: "load_session", path });
  }
  setBump({ selectedSubagent: null, selectedFile: null });
}

export default function BranchTreePage() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const rightState = useAppStore((st) => st.rightState);
  // 过期数据重拉（原渲染体内联请求移此；pending 防重读 getState，回包由 store 落缓存）。
  // 无依赖数组 = 每次渲染后检查，对齐原「渲染体每次重绘检查」语义（请求失败解除 pending 后下次渲染重拉）
  useEffect(() => {
    const st = useAppStore.getState();
    const session = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    if (!session) return;
    const tree = st.rightState.sessionTree;
    if (tree && tree.sessionId === session.sessionId) return; // 未过期
    if (st.rightState.sessionTreePending) return; // 防重
    useAppStore.setState((st2) => ({
      rightState: { ...st2.rightState, sessionTreePending: true, treeFor: session.sessionId }, // 回包未带 sessionId 时归属用
    }));
    send({ type: "get_session_tree", sessionId: session.sessionId });
  });
  if (!s) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">（无活跃会话）</div>;
  }
  const tree = rightState.sessionTree;
  const stale = !tree || tree.sessionId !== s.sessionId; // 切换会话后旧数据视为过期
  if (stale) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">加载中…</div>;
  }
  const branches = tree.branches ?? [];
  if (branches.length <= 1) {
    return <div className="py-[18px] px-3.5 text-faint text-ui-base leading-[1.6]">暂无其他分支。把鼠标移到某轮回复的末尾，点分叉按钮可从该处创建新分支。</div>;
  }
  // 按 parentSession 组树：根支（无父或父不在家族列表）在顶层，子支随父缩进（深度不限，样式统一）
  const byId = new Map(branches.map((b: BranchEntry) => [b.sessionId, b] as const));
  const kidsOf = new Map<string, BranchEntry[]>();
  const roots: BranchEntry[] = [];
  for (const b of branches) {
    if (b.parentSession && byId.has(b.parentSession)) {
      const list = kidsOf.get(b.parentSession) ?? [];
      list.push(b);
      kidsOf.set(b.parentSession, list);
    } else roots.push(b);
  }
  // 断言：缺失 modified 时回退值 0 经 Date.parse  coercion 与原版一致（NaN）
  const byTime = (x: BranchEntry, y: BranchEntry): number =>
    Date.parse((y.modified || 0) as string) - Date.parse((x.modified || 0) as string); // 同级新的在前
  roots.sort(byTime);
  for (const l of kidsOf.values()) l.sort(byTime);
  return (
    <div className="py-1.5 px-2">
      <BranchLevel items={roots} kidsOf={kidsOf} depth={0} />
    </div>
  );
}

// 单层分支行（当前分支 cur 高亮不可点）+ 嵌套子支容器（自带竖线引导线，逐级缩进）
function BranchLevel({ items, kidsOf, depth }: { items: BranchEntry[]; kidsOf: Map<string, BranchEntry[]>; depth: number }) {
  const diskProjects = useAppStore((st) => st.diskProjects); // 标题首消息兜底数据（磁盘会话列表）变化时重渲染
  return (
    <div className={depth > 0 ? "ml-2.5 pl-2.5 border-l border-line-soft" : undefined}>
      {items.map((b) => {
        const kids = kidsOf.get(b.sessionId);
        return (
          <Fragment key={b.sessionId}>
            <button className={"bt-row" + (b.isCurrent ? " cur" : "")} title={b.path} onClick={b.isCurrent ? undefined : () => loadBranchSession(b.path)}>
              <span className="flex-1 min-w-0 text-ui-base overflow-hidden text-ellipsis whitespace-nowrap">{branchLabel(b, diskProjects)}</span>
              <span className="flex-none text-ui-xs text-faint">
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
