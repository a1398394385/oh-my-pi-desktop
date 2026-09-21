// 空态启动器（右栏 tab 全部关闭，对齐 ZCode side-pane 空态）：
// 居中图标 + 标题/副文两行 + 入口钮列表（h-12 横条，宽容器经容器查询切成两列网格）。
import { S, useStore, activeOpen } from "../../store.js";
import Icon from "../../Icon.jsx";
import { TAB_META, openRightTab } from "./tabs.js";

export default function StartPage() {
  useStore();
  const s = activeOpen();
  return (
    <div className="rt-start">
      <span className="rt-start-ic">
        <Icon name="panelRight" size={30} />
      </span>
      <div className="rt-start-tt">打开标签页</div>
      <div className="rt-start-sub">选择要在侧边面板中打开的标签。</div>
      <div className="rt-list">
        {["subagent", "gitdiff", "file", "bgcmd", "tree"].map((name) => {
          const meta = TAB_META[name];
          const off = name === "gitdiff" && !s?.isGit;
          return (
            <button
              key={name}
              className={"rt-item" + (off ? " off" : "")}
              title={off ? "当前项目不是 git 仓库" : undefined}
              onClick={off ? undefined : () => openRightTab(name)}
            >
              <span className="rt-item-ic">
                <Icon name={meta.icon} size={15} />
              </span>
              <span className="rt-item-tx">{meta.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
