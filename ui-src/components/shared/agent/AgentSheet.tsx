// Agent sheet: the deck inspector, ported 1:1 from omp-studio's AgentInspector (credential
// crumb, status/model line, action row, current stage, task with expand, usage tiles, output,
// child chips). Used by the right sidebar for both entries: the Agent Hub's selection and the
// subagent tab's card click.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, fmtTokens, fmtDurationMs } from "../../../store";
import { sendSubagentControl } from "./hubExt";
import { modelShort, subStatus, currentProgress, stInfo, stKeyOf, stLabel, tokenTotal, type SegT } from "./subShared";
import { openSubagentSession } from "./subRoster";
import Icon from "../../../Icon";
import type { SubagentState } from "../../../types/session";

const TASK_CLAMP = 220;

function clockOf(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

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
  const st = subStatus(sub);
  const group = stInfo(st).group;
  const u = sub.usage;
  const name = sub.name ?? sub.agent;
  const parent = sub.parent ?? "main";
  const streaming = sub.streaming;
  const elapsed = streaming && sub.registeredAt ? Date.now() - sub.registeredAt : (u?.durationMs ?? 0);
  const tokens = tokenTotal(u?.tokens);
  const ctx = u?.contextWindow ? Math.min(1, (u.contextTokens ?? 0) / u.contextWindow) : undefined;
  const task = sub.description || sub.task || sub.text || "";
  const clamped = !taskOpen && task.length > TASK_CLAMP;
  const stage = currentProgress(sub);
  const model = modelShort(u?.resolvedModel);
  // Read the roster without subscribing: a selector that builds a fresh array on every call
  // would re-render forever (Object.is never matches). The sheet re-renders on the parent's
  // state anyway, and child rows only change when the roster does.
  const sess = useAppStore.getState().openSessions.get(useAppStore.getState().activePath ?? "");
  const children: Array<[string, SubagentState]> = sess
    ? [...sess.subagents].filter(([id, x]) => id !== subagentId && (x.parent === name || x.parent === subagentId))
    : [];
  const tiles: Array<[string, string]> = [
    [t("right.adSheetRuntime"), elapsed > 0 ? clockOf(elapsed) : "—"],
    [t("right.hubStatTokens"), tokens === undefined ? "—" : fmtTokens(tokens)],
    [t("right.hubTilesRequests"), String(u?.requests ?? 0)],
    [t("right.hubStatTools"), String(u?.toolCount ?? sub.tools.length)],
    [t("right.hubStatCost"), u?.cost ? `$${u.cost.toFixed(2)}` : "—"],
    [t("right.hubStatRate"), streaming && elapsed > 0 && tokens ? `${Math.round(tokens / (elapsed / 1000))} t/s` : "—"],
  ];
  const facts: Array<[string, string]> = [];
  if (sub.sessionFile) facts.push([t("right.adSheetOutput"), sub.sessionFile]);

  return (
    <div className="ad-ins">
      <header className="ad-ins-head">
        <div>
          <button type="button" className="ad-ins-crumb" onClick={() => useAppStore.getState().setHubSel(parent)}>
            <Icon name="arrowUp" size={11} />
            {parent}
          </button>
          <h3 title={name}>{name}</h3>
          <div className="ad-ins-sub">
            <span className="ad-status" data-tone={group}>
              <i aria-hidden="true" />
              <span>{stLabel(stKeyOf(st), t)}</span>
            </span>
            {model ? (
              <span className="ad-ins-model" title={u?.resolvedModel ?? undefined}>
                {model}
                {u?.modelRole ? <em>{u.modelRole}</em> : null}
              </span>
            ) : null}
          </div>
        </div>
        {onClose ? (
          <button type="button" className="hub-ibtn ad-ins-close" aria-label={t("right.adSheetClose")} title={t("right.adSheetClose")} onClick={onClose}>
            <Icon name="chevronLeft" size={13} />
          </button>
        ) : null}
      </header>

      <div className="ad-ins-actions">
        <button type="button" className="btn small primary" onClick={() => openSubagentSession(subagentId, sub)}>
          <Icon name="comment" size={12} />
          {t("right.adSheetOpenChat")}
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            const st0 = useAppStore.getState();
            st0.openHub();
            st0.setHubSel(subagentId);
          }}
        >
          <Icon name="externalOpen" size={12} />
          Agent Hub
        </button>
        {streaming && sessionId ? (
          <button type="button" className="btn small danger" onClick={() => sendSubagentControl(sessionId, subagentId, "cancel")}>
            <Icon name="stopSolid" size={12} />
            {t("right.adSheetStop")}
          </button>
        ) : null}
      </div>

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

      {facts.length ? (
        <section className="ad-ins-section">
          <h4>{t("right.adSheetOutputTitle")}</h4>
          <dl className="ad-ins-facts">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <code title={value}>{value}</code>
                </dd>
              </div>
            ))}
          </dl>
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
    </div>
  );
}

export type { SegT, SubagentState };
