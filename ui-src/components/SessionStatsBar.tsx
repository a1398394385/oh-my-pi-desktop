// 会话统计行：输入框 dock 下方常驻一行，展示整会话口径的
// 缓存利用率 / 输入 / 输出 / 缓存读 / 缓存写 / 成本 / 活跃时长。
// 数据由 host 在 turn 收尾（agent_end）与加载会话时经 session_stats 帧推送，
// 落在会话对象的 stats 字段（见 store.js），不做 hover 按需请求。
import { useAppStore, fmtTokens, fmtDurationMs } from "../store";
import { useTranslation } from "react-i18next";

export default function SessionStatsBar() {
  const { t } = useTranslation();
  // 当前会话订阅：session_stats 帧走 updateSession 换 session 引用，selector 即可感知
  const session = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath) : undefined));
  const st = session?.stats;
  if (!st) return null; // 首轮结束前（或会话未加载完）没有统计，不占位

  const cost = (st.cost ?? 0) + (st.advisorCost ?? 0);
  const items = [
    [t("chat.statsCacheHit"), `${(st.cacheHitRate * 100).toFixed(1)}%`],
    [t("chat.statsInput"), fmtTokens(st.tokens.input)],
    [t("chat.statsOutput"), fmtTokens(st.tokens.output)],
    [t("chat.statsCacheRead"), fmtTokens(st.tokens.cacheRead)],
    [t("chat.statsCacheWrite"), fmtTokens(st.tokens.cacheWrite)],
    ...(cost > 0 ? [[t("chat.statsCost"), `$${cost.toFixed(4)}`]] : []),
    [t("chat.statsDuration"), fmtDurationMs(st.activeMs)],
  ];

  return (
    <div className="stats-bar" id="statsBar">
      {items.map(([k, v]) => (
        <span className="inline-flex items-baseline gap-[5px]" key={k}>
          <span className="sb-k">{k}</span>
          <span className="text-dim">{v}</span>
        </span>
      ))}
    </div>
  );
}
