// 起始页（右栏 tab 全部关闭后）：标题 + 副文 + 卡片网格（整体居中；一行最多 3 张超出换行）。
import { S, useStore, activeOpen } from "../../store.js";
import Icon from "../../Icon.jsx";
import { TAB_META, openRightTab } from "./tabs.js";

export default function StartPage() {
  useStore();
  const s = activeOpen();
  return (
    <div className="rt-start">
      <div className="rt-start-tt">打开标签页</div>
      <div className="rt-start-sub">选择要在侧边面板中打开的标签。</div>
      <div className="rt-grid">
        {["subagent", "gitdiff", "file", "bgcmd", "tree"].map((name) => {
          const meta = TAB_META[name];
          const off = name === "gitdiff" && !s?.isGit;
          return (
            <button
              key={name}
              className={"rt-card" + (off ? " off" : "")}
              title={off ? "当前项目不是 git 仓库" : undefined}
              onClick={off ? undefined : () => openRightTab(name)}
            >
              <span className="rt-card-ic">
                <Icon name={meta.icon} size={14} />
              </span>
              <span className="rt-card-tx">{meta.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
