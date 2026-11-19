// Swarm summary: what the sidebar shows when no agent is selected — the deck's donut by status,
// three aggregate tiles, token share per model and the three heaviest agents. Clicking a row
// selects that agent (the sheet replaces this view).
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, fmtTokens } from "../../../store";
import { buildRows, type RosterSession } from "./subRoster";
import { stInfo, stKeyOf, stLabel, tokenTotal, modelShort } from "./subShared";

// Status groups in display order — the summary legend and the donut both walk this list.
// "waiting" is a preview-only tone in the deck; the roster's own vocabulary has no such group,
// so the colour slot stays in the CSS while the list skips it.
const GROUP_ORDER = ["running", "completed", "failed", "aborted"] as const;

export default function AgentSummary({ s }: { s: RosterSession }) {
  const { t } = useTranslation();
  const sig = [...s.subagents].map(([id, x]) => `${id}:${x.status}:${x.streaming ? 1 : 0}:${x.name ?? ""}`).join(";");
  const data = useMemo(() => {
    const rows = buildRows([...s.subagents]);
    const children = rows.filter((r) => !r.sub.parent || r.sub.parent === "main").length || rows.length;
    const groups = GROUP_ORDER.map((g) => [g, rows.filter((r) => stInfo(stKeyOf(subStatusOf(r.sub))).group === g).length] as const);
    let tokens = 0;
    let cost = 0;
    let running = 0;
    const byModel = new Map<string, number>();
    for (const { sub } of rows) {
      const tok = tokenTotal(sub.usage?.tokens) ?? 0;
      tokens += tok;
      cost += sub.usage?.cost ?? 0;
      if (sub.streaming) running++;
      if (tok > 0) {
        const key = modelShort(sub.usage?.resolvedModel) || "—";
        byModel.set(key, (byModel.get(key) ?? 0) + tok);
      }
    }
    const models = [...byModel].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const top = rows
      .map((r) => [r.id, r.sub, tokenTotal(r.sub.usage?.tokens) ?? 0] as const)
      .filter(([, , tok]) => tok > 0)
      .sort((a, b) => b[2] - a[2])
      .slice(0, 3);
    return { rows, children, groups, tokens, cost, running, models, top };
  }, [sig]);
  const maxModel = Math.max(1, ...data.models.map(([, v]) => v));
  let offset = 0;

  return (
    <div className="ad-summary">
      <header>
        <h3>{t("right.adSummaryTitle")}</h3>
        <p>{t("right.adSummaryHint")}</p>
      </header>
      <div className="ad-summary-donut">
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle className="ad-donut-track" cx="32" cy="32" r="26" />
          {data.groups.map(([group, count]) => {
            const share = count / Math.max(1, data.children);
            const seg =
              share > 0 ? (
                <circle
                  key={group}
                  className="ad-donut-seg"
                  data-group={group}
                  cx="32"
                  cy="32"
                  r="26"
                  pathLength={100}
                  strokeDasharray={`${Math.max(0, share * 100 - 1.5).toFixed(2)} 100`}
                  strokeDashoffset={(-offset * 100).toFixed(2)}
                />
              ) : null;
            offset += share;
            return seg;
          })}
        </svg>
        <div className="ad-donut-center">
          <strong>{data.children}</strong>
          <span>{t("right.adSummaryChildren")}</span>
        </div>
        <ul>
          {data.groups.map(([group, count]) => (
            <li key={group} data-group={group}>
              <i aria-hidden="true" />
              {stLabel(group, t)}
              <span>{count}</span>
            </li>
          ))}
        </ul>
      </div>
      <dl className="ad-ins-tiles is-summary">
        <div>
          <dt>{t("right.hubStatTokens")}</dt>
          <dd>{fmtTokens(data.tokens)}</dd>
        </div>
        <div>
          <dt>{t("right.hubStatCost")}</dt>
          <dd>${data.cost.toFixed(2)}</dd>
        </div>
        <div>
          <dt>{t("right.adSummaryRunning")}</dt>
          <dd>{data.running}</dd>
        </div>
      </dl>
      {data.models.length ? (
        <section className="ad-ins-section">
          <h4>{t("right.adSummaryByModel")}</h4>
          <ul className="ad-bars">
            {data.models.map(([model, tokens]) => (
              <li key={model}>
                <span className="ad-bars-label" title={model}>
                  {model}
                </span>
                <span className="ad-bars-track">
                  <i style={{ inlineSize: `${((tokens / maxModel) * 100).toFixed(1)}%` }} />
                </span>
                <span className="ad-bars-value">{fmtTokens(tokens)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.top.length ? (
        <section className="ad-ins-section">
          <h4>{t("right.adSummaryTop")}</h4>
          <div className="ad-ins-children is-list">
            {data.top.map(([id, sub, tokens]) => (
              <button key={id} type="button" className="ad-chip-agent" onClick={() => useAppStore.getState().setHubSel(id)}>
                <span>{sub.name ?? sub.agent}</span>
                <em>{fmtTokens(tokens)}</em>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function subStatusOf(sub: { status: string; streaming: boolean }): string {
  return sub.streaming ? "running" : sub.status;
}
