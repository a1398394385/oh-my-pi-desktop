// loop 组：一轮结束后的过程收存（thinking/工具/中间响应）收起为一行摘要，点击整组展开。
// 迁移自 ui/chat.js 的 loop 分支。展开时子行同时入场（不加错峰：子行数量无上限）+
// lp-kids 容器 grid 行高 0fr→1fr 过渡；收起时容器收拢（closing），310ms 后落盘卸载。
import { useEffect, useRef } from "react";
import { notify, fmtTokens } from "../../store.js";
import { fmtDuration } from "../../../ui/sidebar.js";
import Icon from "../../Icon.jsx";
import { useLift } from "./parts.jsx";
import { renderItems } from "./items.jsx";

// loop 组收起时的汇总文本：「已工作 xx 分 xx 秒, 总消耗 input xx, output xx, cache read xx[, cache write xx]」
export function loopSummaryText(item) {
  const parts = [];
  if (item.durationSec != null) parts.push(`已工作 ${fmtDuration(item.durationSec)}`);
  const u = item.usage;
  if (u) {
    const seg = [`input ${fmtTokens(u.input)}`, `output ${fmtTokens(u.output)}`, `cache read ${fmtTokens(u.cacheRead)}`];
    if (u.cacheWrite > 0) seg.push(`cache write ${fmtTokens(u.cacheWrite)}`);
    parts.push(`总消耗 ${seg.join(", ")}`);
  }
  return parts.join(", ");
}

export default function LoopGroup({ item, fk, railEntries }) {
  const [closing, close] = useLift();
  const kidsRef = useRef(null);

  // 展开挂载：子行加 kids-in 播入场动画 + 容器自 0fr 展开（原 S.animateLoopKids 语义；
  // 流式重绘时 effect 不重跑、动画不重播，切会话重挂载会重播一次，属可接受差异）
  useEffect(() => {
    const kids = kidsRef.current;
    if (!kids) return;
    for (const el of kids.firstElementChild.children) el.classList.add("kids-in");
    kids.style.gridTemplateRows = "0fr";
    requestAnimationFrame(() => requestAnimationFrame(() => { kids.style.gridTemplateRows = ""; }));
  }, [item.collapsed]);

  const toggle = () => {
    if (item.collapsed) {
      item.collapsed = false;
      notify();
    } else {
      // 收起：容器高度收拢到 0（0.3s，与项目列表同一套），结束后落盘重渲染
      close(() => {
        item.collapsed = true;
        notify();
      }, 310);
    }
  };

  return (
    <>
      <div className="act loop" style={{ cursor: "pointer" }} onClick={toggle}>
        <span className="lp-tx">{loopSummaryText(item)}</span>
        <span className={"lp-arrow" + (!item.collapsed && !closing ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {!item.collapsed && (
        // 子项包一层容器：grid 行高 0fr↔1fr 过渡做整组展开/收起动画（与项目列表一致）
        <div className={"lp-kids" + (closing ? " closing" : "")} ref={kidsRef}>
          <div className="lp-kids-in">{renderItems(item.items || [], (fk || "") + "-", railEntries)}</div>
        </div>
      )}
    </>
  );
}
