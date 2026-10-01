// 排队消息卡（原 composer.js renderQueueLine 平移）：输入框上方的二级重叠卡。
// 布局复刻 ZCode ConversationQueuePanel：relative z-0 + 负 margin-bottom 上拉 + padding-bottom
// 保底内容可见 + 只圆上角；下方 .dock 以 z-100 压住其下缘 28px（见 ui/style.css 文件头「全站层级刻度」）。
// 由 App 在 .dock 前作相邻兄弟渲染（ZCode bottom dock 顺序 queue → composer）。
// 流式中发送的消息在此排队，当前 loop 完全处理后自动消费第 1 条；
// 每条可立即发送（转 steer）/编辑（回输入框）/删除。steer 态气泡动作组（requeueSteerMsg）
// 在气泡侧，归 chat-wave，此处只渲染 followUp 队列。
import { useTranslation } from "react-i18next";
import { useAppStore, sendNowQueueMsg, editQueueMsg, dropQueueMsg } from "../../store";
import type { UserItem } from "../../types/session";
import Icon from "../../Icon";

export default function QueueCard() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const items = s?.queued ?? [];
  if (!s || items.length === 0) return null; // 无会话时 items 必为空,合并早退等价原逻辑
  return (
    <div className="queue-card" id="queueCard">
      {items.map((m: { text?: string }, i: number) => {
        const item: UserItem = { role: "user", text: m.text || "", pending: "queued" }; // 与气泡动作共用的伪 item
        return (
          <div className="qc-row" key={i} title={t("composer.queuedHint")}>
            <span className="qc-dots"><Icon name="dots" size={15} /></span>
            <span className="qc-tx">{m.text || t("composer.noText")}</span>
            <button
              className="q-btn"
              title={t("composer.sendNow")}
              onClick={(e) => { e.stopPropagation(); sendNowQueueMsg(s, item); }}
            ><Icon name="upload" size={15} /></button>
            <button
              className="q-btn"
              title={t("composer.editQueued")}
              onClick={(e) => { e.stopPropagation(); editQueueMsg(s, item); }}
            ><Icon name="pencil" size={15} /></button>
            <button
              className="q-btn"
              title={t("common.delete")}
              onClick={(e) => { e.stopPropagation(); dropQueueMsg(s, item); }}
            ><Icon name="trash" size={15} /></button>
          </div>
        );
      })}
    </div>
  );
}
