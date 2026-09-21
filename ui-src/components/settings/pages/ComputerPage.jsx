// 设置页：电脑控制（pg-computer）。tgComputer 开关：写宿主机 computer.enabled。
// 旧版参照：git show 464131d:ui/index.html 的 <div class="set-page" id="pg-computer">，
// 绑定参照 ui/settings/index.js initSettings 的 wireToggle("tgComputer")。
import { useEffect, useState } from "react";
import { S, useStore, send, toast } from "../../../store.js";

export default function ComputerPage() {
  useStore();
  const hs = S.hostSettings;
  const [on, setOn] = useState(!!hs?.computerEnabled);
  // settings 回包后同步开关态
  useEffect(() => {
    setOn(!!S.hostSettings?.computerEnabled);
  }, [hs]);
  const toggle = () => {
    const next = !on;
    setOn(next);
    send({ type: "set_setting", key: "computer.enabled", value: next });
    toast("已写入。电脑控制对之后新建的会话生效。");
  };
  return (
    <div className="set-page" id="pg-computer">
      <div className="set-tt">电脑控制</div>
      <div className="set-card">
        <div className="srow">
          <div className="srow-tx"><b>启用电脑控制</b><span>允许 Agent 使用截图、输入、辅助功能等电脑控制工具。新会话后生效。</span></div>
          <div className={"tg" + (on ? " on" : "")} id="tgComputer" onClick={toggle}><i></i></div>
        </div>
        <div className="srow unavailable">
          <div className="srow-tx"><b>在输入框显示电脑操作按钮</b><span>没有 CUA helper，输入区不会出现电脑操作入口。</span></div>
          <div className="tg disabled"><i></i></div>
        </div>
      </div>
    </div>
  );
}
