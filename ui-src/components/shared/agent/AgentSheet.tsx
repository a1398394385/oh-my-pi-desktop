// Agent sheet: the deck inspector, ported 1:1 from omp-studio's AgentInspector (credential
// crumb, status/model line, action row, current stage, task with expand, usage tiles, output,
// child chips). Used by the right sidebar for both entries: the Agent Hub's selection and the
// subagent tab's card click.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, fmtTokens, loadSessionInBackground } from "../../../store";
import { bgJobsKey } from "../../../store/session";
import { sendSubagentControl, sendGetBgJobs, sendCancelBgJob } from "./hubExt";
import { expandRightPanel } from "../../main/right/tabs";
import { modelShort, subStatus, currentProgress, stInfo, tokenTotal, clockHMS, type SegT } from "./subShared";
import { AgentFace } from "./AgentFace";
import { openSubagentSession } from "./subRoster";
import Icon from "../../../Icon";
import type { SubagentState } from "../../../types/session";

const TASK_CLAMP = 220;

export default function AgentSheet({
  sub,
  subagentId,
  sessionId,
  onClose,
}: {
  sub: SubagentState;
  subagentId: string;
  sessionId?: string;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  const [taskOpen, setTaskOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  // Content tab (overview / background tasks / messages). Studio's transcript tab is
  // deliberately absent: the transcript has its own right-panel page (avatar click).
  const [tab, setTab] = useState<"ov" | "tasks" | "msgs">("ov");
  useEffect(() => {
    setTab("ov");
    setTaskOpen(false);
    setResultOpen(false);
  }, [subagentId]);
  const st = subStatus(sub);
  const group = stInfo(st).group;
  const u = sub.usage;
  const name = sub.name ?? sub.agent;
  const streaming = sub.streaming;
  const elapsed = streaming && sub.registeredAt ? Date.now() - sub.registeredAt : (u?.durationMs ?? 0);
  const tokens = tokenTotal(u?.tokens);
  const ctx = u?.contextWindow ? Math.min(1, (u.contextTokens ?? 0) / u.contextWindow) : undefined;
  const task = sub.description || sub.task || sub.text || "";
  const clamped = !taskOpen && task.length > TASK_CLAMP;
  const stage = currentProgress(sub);
  const short = modelShort(u?.resolvedModel);
  const cut = short.lastIndexOf(":");
  const model = cut > 0 ? short.slice(0, cut) : short;
  const thinkRaw = u?.resolvedThinkingLevel ?? (cut > 0 ? short.slice(cut + 1) : "");
  const think = thinkRaw ? t(`composer.thinkingLevels.${thinkRaw}`, { defaultValue: thinkRaw }) : "";
  const role = u?.modelRole?.toUpperCase();
  // Read the roster without subscribing: a selector that builds a fresh array on every call
  // would re-render forever (Object.is never matches). The sheet re-renders on the parent's
  // state anyway, and child rows only change when the roster does.
  const sess = useAppStore.getState().openSessions.get(useAppStore.getState().activePath ?? "");
  const children: Array<[string, SubagentState]> = sess
    ? [...sess.subagents].filter(([id, x]) => id !== subagentId && (x.parent === name || x.parent === subagentId))
    : [];
  const result = sub.result?.trim();
  const tiles: Array<[string, string]> = [
    [t("right.adSheetRuntime"), elapsed > 0 ? clockHMS(elapsed) : "—"],
    [t("right.hubStatTokens"), tokens === undefined ? "—" : fmtTokens(tokens)],
    [t("right.hubTilesRequests"), String(u?.requests ?? 0)],
    [t("right.hubStatTools"), String(u?.toolCount ?? sub.tools.length)],
    [t("right.hubStatCost"), u?.cost ? `$${u.cost.toFixed(2)}` : "—"],
    [t("right.hubStatRate"), streaming && elapsed > 0 && tokens ? `${Math.round(tokens / (elapsed / 1000))} t/s` : "—"],
  ];

  return (
    <div className="ad-ins">
      <header className="ad-ins-head">
        <button
          type="button"
          className="ad-avatar"
          aria-label={t("right.adSheetOpenChat")}
          title={t("right.adSheetOpenChat")}
          onClick={() => {
            // A persisted child transcript opens read-only in the right panel (the middle
            // column keeps the active session); without one there is nothing to read.
            if (sub.sessionFile) {
              loadSessionInBackground(sub.sessionFile);
              expandRightPanel("submsg", { subagentView: sub.sessionFile });
            } else {
              openSubagentSession(subagentId, sub);
            }
          }}
        >
          {/* Same face as the roster row, color-keyed by the same id. */}
          <AgentFace className="ad-avatar-face" avatarIndex={undefined} name={subagentId} status={group} />
        </button>
        <div className="ad-ins-id">
          <div className="ad-ins-row">
            <span className="ad-status" data-tone={group}>
              <i aria-hidden="true" />
            </span>
            <h3 title={name}>{name}</h3>
            {onClose ? (
              <button type="button" className="hub-ibtn ad-ins-close" aria-label={t("right.adSheetClose")} title={t("right.adSheetClose")} onClick={onClose}>
                <Icon name="xmark" size={13} />
              </button>
            ) : null}
          </div>
          <div className="ad-ins-row">
            <div className="ad-ins-sub">
              {role || model || think ? (
                <span className="hub-model" title={u?.resolvedModel ?? undefined}>
                  {role ? <span className="hub-role">{role}</span> : null}
                  {role && (model || think) ? <span className="hub-sep"> · </span> : null}
                  {model || think ? (
                    <span className="hub-mdl">
                      {model}
                      {model && think ? " " : null}
                      {think ? <span className="hub-think">{think}</span> : null}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            {streaming && sessionId ? (
              <button
                type="button"
                className="btn small danger icon-only"
                aria-label={t("right.adSheetStop")}
                title={t("right.adSheetStop")}
                onClick={() => sendSubagentControl(sessionId, subagentId, "cancel")}
              >
                <Icon name="stopSolid" size={12} />
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="ad-tabs-strip" role="tablist">
        {([
          ["ov", t("right.adTabOverview"), "stats"],
          ["tasks", t("right.adTabTasks"), "term"],
          ["msgs", t("right.adTabMsgs"), "comment"],
        ] as const).map(([id, label, ic]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={"ad-strip-tab" + (tab === id ? " active" : "")}
            onClick={() => setTab(id)}
          >
            <span className="ad-strip-lab">
              <Icon name={ic} size={12} />
              {label}
            </span>
          </button>
        ))}
      </div>

      {tab === "tasks" ? (
        <AgentTasks sessionId={sessionId} subagentId={subagentId} />
      ) : tab === "msgs" ? (
        <div className="ad-tab-soon">{t("right.adTabSoon")}</div>
      ) : (
        <>
      <section className="ad-ins-section">
        <h4>{t("right.adSheetStage")}</h4>
        <div className="ad-ins-now" data-running={streaming ? "true" : undefined}>
          <Icon name={group === "failed" ? "info" : "clock"} size={12} />
          <span>{stage || t("right.adSheetNoStage")}</span>
        </div>
        {u?.completionPercent !== undefined ? (
          <div className="ad-ins-progress">
            <span className="ad-ins-bar">
              <i style={{ inlineSize: `${Math.max(0, Math.min(100, u.completionPercent)).toFixed(1)}%` }} />
            </span>
            <span className="ad-ins-pct">{Math.round(u.completionPercent)}%</span>
          </div>
        ) : null}
      </section>

      {task ? (
        <section className="ad-ins-section">
          <h4>{t("right.hubTask")}</h4>
          <p className="ad-ins-task" data-clamped={clamped ? "true" : undefined}>
            {task}
          </p>
          {task.length > TASK_CLAMP ? (
            <button type="button" className="ad-link" onClick={() => setTaskOpen((v) => !v)}>
              {taskOpen ? t("right.adSheetCollapse") : t("right.adSheetExpand")}
            </button>
          ) : null}
        </section>
      ) : null}

      <section className="ad-ins-section">
        <h4>{t("right.hubUsageT")}</h4>
        <dl className="ad-ins-tiles">
          {tiles.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
        {ctx !== undefined ? (
          <div className="ad-ins-context" data-high={ctx > 0.8 ? "true" : undefined}>
            <span>{t("right.hubTilesContext")}</span>
            <span className="ad-ins-bar">
              <i style={{ inlineSize: `${(ctx * 100).toFixed(1)}%` }} />
            </span>
            <span>
              {fmtTokens(u?.contextTokens ?? 0)} / {fmtTokens(u?.contextWindow ?? 0)}
            </span>
          </div>
        ) : null}
      </section>

      {result ? (
        <section className="ad-ins-section">
          <h4>{t("right.hubResult")}</h4>
          <p className="ad-ins-result" data-clamped={!resultOpen && result.length > TASK_CLAMP ? "true" : undefined}>
            {result}
          </p>
          {result.length > TASK_CLAMP ? (
            <button type="button" className="ad-link" onClick={() => setResultOpen((v) => !v)}>
              {resultOpen ? t("right.adSheetCollapse") : t("right.adSheetExpand")}
            </button>
          ) : null}
        </section>
      ) : null}

      {children.length ? (
        <section className="ad-ins-section">
          <h4>
            {t("right.adSheetChildren")}
            <span>{children.length}</span>
          </h4>
          <div className="ad-ins-children">
            {children.map(([id, child]) => (
              <button key={id} type="button" className="ad-chip-agent" onClick={() => useAppStore.getState().setHubSel(id)}>
                <span>{child.name ?? child.agent}</span>
                <i className="ad-dot" data-tone={stInfo(subStatus(child)).group} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      ) : null}
        </>
      )}
    </div>
  );
}

// Background tasks of one child agent: the host keeps a per-(session, subagent) snapshot
// (18.5 get_bg_jobs), so the tab only renders that slice; cancel reuses the same channel.
function AgentTasks({ sessionId, subagentId }: { sessionId?: string; subagentId: string }) {
  const { t } = useTranslation();
  const jobs = useAppStore((st) => (sessionId ? st.bgJobs.get(bgJobsKey(sessionId, subagentId)) : undefined));
  useEffect(() => {
    if (sessionId) sendGetBgJobs(sessionId, subagentId);
  }, [sessionId, subagentId]);
  if (!jobs || jobs.length === 0) return <div className="ad-tab-soon">{t("right.adTabTasksEmpty")}</div>;
  return (
    <div className="ad-tasks">
      {jobs.map((j) => (
        <div key={j.id} className="ad-task">
          <span className="ad-task-status" data-s={j.status}>
            {j.status === "running"
              ? t("right.subStRunning")
              : j.status === "completed"
                ? t("right.subStCompleted")
                : j.status === "cancelled"
                  ? t("right.adTaskCancelled")
                  : t("right.subStFailed")}
          </span>
          <span className="ad-task-text" title={j.command ?? undefined}>
            {j.caption ?? j.intent ?? j.label ?? j.command ?? j.id}
          </span>
          {j.running && sessionId ? (
            <button
              type="button"
              className="hub-ibtn"
              aria-label={t("right.adSheetStop")}
              title={t("right.adSheetStop")}
              onClick={() => sendCancelBgJob(sessionId, j.id, subagentId)}
            >
              <Icon name="stopSolid" size={12} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export type { SegT, SubagentState };
