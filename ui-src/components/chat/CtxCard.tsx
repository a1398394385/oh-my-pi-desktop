// 上下文明细卡（原 ui/ringpop.js 的 buildCtxCard/buildLimitsSection/mountRingPop/
// fillCtxCard/fillLimits/initRingpop 的 ctxRing 段 1:1 平移为 React 组件）。
// 交互规范见 AGENTS.md「弹出卡片设计规范（ring-pop 系）」：150ms 悬停定器、
// 朝卡离开 250ms 宽限、卡上 hover 不关闭、数据到达「移开即弃」（卡收起时 store
// 更新不触发重建，下次悬停重新请求）。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { S, useStore, activeOpen, send, fmtTokens, type TimerHandle } from "../../store";
import { placeMenu } from "../../shell";

// 限额窗口（host limits 帧透传）：只约束本组件读取的字段
interface LimitWindow {
  label?: string;
  kind?: string;
  usedPercent?: number | null; // 宿主可能下发 null(未限额窗口)
  remainingPercent?: number | null;
  resetsAt?: string | number | null;
  metric?: string;
}
// 供应商限额回包形状（S.ctxLimits）
interface CtxLimits {
  label?: string;
  unsupported?: boolean;
  status?: string;
  windows?: LimitWindow[];
  balance?: { amount?: number | null; currency?: string } | null; // 宿主恒下发字段,null = 无余额段
}

