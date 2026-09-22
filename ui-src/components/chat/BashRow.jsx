// 本地 bash 执行行（输入框 ! 前缀命令）：复用终端行（ToolRow CmdRow）的视觉语言——
// 上命令、下输出的展开卡 + ed-arrow 箭头。状态区：运行中转圈 / exit 码 /
// 已取消 / 不进上下文标签 / 错误文本。默认收起，点击头部展开。
import { notify } from "../../store.js";
import Icon from "../../Icon.jsx";
import { Ellip, useLift } from "./parts.jsx";

export default function BashRow({ item }) {
  const [closing, close] = useLift();
  const open = item.cmdExpanded && !closing;
  const toggle = () => {
    if (item.cmdExpanded) close(() => { item.cmdExpanded = false; notify(); });
    else {
      item.cmdExpanded = true;
      notify();
    }
  };
  // 状态区：running 转圈优先；error 红字；cancelled 灰标；其余按 exitCode 着色
  let status;
  if (item.running) status = <span className="cmd-spin" />;
  else if (item.error != null) status = <span className="bad">{item.error}</span>;
  else if (item.cancelled) status = <span>已取消</span>;
  else if (item.exitCode != null && item.exitCode !== 0) status = <span className="bad">{`exit ${item.exitCode}`}</span>;
  else status = <span>{item.exitCode === 0 ? "exit 0" : "已完成"}</span>;
  return (
    <>
      <div className="cmd bash-row" style={{ cursor: "pointer" }} onClick={toggle}>
        <Ellip className="c-tx" title={item.text}>{`$ ${item.text}`}</Ellip>
        {item.excludeFromContext && <span className="bash-tag">不进上下文</span>}
        <span className="bash-status">{status}</span>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {open && (
        <pre className={"bash-out" + (closing ? " lift" : " drop")}>
          {item.output || "（无输出）"}
          {item.truncated ? "\n…（输出已截断）" : ""}
        </pre>
      )}
    </>
  );
}
