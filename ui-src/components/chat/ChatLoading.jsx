// 流式加载转圈（复刻 ZCode ai-elements/chat-loading.tsx）：挂在消息流末尾、紧贴输入框上方，
// s.streaming 为真时渲染，轮结束随状态消失。lucide loader 图标 + CSS spin，颜色用 --dim（对应 ZCode foreground-subtle）。
import Icon from "../../Icon.jsx";

export default function ChatLoading() {
  return (
    <div className="chat-loading" role="status" aria-label="加载中">
      <Icon name="loader" size={16} className="chat-loading-icon" />
    </div>
  );
}
