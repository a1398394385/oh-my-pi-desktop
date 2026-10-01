// 子代理页：卡片列表 + 点击进详情。
// 详情骨架（今日定稿，必须保留）：#rightBody 加 detail 类，rb-head 固定（返回 + 名字/状态），
// rb-scroll 滚动承载过程流。
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump } from "../../store";
import { inlineCodeHtml } from "./helpers";
import { Spin } from "../chat/parts";
import type { SubagentState, SubagentToolCall } from "../../types/session";

// 子代理条目与工具行统一用 store 共享类型(types/session.ts),字段以本页读取为准

export default function SubagentPage() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const selectedSubagent = useAppStore((st) => st.selectedSubagent);
  if (!s || s.subagents.size === 0) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">{t("right.noSubagents")}</div>;
  }
  if (selectedSubagent && s.subagents.has(selectedSubagent)) {
    return <SubagentDetail sub={s.subagents.get(selectedSubagent)!} />; // 上一行 has() 已守卫必存在
  }
  return (
    <>
      {[...s.subagents].map(([id, sub]) => (
        <button
          key={id}
          className={"sub-card " + (sub.streaming ? "running" : sub.status)}
          onClick={() => {
            // 入场动画标记：与 selectedSubagent 同次 setState（订阅者渲染时读到），
            // 宏任务静默复位——复位无订阅者不触发渲染，kids-in 类保留，动画不被截断（原 notify 语义）
            useAppStore.setState((st) => ({ selectedSubagent: id, animateSubKids: true }));
            setTimeout(() => {
              useAppStore.setState({ animateSubKids: false });
            }, 0);
          }}
        >
          <div className="flex items-center gap-1.5 text-ui-base text-text">
            <span className="sub-dot">
              {sub.streaming ? "●" : sub.status === "completed" ? "✓" : sub.status === "failed" ? "✗" : "○"}
            </span>
            <span>{sub.agent}</span>
          </div>
          <div className="text-ui-sm text-faint mt-1 line-clamp-2">{sub.description || sub.text.slice(0, 60) || "…"}</div>
        </button>
      ))}
    </>
  );
}

// 详情：返回 + 名字/状态固定在顶，过程流（工具行 + 当前文本）滚动
function SubagentDetail({ sub }: { sub: SubagentState }) {
  const { t } = useTranslation();
  const headRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 脉冲标记渲染时读 getState（不订阅）：置位随 selectedSubagent 写入驱动本组件渲染，
  // 宏任务静默复位不触发订阅——kids-in 类保留至下次渲染，入场动画不被截断（原 notify 后首帧为 true）
  const kids = !!useAppStore.getState().animateSubKids;
  const back = () => {
    // 收起：详情内容上收（0.3s）后切回列表
    for (const el of [headRef.current, scrollRef.current]) el?.classList.add("lift");
    setTimeout(() => {
      setBump({ selectedSubagent: null });
    }, 310);
  };
  return (
    <>
      <div ref={headRef} className={"rb-head" + (kids ? " kids-in" : "")}>
        <button className="self-start mb-1.5 border-0 bg-transparent text-dim text-ui-sm cursor-pointer py-0.5 px-1.5 rounded-sm hover:bg-panel-2 hover:text-text" onClick={back}>
          {t("right.backToList")}
        </button>
        <div className="text-ui-sm text-faint mb-1.5 break-all">
          {sub.agent} · {sub.status}
        </div>
      </div>
      <div ref={scrollRef} className={"rb-scroll flex flex-col gap-2" + (kids ? " kids-in" : "")}>
        {sub.tools.map((t, i) => (
          <ToolLine key={i} t={t} />
        ))}
        {(sub.text || sub.streaming) && (
          <div
            className={"step-title" + (sub.streaming ? " flash" : "")}
            dangerouslySetInnerHTML={{ __html: inlineCodeHtml(sub.text || "…") }}
          />
        )}
      </div>
    </>
  );
}

// 工具行轻量摘要：命令 / 路径 / 模式等首个可读参数
function toolSummary(t: SubagentToolCall): string {
  // args 在 store 侧为 unknown(宿主透传);本页只读取这几个摘要字段
  const a = (t.args || {}) as { command?: string; path?: string; pattern?: string; files?: string[] };
  return a.command || a.path || a.pattern || a.files?.[0] || t.files?.[0] || "";
}

// TODO(tool-row-wave)：完整工具行视觉（tool-labels.js 各标签渲染）依赖旧 core.js，
// 待主对话区（chat-wave）翻译后统一复用；此处先以「标签 + 摘要」行呈现
function ToolLine({ t }: { t: SubagentToolCall }) {
  const sum = toolSummary(t);
  return (
    <div className="act read">
      <span className="lbl">{t.name}</span>
      {sum ? (
        <span className="path" title={sum}>
          {sum}
        </span>
      ) : null}
      {t.running ? <Spin /> : null}
    </div>
  );
}
