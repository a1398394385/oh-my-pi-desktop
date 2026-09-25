// 一轮 output 结尾左下角的操作组：复制该条回复 + 从此处分叉 + 本轮结束时刻。
// 分叉走 branch_session（截取从根到该 assistant 节点的历史条目，复制为全新会话文件）。
// 锚点 entryId 由 host 落盘后回填（translate.ts）。
import type { AssistantItem } from "../../types/session";
import { useAppStore } from "../../store/index";
import { patchActiveItem } from "./parts";
import { copyText } from "../sidebar/util";
import Icon from "../../Icon";

// 结束时刻：当天只给 HH:MM（与 CtxCard/ModelPage 的限额重置时间同款格式），跨天补月日
function fmtClock(ms: number) {
  const t = new Date(ms);
  const now = new Date();
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  return sameDay ? hm : `${t.getMonth() + 1}月${t.getDate()}日 ${hm}`;
}

export default function TurnActs({ item }: { item: AssistantItem }) {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
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
            () => useAppStore.getState().toast("已复制回复"),
            () => useAppStore.getState().toast("复制失败"),
          );
        }}
      >
        <Icon name="copy" />
      </button>
      <button
        className="q-btn"
        title={item.entryId ? "从此处分叉出新会话" : "回复落盘后可分叉"}
        disabled={!canFork}
        onClick={(e) => {
          e.stopPropagation();
          if (!canFork || !s) return;
          patchActiveItem(item, (it) => { it.branching = true; }); // 全量重绘后仍保持禁用（标记随 item 数据存活）
          useAppStore.getState().send({ type: "branch_session", sessionId: s.sessionId, entryId: item.entryId });
        }}
      >
        <Icon name="fork" />
      </button>
      {item.endMs ? <span className="turn-acts-time">{fmtClock(item.endMs)}</span> : null}
    </div>
  );
}
