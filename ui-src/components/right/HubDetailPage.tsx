// Agent Hub linked detail page (right sidebar): mirrors the TUI hub's inspector panel —
// status/name header, Task, Current, Usage (+context gauge), Lineage, Changes/Output and a
// Recent activity feed. Rendered two ways: through the middle-card Agent Hub selection
// (hubSel, while the hub is open), and from the subagent tab's list (selectedSubagent) with
// a back-to-list button pinned above (see SubagentPage).
import { useEffect, useReducer } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { useAppStore, fmtTokens, fmtDurationMs } from "../../store";
import { modelShort, fmtClock, subStatus, type SegT } from "./subShared";
import { rowSpec } from "./subRowSpec";
import { Ellip, Spin } from "../chat/parts";
import { codePlugin, mdComponents, mdControls, MD_LINK_SAFETY_OFF } from "../chat/AssistantMsg";
import Icon from "../../Icon";
import type { SubagentState } from "../../types/session";
import { sendGetBgJobs, sendCancelBgJob } from "./hubExt";
import type { BgJobEntry } from "../../store/session";

// Relative "active N ago" age (same bucketing as the roster)
function ageText(sec: number, t: SegT): { text: string; isNow: boolean } {
  if (sec < 5) return { text: t("right.closedNow"), isNow: true };
  if (sec < 3600) return { text: t("right.closedMin", { n: Math.floor(sec / 60) || 1 }), isNow: false };
  if (sec < 86400) return { text: t("right.closedHour", { n: Math.floor(sec / 3600) }), isNow: false };
  return { text: t("right.closedDay", { n: Math.floor(sec / 86400) }), isNow: false };
}

// Context gauge, TUI-style: a compact token/contextWindow bar
function ContextGauge({ tokens, window }: { tokens: number; window: number }) {
  if (!window) return null;
  const pct = Math.min(100, Math.round((tokens / window) * 100));
  return (
    <div className="hub-gauge" title={`${tokens}/${window} (${pct}%)`}>
      <div className="hub-gauge-fill" style={{ width: pct + "%" }} />
      <span className="hub-gauge-tx">
        {fmtTokens(tokens)} / {fmtTokens(window)} · {pct}%
      </span>
    </div>
  );
}

export default function HubDetailPage() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const hubSel = useAppStore((st) => st.hubSel);
  const sub = hubSel ? s?.subagents.get(hubSel) : undefined;
  // Live elapsed / age repaint while the selected subagent streams
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!sub?.streaming) return;
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [sub?.streaming]);
  if (!sub) {
    return <div className="py-3 text-faint text-ui-base">{t("right.hubEmpty")}</div>;
  }
  return <HubDetail sub={sub} sessionId={s?.sessionId} t={t} />;
}

