// 权限模式菜单（原 index.html #modeMenu 静态三行 + composer.js 点击绑定平移）：
// omp 三值 always-ask | write | yolo。选中走宿主下发（有会话带 sessionId），
// 本地乐观更新 S.approvalMode（原 setApprovalModeUi），宿主 approval_mode 帧再确认。
import { useLayoutEffect, useRef } from "react";
import { S, send, notify, activeOpen } from "../../store.js";
import Icon from "../../Icon.jsx";
import { placeComposerMenu } from "./place.js";

// 模式元信息（原 composer.js MODE_META 平移；按钮态也复用）
export const MODE_META = {
  "always-ask": { label: "手动批准", icon: "permAsk", yolo: false },
  write: { label: "默认", icon: "permDefault", yolo: false },
  yolo: { label: "全自动", icon: "shieldWarn", yolo: true },
};

const ROWS = [
  { mode: "always-ask", desc: "执行需要授权的操作前先询问" },
  { mode: "write", desc: "常规操作自动执行，关键决定会询问" },
  { mode: "yolo", desc: "所有操作无需确认直接执行" },
];

export default function ModeMenu({ btnRef, composerRef, onClose }) {
  const menuRef = useRef(null);
  const s = activeOpen();
  const planOn = !!s?.planMode;
  // 挂载即定位（原 openComposerMenu：打开时定位一次）
  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, []);

  const pickMode = (mode) => {
    if (s) send({ type: "set_approval_mode", sessionId: s.sessionId, mode });
    else send({ type: "set_approval_mode", mode });
    S.approvalMode = mode;
    notify();
    onClose();
  };

  // 计划模式：仅在有会话时可切（模式状态挂在会话上）；置位由宿主 plan_mode 帧确认
  const togglePlan = () => {
    if (!s) return;
    send({ type: "set_plan_mode", sessionId: s.sessionId, enabled: !planOn });
    onClose();
  };

  return (
    <div className="menu mode open" id="modeMenu" ref={menuRef}>
      <div className={"mi big" + (s ? "" : " off")} id="planModeRow" onClick={togglePlan} title={s ? "先只读规划，批准计划后再执行" : "需要先新建或打开一个会话"}>
        <span className="mi-ic"><Icon name="plan" /></span>
        <span className="mi-tx">
          <span className="mi-tt">计划模式</span>
          <span className="mi-desc">先只读调研并产出计划，批准后才动手改代码</span>
        </span>
        <span className="ck">{planOn ? "✓" : ""}</span>
      </div>
      <div className="mode-sep"></div>
      {ROWS.map(({ mode, desc }) => {
        const meta = MODE_META[mode];
        return (
          <div className="mi big" data-mode={mode} key={mode} onClick={() => pickMode(mode)}>
            <span className="mi-ic"><Icon name={meta.icon} /></span>
            <span className="mi-tx"><span className="mi-tt">{meta.label}</span><span className="mi-desc">{desc}</span></span>
            <span className="ck">{S.approvalMode === mode ? "✓" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}
