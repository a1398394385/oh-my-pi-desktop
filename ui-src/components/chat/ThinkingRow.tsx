// 思考行：任何设置下思考标签都显示（uiPrefs.showThinking 只决定流式开始时默认展开与否，
// 展开态记在 item.expanded 上由 store 写入）。标签行点击展开/收起 think-body。
// 迁移自 ui/tool-labels.js renderThink；原版展开时的视口锚定在 React 下天然成立——
// DOM 节点复用、scrollTop 不动即「点击行不动」，贴底时由 Chat 的滚动 effect 钉底。
import { useEffect, useRef } from "react";
import { notify } from "../../store";
import Icon from "../../Icon";
import { useLift } from "./parts";

// 思考行可渲染的最小形状:thinking 条目本身;tool 条目(name==="thinking")经 ToolRow 兜底
// 分流进来时这些可选字段运行期为 undefined(结构性兼容,无需断言)
interface ThinkRowItem {
  text: string;
  thinking?: string;
  expandable?: boolean;
  expanded?: boolean;
  streaming?: boolean;
}

export default function ThinkingRow({ item, fk }: { item: ThinkRowItem; fk?: string }) {
  const [closing, close] = useLift();
  const expandable = item.expandable || item.thinking;
  const open = item.expanded && !closing;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // think-scroll 底部虚化解禁：滚到底（或内容不足一屏）时加 no-fade（滚动职责在内层
  // .think-scroll：外层保持自然高度，左侧竖线不随滚动移出视口）
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const sync = () => sc.classList.toggle("no-fade", sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1);
    sc.addEventListener("scroll", sync, { passive: true });
    requestAnimationFrame(sync);
    return () => sc.removeEventListener("scroll", sync);
  }, [open]);

  const toggle = () => {
    if (item.expanded) close(() => { item.expanded = false; notify(); });
    else {
      item.expanded = true;
      notify();
    }
  };

  return (
    <>
      <div
        className="act think"
        data-fk={fk || undefined}
        style={expandable ? { cursor: "pointer" } : undefined}
        onClick={expandable ? toggle : undefined}
      >
        <span className="th-ic"><Icon name="think" size={13} /></span>
        <span className="lbl">{item.text || "思考 · 持续了几秒"}</span>
        {expandable && (
          <span className={"th-more" + (open ? " open" : "")}>
            <Icon name="chevronRight" size={10} />
          </span>
        )}
      </div>
      {open && (item.thinking || item.streaming) && (
        <div className="think-body kids-in">
          <div className="think-scroll" ref={scrollRef}>{item.thinking || "…"}</div>
        </div>
      )}
    </>
  );
}
