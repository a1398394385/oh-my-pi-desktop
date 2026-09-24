// 用户消息气泡：正文 + 排队/steer 待消费消息的左侧操作组。
// 迁移自 ui/chat.js 的 user 分支与 buildPendingActions（分叉按钮已移到一轮 output 结尾，见 TurnActs.jsx）。
import type { OpenSession } from "../../store";
import type { UserItem } from "../../types/session";
import { activeOpen, sendNowQueueMsg, editQueueMsg, dropQueueMsg, requeueSteerMsg } from "../../store";
import Icon from "../../Icon";

// 待消费气泡的左侧操作组：排队态（立即发送/编辑/删除）｜steer 态（编辑/放回队列顶端）
function PendingActs({ item }: { item: UserItem }) {
  const s = activeOpen();
  const mk = (title: string, ic: string, fn: (sess: OpenSession, item: UserItem) => void) => (
    <button
      className="q-btn"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (s) fn(s, item);
      }}
    >
      <Icon name={ic} size={13} />
    </button>
  );
  return (
    <div className="qk-acts">
      {item.pending === "steer" ? (
        <>
          {mk("编辑（放回输入框）", "pencil", editQueueMsg)}
          {mk("放回队列顶端", "down", requeueSteerMsg)}
        </>
      ) : (
        <>
          {mk("立即发送（当前步骤后注入）", "upload", sendNowQueueMsg)}
          {mk("编辑（放回输入框）", "pencil", editQueueMsg)}
          {mk("删除", "trash", dropQueueMsg)}
        </>
      )}
    </div>
  );
}

// 带 entryId 的历史用户消息 hover 出现的分叉按钮已移除：分叉改挂在一轮 output 结尾
//（见 TurnActs.jsx），气泡旁只保留排队/steer 操作组。
export default function UserMsg({ item, fk }: { item: UserItem; fk?: string }) {
  // 排队/steer 待消费消息：hover 气泡左侧出操作组（消费后 pending 清除即普通历史消息）
  const cls = item.pending ? "user-bubble pending" : "user-bubble";
  return (
    <div className="msg user" data-fk={fk || undefined}>
      <div className={cls}>
        {item.text}
        {item.pending ? <PendingActs item={item} /> : null}
      </div>
    </div>
  );
}
