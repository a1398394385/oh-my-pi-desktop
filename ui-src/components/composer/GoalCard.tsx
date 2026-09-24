// goal 目标栏：输入框上方的最上层重叠栏（App 在 QueueCard 前渲染，随排队消息增多而上移）。
// 叠加几何复用 queue-card 配方（margin -28px 上拉 + padding-bottom 28px 保底 + 只圆上角，
// 被下一张卡压住下缘）；宽度比输入框左右各窄 10px、无圆角补充块。单行：目标截断 + 已运行时间/
// 已消耗成本/暂停继续/删除；点击栏向上展开完整目标（图标点击不触发展开）。
// 暂停/继续同位变换（对应 /goal pause、/goal resume），图标动作走 prompt 链路（命令被
// 本地消费，乐观气泡由 command_result 撤回）。
import { useState } from "react";
import type { MouseEvent } from "react";
import { useAppStore, send } from "../../store";
import Icon from "../../Icon";

export default function GoalCard() {
  const [expanded, setExpanded] = useState(false);
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const g = s?.goal;
  if (!s || !g) return null;
  const run = Math.round(g.timeUsedSeconds ?? 0);
  const runLabel =
    run >= 3600 ? `${Math.floor(run / 3600)}h${Math.floor((run % 3600) / 60)}m` : run >= 60 ? `${Math.floor(run / 60)}m${run % 60}s` : `${run}s`;
  const paused = !g.enabled;
  return (
    <div
      className={"goal-card" + (expanded ? " open" : "")}
      title={g.objective}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="gc-row">
        <span className="gc-obj">{g.objective}</span>
        <span className="gc-meta">
          <span className="gc-run">{runLabel}</span>
          <span className="gc-cost">${(g.costUsed ?? 0).toFixed(4)}</span>
          <button
            className="plus-btn"
            title={paused ? "继续目标 (/goal resume)" : "暂停目标 (/goal pause)"}
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              send({ type: "prompt", sessionId: s.sessionId, text: paused ? "/goal resume" : "/goal pause" });
            }}
          >
            <Icon name={paused ? "play" : "pause"} size={16} />
          </button>
          <button
            className="plus-btn"
            title="删除目标 (/goal drop)"
            onClick={(e: MouseEvent) => {
              e.stopPropagation();
              send({ type: "prompt", sessionId: s.sessionId, text: "/goal drop" });
            }}
          >
            <Icon name="trash" size={16} />
          </button>
        </span>
      </div>
    </div>
  );
}
