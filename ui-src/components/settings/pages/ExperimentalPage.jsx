// 设置页：实验性功能（pg-experimental）。两项开关，均只影响此后新建/打开的会话
// （工具面在 createSessionCore 里随 omp-desktop.json 的开关注入，无法热插拔到已打开的会话）：
// - acp.enabled            → acp-state.ts 状态 + acp-tools.ts 工具面 + acp-context.ts 视图改写
// - sessionContext.enabled → session-context.ts 的 read_session_context（历史会话检索）
// 样式语言与外观页一致：set-page / set-tt / set-group-tt / set-group-desc / set-card / .srow / .tg。
import { S, useStore, send } from "../../../store.js";

export default function ExperimentalPage() {
  useStore(); // 订阅 S：开关回包的 settings 帧更新 hostSettings → 开关重绘

  // hostSettings 未落地（设置页刚打开、帧在途）时不猜状态：灰态呈现，不可点
  const known = typeof S.hostSettings?.acpEnabled === "boolean";
  const enabled = known ? !!S.hostSettings.acpEnabled : false;
  const ctxKnown = typeof S.hostSettings?.sessionContextEnabled === "boolean";
  const ctxEnabled = ctxKnown ? !!S.hostSettings.sessionContextEnabled : false;

  return (
    <div className="set-page" id="pg-experimental">
      <div className="set-tt">实验性功能</div>
      <div className="set-group-tt">上下文</div>
      <div className="set-group-desc">实验特性，行为可能随版本调整。</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">
              ACP 上下文压缩
              <span className="srow-wn-inline">!!! 重启应用生效，开关此功能会破坏历史会话的工具列表结构，导致大模型缓存失效</span>
            </b>
            <span>为新建会话注册 compress / decompress / search_context 等上下文管理工具，模型可把长对话区间折叠成可随时还原的摘要块。开关只影响此后打开的会话。</span>
          </div>
          <div className={"tg" + (enabled ? " on" : "") + (known ? "" : " disabled")} id="tgAcp" onClick={() => send({ type: "set_acp_enabled", enabled: !enabled })}>
            <i></i>
          </div>
        </div>
        <div className="srow">
          <div className="srow-tx">
            <b className="srow-hd">
              历史会话检索
              <span className="srow-wn-inline">!!! 重启应用生效，开关此功能会破坏历史会话的工具列表结构，导致大模型缓存失效</span>
            </b>
            <span>为新建会话注册 read_session_context 工具，模型可按字面关键词检索本机已落盘的 Pi 会话历史，并展开命中处的原始对话。开关只影响此后打开的会话。</span>
          </div>
          <div className={"tg" + (ctxEnabled ? " on" : "") + (ctxKnown ? "" : " disabled")} id="tgSessionContext" onClick={() => send({ type: "set_session_context_enabled", enabled: !ctxEnabled })}>
            <i></i>
          </div>
        </div>
      </div>
    </div>
  );
}