// Automation this turn created, rendered as the automations list card pulled into the chat
// column: a long bar above the run's change card that names the task and its state. It replaces
// the bare clock icon that used to sit in the acts row (one click, no context). The prompt line
// stays out — the card is a pointer into the task, not a copy of its content.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../store";
import Icon from "../../Icon";
import { automationStatusKind, describeAutomation, formatLocalTime } from "../../lib/automations";

export default function AutomationCard({ id, title }: { id: string; title: string }) {
  const { t } = useTranslation();
  // The agent-side tool pushes no automations_list frame, so a task created in this session can
  // be missing from the store until something asks for the list; one fetch per mount fixes it
  // (the reply lands in the same store the automations page reads).
  const a = useAppStore((s) => s.automations.find((x) => x.id === id));
  useEffect(() => {
    if (!a) send({ type: "automations_list" });
  }, [a]);

  const kind = a ? automationStatusKind(a) : null;
  // Same badge composition as the list card, except the next run reads as an absolute time:
  // the chat copy has no relative-time ticker.
  const schedule = a ? describeAutomation(a, t) : "";
  const badgeText =
    kind === "failed" ? `${t("autoList.failedBadge")} · ${schedule}`
    : kind === "completed" ? `${t("settingsPage.automations.statusCompleted")} · ${schedule}`
    : kind === "paused" ? `${t("autoList.pausedBadge")} · ${schedule}`
    : a?.nextRunAt ? `${schedule} · ${t("autoList.cardNext", { time: formatLocalTime(a.nextRunAt) })}`
    : schedule;

  return (
    <div className={"al-card chg-auto" + (kind === "completed" ? " done" : "")} role="button" tabIndex={0}
      onClick={() => useAppStore.getState().openAutomationEditor(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          useAppStore.getState().openAutomationEditor(id);
        }
      }}
    >
      <div className="al-card-main">
        <div className="al-card-head">
          <b className="al-card-title" title={a?.title ?? title}>{a?.title ?? title}</b>
        </div>
        {a && (
          <div className="al-card-meta">
            <span className={"al-badge" + (kind === "failed" ? " err" : kind !== "active" ? " gray" : "")}
              title={a.lastError ?? undefined}>
              {kind === "active" && <Icon name="clock" size={13} />}
              <span className="al-badge-tx">{badgeText}</span>
            </span>
            {a.deliverTo && <span className="al-delivery">{t("autoList.deliveryBadge")}</span>}
            <span className="al-runcount">{t("autoList.runCount", { n: a.runCount })}</span>
          </div>
        )}
      </div>
    </div>
  );
}
