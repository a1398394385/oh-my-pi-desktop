// 设置页：浏览器控制（pg-browser）。纯静态占位页（set-note 照搬旧版 DOM）。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-browser">。
import { useStore } from "../../../store.js";

export default function BrowserPage() {
  useStore();
  return (
    <div className="set-page" id="pg-browser">
      <div className="set-tt">浏览器控制</div>
      <div className="set-note">
        <b>当前版本无法实现</b>
        <span>ZCode 的内置浏览器壳（导入数据、清缓存、忽略证书）需要嵌入式浏览器面板。本应用没有该面板；omp 的 browser.* 只给 Agent 工具用 Puppeteer/CDP，不能对应这页产品功能。</span>
      </div>
    </div>
  );
}
