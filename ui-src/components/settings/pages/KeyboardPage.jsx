// 设置页：键盘快捷键（pg-keyboard）。纯静态页，快捷键清单照搬旧版 DOM。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-keyboard">。
import { useStore } from "../../../store.js";

export default function KeyboardPage() {
  useStore();
  // 快捷键行为由全局 keydown 绑定（App 层）负责，本页仅展示
  const keys = (arr) => (
    <div className="sc-keys">{arr.map((k, i) => <span className="sc-key" key={i}>{k}</span>)}</div>
  );
  return (
    <div className="set-page" id="pg-keyboard">
      <div className="set-tt">键盘快捷键</div>
      <div className="set-group-tt">通用</div>
      <div className="set-group-desc">全局快捷键，在任何界面都可以使用。</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>新建任务</b></div>
          {keys(["⌘", "N"])}
        </div>
        <div className="srow">
          <div className="srow-tx"><b>切换左侧边栏</b></div>
          {keys(["⌘", "B"])}
        </div>
        <div className="srow">
          <div className="srow-tx"><b>打开 / 关闭设置</b></div>
          {keys(["⌘", ","])}
        </div>
        <div className="srow">
          <div className="srow-tx"><b>关闭设置</b></div>
          {keys(["Esc"])}
        </div>
      </div>
      <div className="set-group-tt">输入框</div>
      <div className="set-group-desc">会话输入框内的按键行为。</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>发送消息</b></div>
          {keys(["↵"])}
        </div>
        <div className="srow">
          <div className="srow-tx"><b>换行</b></div>
          {keys(["⇧", "↵"])}
        </div>
      </div>
      <div className="set-group-tt">界面缩放</div>
      <div className="set-group-desc">调整整个界面的显示比例。</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>放大</b></div>
          {keys(["⌘", "+"])}
        </div>
        <div className="srow">
          <div className="srow-tx"><b>缩小</b></div>
          {keys(["⌘", "−"])}
        </div>
        <div className="srow">
          <div className="srow-tx"><b>重置缩放</b></div>
          {keys(["⌘", "0"])}
        </div>
      </div>
    </div>
  );
}