// 限额窗口 → 展示项:百分比取整,重置时间 24h 内给时刻、否则给月日（原 fmtLimitWindow）
const LIMIT_LABELS: Record<string, string> = { "5-hour": "5小时", "5h": "5小时", weekly: "每周", daily: "每日", session: "会话" };
function fmtLimitWindow(w: LimitWindow): { label: string; pct: number | null; reset: string } {
  const pct = w.usedPercent != null ? Math.round(w.usedPercent) : w.remainingPercent != null ? 100 - Math.round(w.remainingPercent) : null;
  let reset = "";
  if (w.resetsAt) {
    const t = new Date(w.resetsAt);
    const withinDay = t.getTime() - Date.now() < 24 * 3600 * 1000;
    reset = withinDay
      ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`
      : `${t.getMonth() + 1}月${t.getDate()}日`;
  }
  const raw = w.label || w.kind || "";
  return { label: LIMIT_LABELS[raw.toLowerCase()] ?? raw, pct, reset };
}

// 条形色带按索引取 token 色环（旧版 4 色硬编码 palette 的 token 等价：accent/purple/orange/green）
const LIMIT_BAR_COLORS = ["var(--accent)", "var(--purple)", "var(--orange)", "var(--green)"];

// 配额段（原 buildLimitsSection 平移）：弹卡版照旧版 ring-pop 的 cx-sec/lx-* 结构
function LimitsSection({ limits, noDiv }: { limits: CtxLimits; noDiv?: boolean }) {
  const windows = limits.windows ?? [];
  const balance = limits.balance;
  let body;
  if (limits.unsupported) {
    body = "该供应商暂不支持限额查询";
  } else if (limits.status === "notConfigured") {
    body = "未配置该供应商凭证";
  } else if (!windows.length && !balance) {
    body = "限额暂不可用";
  } else {
    // 余额类供应商（host 侧 synthesize 的 metric:'credits' 窗口 + balance）只显示余额数字，
    // 不渲染进度条和百分比；有百分比窗口的供应商仍按窗口渲染
    const pctWindows = windows.filter((w) => w.metric !== "credits");
    if (!pctWindows.length && balance?.amount != null) {
      body = (
        <div className="lx-bal">余额 {balance.amount} {balance.currency ?? ""}</div>
      );
    } else if (!pctWindows.length) {
      body = "限额暂不可用";
    } else {
      body = (
        <>
          <div className="lx-grid">
            {pctWindows.slice(0, 4).map((w, i) => {
              const item = fmtLimitWindow(w);
              return (
                <div className="lx-col" key={i}>
                  <div className="lx-top"><span>{item.label}</span></div>
                  <div className="lx-mid">
                    {item.pct != null ? `${item.pct}%` : "—"}
                    {item.reset ? <span> · {item.reset}</span> : null}
                  </div>
                  <div className="lx-bar">
                    <i style={{ width: `${item.pct != null ? Math.min(100, item.pct) : 0}%`, background: LIMIT_BAR_COLORS[i % 4] }} />
                  </div>
                </div>
              );
            })}
          </div>
          {balance?.amount != null && (
            <div className="lx-bal">余额 {balance.amount} {balance.currency ?? ""}</div>
          )}
        </>
      );
    }
  }
  return (
    <div className={"cx-sec lx-sec" + (noDiv ? " no-div" : "")}>
      <div className="lx-head">
        <b>剩余额度</b>
        <span className="lx-prov">{limits.label ?? ""}</span>
      </div>
      <div className="lx-body">{body}</div>
    </div>
  );
}

// 组成行圆点色：旧版 6 档蓝色硬编码的 token 等价（只用 token，不硬编码十六进制）
const ROW_DOT_COLORS = ["var(--blue)", "var(--accent)", "var(--dim)", "var(--faint)", "var(--blue)", "var(--accent)"];

// 上下文明细组成（S.ctxDetail.breakdown）：只约束本组件读取的字段
interface CtxBreakdown {
  usedTokens: number;
  contextWindow: number;
  mcpToolsTokens?: number;
  systemToolsTokens: number;
  systemPromptTokens: number;
  skillsTokens: number;
  messagesTokens: number;
  systemContextTokens: number;
}

export default function CtxCard({ anchorRef }: { anchorRef: RefObject<HTMLElement | null> }) {
  useStore(); // 订阅 S.ctxDetail/S.ctxLimits：回包到达即重绘（卡开着时）
  const [open, setOpen] = useState(false);
  const [noModel, setNoModel] = useState(false); // 无会话且输入框未选模型：卡片显示「暂无可用模型」
  const [compactBusy, setCompactBusy] = useState(false); // 压缩按钮 pending（回包由 core 既有逻辑收尾）
  const popRef = useRef<HTMLDivElement | null>(null); // 弹卡 DOM（portal 到 body，定位/宽限判定都要用）
  const enterTimer = useRef<TimerHandle | undefined>(undefined); // 环悬停定器（150ms，停够才弹）
  const leaveTimer = useRef<TimerHandle | undefined>(undefined); // 环→卡间隙宽限定器（250ms，朝卡离开途中不关闭）

  // 收卡：移开即弃——DOM 卸载，残留瞬态数据下次悬停时清零重请求
  const dismiss = () => {
    clearTimeout(leaveTimer.current);
    setOpen(false);
  };

  // 锚点（ctxRing）hover 接线：受控渲染，事件挂到 span 上，不动 ctxRing 内部 svg 结构
  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const onEnter = () => {
      const s = activeOpen();
      clearTimeout(enterTimer.current);
      clearTimeout(leaveTimer.current);
      setNoModel(false);
      setCompactBusy(false);
      // 150ms 悬停定器：划过不打扰，提前离开取消
      enterTimer.current = setTimeout(() => {
        // 弹卡瞬态数据清零（移开即弃）：上次残留不展示，结果到达后经 store 补绘
        S.ctxDetail = null;
        S.ctxLimits = null;
        setOpen(true);
        if (s) {
          send({ type: "get_context_detail", sessionId: s.sessionId });
          send({ type: "get_limits", sessionId: s.sessionId });
        } else {
          // 不在会话中也允许弹出:不显示上下文明细,仅按当前输入框所选模型的供应商显示配额
          // 模型 id 为 "provider/model" 格式(host modelsPayload),直接取首段
          const prov = S.newSessionModel ? S.newSessionModel.split("/")[0] : "";
          if (prov) send({ type: "get_limits", provider: prov });
          else setNoModel(true);
        }
      }, 150);
    };
    const onLeave = (e: MouseEvent) => {
      clearTimeout(enterTimer.current);
      const pop = popRef.current;
      if (pop?.contains(e.relatedTarget as Node | null)) return; // 直接移入卡片,由卡片 mouseleave 关闭
      clearTimeout(leaveTimer.current);
      // 仅当向上朝卡片区域离开时才宽限(环↔卡 7px 间隙,途中 relatedTarget 可能为空);
      // 往旁边/下方离开立即收回
      const r = el.getBoundingClientRect();
      const pr = pop?.getBoundingClientRect();
      const towardCard = !!pr && e.clientY <= r.top + 2 && e.clientX >= pr.left - 12 && e.clientX <= pr.right + 12;
      if (!towardCard) {
        dismiss();
        return;
      }
      leaveTimer.current = setTimeout(() => {
        if (popRef.current && !popRef.current.matches(":hover")) dismiss();
      }, 250);
    };
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      clearTimeout(enterTimer.current);
      clearTimeout(leaveTimer.current);
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [anchorRef]);

  // 定位：弹层出现在环正上方,底边距环顶 7px,水平中心对齐,视口内收 8px;
  // 视觉坐标经 placeMenu 除以 zoomLevel 补偿(fixed + zoom 二次缩放坑)。
  // 无依赖:每次渲染都跑——数据到达重绘后内容高度变化需重新定位（等价旧版 mountRingPop 里的 placeRingPop）
  useLayoutEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const el = anchorRef.current;
    if (!pop || !el) return;
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), window.innerWidth - w - 8);
    const top = Math.max(r.top - h - 7, 8);
    placeMenu(pop, left, top);
  });

  if (!open) return null; // 移开即弃：卡收起时不渲染，store 到数也不重建

  // breakdown 为底座 getContextBreakdown 展开(frames.ts 标注形状随 SDK):按本组件读取字段收窄,
  // 键缺失运行期为 undefined,组件展示层原有兜底语义不变
  const b = (S.ctxDetail?.breakdown ?? null) as CtxBreakdown | null;
  const limits: CtxLimits | null = S.ctxLimits ?? null;
  const cur = activeOpen();
  // 压缩上下文入口:会话非空且占用 > 0 才显示;流式中禁用(与运行中 turn 竞态)。
  // 压缩非破坏性,直接执行不弹确认;点击后置 pending,回包 toast / messages 帧由 store 既有逻辑收尾
  const canCompact = !!cur && cur.items.length > 0 && !!b && b.usedTokens > 0;

  return createPortal(
    <div
      className="ring-pop"
      ref={popRef}
      onMouseEnter={() => clearTimeout(leaveTimer.current)} // 进入卡片取消宽限关闭
      onMouseLeave={dismiss} // 离开卡片（区域外不再保持）直接关闭
    >
      {b ? (
        <>
          <div className="cx-head">
            <b>上下文</b>
            {/* 右侧数字与下方分类行同款:数值 | 百分比,竖线分隔、右对齐 */}
            <span className="cx-total">
              <span className="cx-val">{fmtTokens(b.usedTokens)}</span>
              <i className="cx-sep" />
              <span className="cx-pct">{((b.usedTokens / b.contextWindow) * 100).toFixed(1)}%</span>
            </span>
          </div>
          <div className="cx-bar">
            <i style={{ width: `${Math.min(100, (b.usedTokens / b.contextWindow) * 100).toFixed(1)}%` }} />
          </div>
          {/* 组成行固定 6 项(ZCode 同款分类):右侧数值与百分比等宽右对齐,中间虚线分隔。
              MCP 工具 = mcp__ 前缀工具的 schema token(host 单独估算);其他 = 系统上下文注入 */}
          {(() => {
            const mcpTokens = b.mcpToolsTokens ?? 0;
            const pct = (v: number) => (b.usedTokens > 0 ? ((v / b.usedTokens) * 100).toFixed(1) : "0.0") + "%";
            const rows: [string, number][] = [
              ["系统工具", Math.max(0, b.systemToolsTokens - mcpTokens)],
              ["MCP 工具", mcpTokens],
              ["系统提示词", b.systemPromptTokens],
              ["技能", b.skillsTokens],
              ["消息", b.messagesTokens],
              ["其他", b.systemContextTokens],
            ];
            return rows.map(([label, v], i) => (
              <div className="cx-row" key={label}>
                <span className="dot" style={{ background: ROW_DOT_COLORS[i] }} />
                <span>{label}</span>
                <span className="cx-val">{fmtTokens(v)}</span>
                <i className="cx-sep" />
                <span className="cx-pct">{pct(v)}</span>
              </div>
            ));
          })()}
        </>
      ) : null}
      {limits ? <LimitsSection limits={limits} noDiv={!b} /> : null}
      {canCompact && (
        <div className="cx-act">
          <button
            className={"cx-compact-btn" + (compactBusy ? " busy" : "")}
            disabled={!!cur.streaming || compactBusy}
            onClick={() => {
              if (compactBusy) return;
              setCompactBusy(true);
              send({ type: "compact_session", sessionId: cur.sessionId });
            }}
          >
            {compactBusy ? "压缩中…" : "压缩上下文"}
          </button>
        </div>
      )}
      {/* 空态:无模型供应商给「暂无可用模型」;明细回包到了但没组成/限额给「暂无数据」;否则等回包 */}
      {!b && !limits ? (noModel ? "暂无可用模型" : S.ctxDetail ? "上下文用量暂无数据" : "加载中…") : null}
    </div>,
    document.body,
  );
}
