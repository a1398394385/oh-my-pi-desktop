// 用户消息气泡：正文 + 排队/steer 待消费消息的左侧操作组 + 历史消息的分叉按钮。
// 迁移自 ui/chat.js 的 user 分支与 buildPendingActions/buildBranchBtn。
import { send, notify, activeOpen, sendNowQueueMsg, editQueueMsg, dropQueueMsg, requeueSteerMsg } from "../../store.js";
import Icon from "../../Icon.jsx";

// 待消费气泡的左侧操作组：排队态（立即发送/编辑/删除）｜steer 态（编辑/放回队列顶端）
function PendingActs({ item }) {
  const s = activeOpen();
  const mk = (title, ic, fn) => (
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

// 带 entryId 的历史用户消息 hover 出现的分叉按钮：从此条消息之前分叉出新会话。
// 分叉是文件级操作（几百 ms），点击后置 item.branching 防连点，session_branched 回包清除
function BranchBtn({ item }) {
  const s = activeOpen();
  return (
    <div className="qk-acts">
      <button
        className="q-btn"
        title="从此处分叉新分支"
        disabled={item.branching}
        onClick={(e) => {
          e.stopPropagation();
          if (item.branching || !s) return;
          item.branching = true; // 全量重绘后仍保持禁用（标记随 item 数据存活）
          send({ type: "branch_session", sessionId: s.sessionId, entryId: item.entryId });
          notify();
        }}
      >
        <Icon name="fork" size={13} />
      </button>
    </div>
  );
}

export default function UserMsg({ item, fk }) {
  // 排队/steer 待消费消息：hover 气泡左侧出操作按钮组（消费后 pending 清除即普通历史消息）
  const cls = item.pending ? "user-bubble pending" : item.entryId ? "user-bubble branchable" : "user-bubble";
  return (
    <div className="msg user" data-fk={fk || undefined}>
      <div className={cls}>
        {item.text}
        {item.pending ? <PendingActs item={item} /> : item.entryId ? <BranchBtn item={item} /> : null}
      </div>
    </div>
  );
}

