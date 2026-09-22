// 设置页：插件（pg-plugins）。纯静态占位页（set-note 照搬旧版 DOM）。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-plugins">。
// 注：旧版该页无列表容器；宿主 disableExtensionDiscovery: true，插件不加载。
import { useStore } from "../../../store.js";
import SchemaRows from "../SchemaRows.jsx";
import { PAGE_PLACEMENT } from "../placement.js";

export default function PluginsPage() {
  useStore();
  return (
    <div className="set-page" id="pg-plugins">
      <div className="set-tt">插件</div>
      <div className="set-note">
        <b>当前版本无法启用</b>
        <span>宿主创建会话时设置了 <code>disableExtensionDiscovery: true</code>，插件不会加载。打开此开关属于架构变更，本页只作占位。</span>
      </div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-plugins"]} />
    </div>
  );
}
