// 设置页：命令（pg-commands）。commandsList 列表容器（读 S.agentAssets.commands）。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-commands">，
// 列表渲染参照 ui/settings/index.js renderAssetPages 的 fillAssetList("commandsList", ...)。
import { S, useStore } from "../../../store.js";

// 空态行（旧版 emptyRow 的 JSX 等价物）
function emptyRow(text) {
  return (
    <div className="srow">
      <div className="srow-tx"><span>{text}</span></div>
    </div>
  );
}

export default function CommandsPage() {
  useStore();
  // 数据契约：S.agentAssets.commands: [{ name: string, path: string }]
  const assets = S.agentAssets;
  const commands = assets?.commands;
  return (
    <div className="set-page" id="pg-commands">
      <div className="set-tt">命令</div>
      <div className="set-card" id="commandsList">
        {!assets
          ? emptyRow("加载中…")
          : !commands || !commands.length
            ? emptyRow("暂无")
            : commands.map((c) => (
                <div className="srow" key={c.path || c.name}>
                  <div className="srow-tx">
                    <b>{"/" + c.name}</b>
                    <span>{c.path}</span>
                  </div>
                </div>
              ))}
      </div>
    </div>
  );
}
