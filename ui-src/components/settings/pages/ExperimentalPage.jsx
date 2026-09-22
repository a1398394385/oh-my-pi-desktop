// 设置页：实验性功能（pg-experimental）。当前仅一项——ACP 上下文压缩总开关
// （host 侧：acp-state.ts 状态 + acp-tools.ts 工具面 + acp-context.ts 视图改写，
// 三者在 createSessionCore 里随 omp-desktop.json 的 acp.enabled 一起注入新会话）。
// 样式语言与外观页一致：set-page / set-tt / set-group-tt / set-group-desc / set-card / .srow / .tg。
import { S, useStore, send } from "../../../store.js";

export default function ExperimentalPage() {
  useStore(); // 订阅 S：set_acp_enabled 回包的 settings 帧更新 hostSettings → 开关重绘

  // hostSettings 未落地（设置页刚打开、帧在途）时不猜状态：灰态呈现，不可点
  const known = typeof S.hostSettings?.acpEnabled === "boolean";
  const enabled = known ? !!S.hostSettings.acpEnabled : false;

  return (
    <div className="set-page" id="pg-experimental">
      <div className="set-tt">实验性功能</div>
      <div className="set-group-tt">上下文</div>
      <div className="set-group-desc">实验特性，行为可能随版本调整。</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b>ACP 上下文压缩</b>
            <span>为新建会话注册 compress / decompress / search_context 等上下文管理工具，模型可把长对话区间折叠成可随时还原的摘要块。开关只影响此后打开的会话。</span>
          </div>
          <div className={"tg" + (enabled ? " on" : "") + (known ? "" : " disabled")} id="tgAcp" onClick={() => send({ type: "set_acp_enabled", enabled: !enabled })}>
            <i></i>
          </div>
        </div>
      </div>
    </div>
  );
}