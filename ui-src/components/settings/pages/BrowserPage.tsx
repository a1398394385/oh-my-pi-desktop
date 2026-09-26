// 设置页：浏览器控制（pg-browser）。纯静态占位页（set-note 照搬旧版 DOM）。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-browser">。
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";

export default function BrowserPage() {
  return (
    <div className="set-page" id="pg-browser">
      <div className="set-tt">浏览器控制</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-browser"]} />
    </div>
  );
}