export function HubDetail({ sub, t, sessionId }: { sub: SubagentState; t: SegT; sessionId?: string }) {
  const st = subStatus(sub);
  const u = sub.usage;
  const now = Date.now();
  const elapsed = sub.streaming && sub.registeredAt ? now - sub.registeredAt : (u?.durationMs ?? 0);
  const lastActivity = sub.registeredAt ? sub.registeredAt + (u?.durationMs ?? 0) : undefined;
  const age = lastActivity ? ageText(Math.max(1, Math.round((now - lastActivity) / 1000)), t) : null;
  // Hub extension state (18.5): bg-jobs snapshot map (canonical wsHandlers landing) +
  // cache-warming transient. Selectors return stored references / primitives — never fresh
  // objects; null jobs (no entry yet) renders the pending state.
  const bgJobs = useAppStore((s2) => s2.bgJobs);
  const warming = useAppStore((s2) => (sessionId ? s2.hubWarming === sessionId : false));
  const jobs: BgJobEntry[] | null = sessionId ? (bgJobs.get(sessionId) ?? null) : null;
  // Detail open = fetch time for the session's background jobs (snapshot replies refresh it)
  useEffect(() => {
    if (sessionId) sendGetBgJobs(sessionId);
  }, [sessionId]);
  const model = modelShort(u?.resolvedModel);
  const current = u?.currentTool
    ? u.currentTool + (u.currentToolArgs ? ` · ${JSON.stringify(u.currentToolArgs)}` : "")
    : (u?.lastIntent ?? "");
  // Task block renders as markdown; the raw transcript fallback stays truncated
  const task = sub.description || sub.task || (sub.text ? sub.text.slice(0, 300) : "");
  const segs: string[] = [];
  if (elapsed > 0) segs.push(fmtDurationMs(elapsed));
  if (age) segs.push(age.isNow ? t("right.closedNow") : t("right.hubActiveAgo", { age: age.text }));
  // Activity: tool stream in arrival order (rows carry the frontend-stamped clock)
  const activity = sub.tools.slice(-40);

  return (
    <div className="hub-detail">
      <div className={"hub-detail-head st-" + st}>
        <span className="sub-dot">{st === "running" ? "●" : st === "completed" ? "✓" : st === "failed" ? "✗" : "○"}</span>
        <b>{sub.name ?? sub.agent}</b>
        <span className="hub-detail-id text-faint">{sub.agent}</span>
        {/* Status + elapsed/age pinned to the top-right; model sits beneath */}
        <span className="hub-detail-st text-ui-sm text-faint">
          {warming ? <span className="hub-warming">{t("hubExt.warming")}</span> : null}
          <span className="hub-detail-st-line">
            {st}
            {segs.length > 0 ? " · " + segs.join(" · ") : ""}
          </span>
          {model ? <span className="hub-detail-model text-dim">{model}</span> : null}
        </span>
      </div>

      {task ? (
        <>
          <div className="hub-sec">{t("right.hubTask")}</div>
          <div className="hub-sec-body hub-task-md md-body">
            <Streamdown
              plugins={{ code: codePlugin, cjk }}
              components={mdComponents}
              lineNumbers={false}
              codeBlockMaxHeight={400}
              tableMaxHeight={0}
              controls={mdControls}
              linkSafety={MD_LINK_SAFETY_OFF}
            >
              {task}
            </Streamdown>
          </div>
        </>
      ) : null}

      {current ? (
        <>
          <div className="hub-sec">{t("right.hubCurrent")}</div>
          <div className="hub-sec-body text-dim">{current}</div>
        </>
      ) : null}

      <div className="hub-sec">{t("right.hubUsageT")}</div>
      <div className="hub-sec-body text-dim">
        {u ? (
          <>
            {u.cost != null && u.cost > 0 ? `$${u.cost.toFixed(4)} · ` : ""}
            {elapsed > 0 ? fmtDurationMs(elapsed) + " · " : ""}
            {u.requests ?? 0} req · {u.toolCount ?? sub.tools.length} tools
            {u.tokens ? " · " + fmtTokens(u.tokens.total ?? Object.values(u.tokens).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0)) + " tok" : ""}
          </>
        ) : (
          "—"
        )}
      </div>
      {u?.contextTokens !== undefined && u.contextWindow ? <ContextGauge tokens={u.contextTokens} window={u.contextWindow} /> : null}

      <div className="hub-sec">{t("right.hubLineage")}</div>
      <div className="hub-sec-body text-dim">
        {t("right.hubSpawnedBy", { parent: sub.parent ?? "Main" })}
        {sub.registeredAt ? (
          <div className="text-faint mt-0.5">{t("right.hubRegistered", { time: fmtClock(sub.registeredAt) })}</div>
        ) : null}
      </div>

      <div className="hub-sec">{t("right.hubChanges")}</div>
      <div className="hub-sec-body text-dim">
        {sub.advisor || sub.readOnly ? t("right.hubReadonlyLoc") : t("right.hubWorkspace")}
      </div>
      {sub.sessionFile ? (
        <div className="hub-sec-body text-dim">
          <b>{t("right.hubOutputLabel")}</b>
          <div className="text-faint mt-0.5 break-all">{sub.sessionFile}</div>
        </div>
      ) : null}

      <div className="hub-sec">{t("right.hubRecent")}</div>
      <div className="hub-activity">
        {activity.length === 0 ? (
          <div className="text-faint">{t("right.hubNoActivity")}</div>
        ) : (
          activity.map((call, i) => {
            const spec = rowSpec(call);
            const label = spec.label.includes(".") ? t(spec.label) : spec.label;
            // Same visual language as the main message area's event rows: icon + label + summary
            return (
              <div className="act read hub-act" key={call.toolCallId ?? i}>
                <span className="hub-act-time text-faint">{call.at ? fmtClock(call.at) : ""}</span>
                <Icon name={spec.icon} size={15} />
                <span className="lbl">{label}</span>
                {spec.summary ? (
                  <Ellip className="path" title={spec.summary}>
                    {spec.summary}
                  </Ellip>
                ) : null}
                {call.running ? <Spin /> : null}
              </div>
            );
          })
        )}
      </div>

      {/* Background jobs (session-scoped, 18.5 contract v1): fetched when the detail opens,
          refreshed by bg_jobs snapshot replies. Unknown session (no sessionId) hides it. */}
      {sessionId ? (
        <>
          <div className="hub-sec">{t("hubExt.bgTitle")}</div>
          {jobs === null ? (
            <div className="hub-sec-body text-faint">{t("hubExt.bgPending")}</div>
          ) : jobs.length === 0 ? (
            <div className="hub-sec-body text-faint">{t("hubExt.bgEmpty")}</div>
          ) : (
            <div className="hub-bg-list">
              {jobs.map((j) => (
                <div className="hub-bg-row" key={j.id}>
                  <span className="hub-bg-main">
                    <Ellip className="hub-bg-cmd" title={j.command ?? undefined}>
                      {j.command || "—"}
                    </Ellip>
                    <Ellip className="hub-bg-cwd text-faint" title={j.cwd ?? undefined}>
                      {j.cwd || "—"}
                    </Ellip>
                  </span>
                  <span className="hub-bg-st text-faint">
                    {j.running ? t("hubExt.bgPids", { n: j.pids.length }) : t("hubExt.bgExit", { code: j.exitCode ?? "—" })}
                  </span>
                  {j.running ? (
                    <button
                      type="button"
                      className="hub-ibtn"
                      title={t("hubExt.bgCancel")}
                      onClick={() => sendCancelBgJob(sessionId, j.id)}
                    >
                      <Icon name="stopSolid" size={12} />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
