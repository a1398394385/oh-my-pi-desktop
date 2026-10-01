// 流式加载转圈 + 动态状态文字（原 ChatLoading 转圈 + WorkLine 文字合并）：
// 挂在消息流末尾、输入框正上方靠左（流与输入框同宽，图标即输入框左上角位置），
// s.streaming 为真时渲染，轮结束随状态消失。lucide loader 图标 + CSS spin，颜色用 --dim。
// 文字取 workingText（intent/思考），无值兜底「正在处理…」；结构稳定，文字变化只更新文本节点。
import { useAppStore } from "../../store/index";
import Icon from "../../Icon";
import { t } from "../../i18n";

export default function ChatLoading() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const text = s?.streaming ? s.workingText || t("chat.processing") : "";
  return (
    <div className="flex items-center min-h-[20px] py-[2px]" role="status" aria-label={text || t("chat.loadingAria")}>
      <Icon name="loader" size={16} className="chat-loading-icon" />
      {text && <span className="ml-[7px] text-ui-sm text-dim truncate" title={text}>{text}</span>}
    </div>
  );
}
