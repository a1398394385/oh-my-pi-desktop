// 设置页：钩子（pg-hooks）。set-note 照搬 + hooksList 列表容器（读 agentAssets.hooks）。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-hooks">，
// 列表渲染参照 ui/settings/index.js renderAssetPages 的 fillAssetList("hooksList", ...)。
import { useAppStore } from "../../../store";

// 数据契约：agentAssets.hooks 元素形状（WS 下发；phase 可能缺失）
interface HookAsset {
  name: string;
  phase?: string;
  path: string;
}

// 空态行（旧版 emptyRow 的 JSX 等价物）
function emptyRow(text: string) {
  return (
    <div className="srow">
      <div className="srow-tx"><span>{text}</span></div>
    </div>
  );
}

export default function HooksPage() {
  // 数据契约：agentAssets.hooks: [{ name: string, phase?: string, path: string }]
  const assets = useAppStore((s) => s.agentAssets) as { hooks?: HookAsset[] } | undefined;
  const hooks = assets?.hooks;
  return (
    <div className="set-page" id="pg-hooks">
      <div className="set-tt">钩子</div>
      <div className="set-note">
        <b>当前版本无法启用</b>
        <span>钩子经 extension runner 加载，被 <code>disableExtensionDiscovery</code> 挡住。</span>
      </div>
      <div className="set-card" id="hooksList">
        {!assets
          ? emptyRow("加载中…")
          : !hooks || !hooks.length
            ? emptyRow("暂无")
            : hooks.map((h) => (
                <div className="srow" key={h.path || h.name}>
                  <div className="srow-tx">
                    <b>{h.name}</b>
                    <span>{(h.phase || "") + " · " + h.path}</span>
                  </div>
                </div>
              ))}
      </div>
    </div>
  );
}
