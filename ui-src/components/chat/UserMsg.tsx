import { useState } from "react";
import type { OpenSession } from "../../store";
import type { UserItem } from "../../types/session";
import { activeOpen, sendNowQueueMsg, editQueueMsg, dropQueueMsg, requeueSteerMsg } from "../../store";
import Icon from "../../Icon";
import ImageLightbox from "./ImageLightbox";

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
      <Icon name={ic} size={15} />
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
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const images = item.images ?? [];
  const lightboxList = images.map((img, i) => ({
    src: img.data.startsWith("data:") ? img.data : `data:${img.mimeType || "image/png"};base64,${img.data}`,
    name: `图片 ${i + 1}`,
  }));

  // 排队/steer 待消费消息：hover 气泡左侧出操作组（消费后 pending 清除即普通历史消息）
  const cls = item.pending ? "user-bubble pending" : "user-bubble";
  return (
    <div className="msg user" data-fk={fk || undefined}>
      <div className={cls}>
        {images.length > 0 && (
          <div className="user-msg-images mb-2 flex flex-wrap gap-2">
            {images.map((img, idx) => {
              const src = img.data.startsWith("data:") ? img.data : `data:${img.mimeType || "image/png"};base64,${img.data}`;
              return (
                <div
                  key={idx}
                  className="group relative cursor-pointer overflow-hidden rounded-md border border-line bg-card hover:opacity-90 transition-opacity"
                  onClick={() => setLightboxIndex(idx)}
                  title="点击查看大图"
                >
                  <img
                    src={src}
                    alt={`attachment-${idx}`}
                    className={
                      images.length === 1
                        ? "max-w-[320px] max-h-[240px] w-auto h-auto object-contain rounded-md block"
                        : "w-24 h-24 object-cover rounded-md block"
                    }
                  />
                  <div className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white text-xs">
                    <Icon name="search" size={14} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {item.text ? <div className="user-msg-text whitespace-pre-wrap">{item.text}</div> : null}
        {item.pending ? <PendingActs item={item} /> : null}
      </div>
      {lightboxIndex !== null && (
        <ImageLightbox
          images={lightboxList}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
