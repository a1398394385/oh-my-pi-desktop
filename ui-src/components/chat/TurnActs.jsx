// 一轮 output 结尾左下角的操作组：复制该条回复 + 从此处分叉 + 本轮结束时刻。
// 分叉走 navigate_tree（同文件内把 leaf 移到该 assistant，被放弃路径留成兄弟分支）——
// 底座 AgentSession.branch() 只接受 user 条目（agent-session.ts:9864 校验 role），
// assistant 锚点只能走 navigateTree；锚点 entryId 由 host 落盘后回填（translate.ts）。
import { send, notify, activeOpen, toast, rightState } from "../../store.js";
import { copyText } from "../sidebar/util.js";
import Icon from "../../Icon.jsx";

// 结束时刻：当天只给 HH:MM（与 CtxCard/ModelPage 的限额重置时间同款格式），跨天补月日
function fmtClock(ms) {
  const t = new Date(ms);
  const now = new Date();
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  return sameDay ? hm : `${t.getMonth() + 1}月${t.getDate()}日 ${hm}`;
}

export default function TurnActs({ item }) {
  const s = activeOpen();
  // entryId 未回填（实时流式中尚未落盘）时分叉不可用：置灰而非隐藏，避免布局跳动
  const canFork = !!item.entryId && !item.branching;
  return (
    <div className="turn-acts">
      <button
        className="q-btn"
        title="复制这条回复"
        onClick={(e) => {
          e.stopPropagation();
          copyText(item.text || "").then(
            () => toast("已复制回复"),
            () => toast("复制失败"),
          );
        }}
      >
        <Icon name="copy" size={13} />
      </button>
      <button
        className="q-btn"
        title={item.entryId ? "从此处分叉新分支" : "回复落盘后可分叉"}
        disabled={!canFork}
        onClick={(e) => {
          e.stopPropagation();
          if (!canFork || !s) return;
          item.branching = true; // 全量重绘后仍保持禁用（标记随 item 数据存活）
          rightState.navFrom = "fork"; // 回执按来源选文案（与树页跳转共用 navigate_tree）
          send({ type: "navigate_tree", sessionId: s.sessionId, entryId: item.entryId, summarize: false });
          notify();
        }}
      >
        <Icon name="fork" size={13} />
      </button>
      {item.endMs ? <span className="turn-acts-time">{fmtClock(item.endMs)}</span> : null}
    </div>
  );
}
