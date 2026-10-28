// Main-column Automations list page (ZCodium AutomationsSection list-view parity):
// page header + status filter pills + task card grid; a card click routes to the
// full-page AutomationEditView (null initial = create). All state is host-authoritative —
// every mutating automations_* RPC replies with a fresh automations_list frame that the
// wsHandler reconciles into the store, so this page never writes list state by hand
// (the enable toggle is the one optimistic flip, matching the old settings page).
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useAppStore, send, toast, openSettings } from "../../../store";
import Icon from "../../../Icon";
import { confirmDialog } from "../../settings/common";
import {
  describeAutomation,
  formatLocalTime,
  type Automation,
} from "../../../lib/automations";
import { AutomationEditView } from "./AutomationEditView";

/** Display status of one card (zcode resolveAutomationStatusKind mapped onto our fields). */
type StatusKind = "active" | "paused" | "completed" | "failed";
type StatusFilter = "all" | "active" | "completed" | "failed";

const STATUS_FILTERS: readonly StatusFilter[] = ["all", "active", "completed", "failed"];
const FILTER_LABELS: Record<StatusFilter, string> = {
  all: "autoList.filterAll",
  active: "autoList.filterActive",
  completed: "autoList.filterCompleted",
  failed: "autoList.filterFailed",
};

/** Card status: failure first (failed lifecycle or a lastError), then terminal, then paused. */
function statusKind(a: Automation): StatusKind {
  if (a.lifecycle === "failed" || a.lastError?.trim()) return "failed";
  if (a.lifecycle === "completed") return "completed";
  if (!a.enabled) return "paused";
  return "active";
}

/** Relative next-run time: ≤30d future → "in 2h" style; beyond → absolute local time. */
const MONTH_MS = 30 * 24 * 3_600_000;
function nextRunLabel(ts: number | undefined, now: number, t: TFunction): string | null {
  if (!ts || ts <= now) return null;
  if (ts - now > MONTH_MS) return formatLocalTime(ts);
  const abs = ts - now;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (abs < min) return t("autoList.relSoon");
  const amount =
    abs < hour ? t("autoList.relMinutes", { n: Math.round(abs / min) })
    : abs < day ? t("autoList.relHours", { n: Math.round(abs / hour) })
    : t("autoList.relDays", { n: Math.round(abs / day) });
  return t("autoList.relIn", { amount });
}

// Card-row ⋯ action menu: global .menu/.mi language, dropping down from the trigger
// (click to toggle, item click acts, click-outside closes — same contract as .sel Pick).
// The wrapper stops propagation so a menu click never lands on the card (edit navigation).
function CardMenu({ a, onAction }: { a: Automation; onAction: (kind: "run" | "edit" | "delete", a: Automation) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node | null)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  const items: { kind: "run" | "edit" | "delete"; icon: string; label: string; danger?: boolean }[] = [
    { kind: "run", icon: "play", label: t("settingsPage.automations.runNowTitle") },
    { kind: "edit", icon: "pencil", label: t("autoList.edit") },
    { kind: "delete", icon: "trash", label: t("common.delete"), danger: true },
  ];
  return (
    <div className="al-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="icon-btn al-more"
        title={t("autoList.moreActions")}
        aria-label={t("autoList.moreActions")}
        onClick={() => setOpen((v) => !v)}
      >
        <span><Icon name="dots" size={15} /></span>
      </button>
      <div className={"menu al-menu-pop" + (open ? " open" : "")}>
        {items.map((it) => (
          <div
            key={it.kind}
            className={"mi" + (it.danger ? " al-danger" : "")}
            data-kind={it.kind}
            onClick={() => {
              setOpen(false);
              onAction(it.kind, a);
            }}
          >
            <span className="al-mi-ic"><Icon name={it.icon} size={13} /></span>
            {it.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AutomationsPage() {
  const { t } = useTranslation();
  const automations = useAppStore((s) => s.automations);
  const [spin, setSpin] = useState(false);
  const [view, setView] = useState<{ mode: "list" } | { mode: "edit"; automation: Automation } | { mode: "create" }>({ mode: "list" });
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Relative-time base: bumped whenever the host list lands / a toggle lands, no interval.
  const [now, setNow] = useState(() => Date.now());
  // Save in flight → return to the list when the reconciling automations_list frame lands.
  const closeOnNextList = useRef(false);

  // Data refresh on page open (automations_list reply lands via the wsHandler table).
  useEffect(() => {
    send({ type: "automations_list" });
  }, []);

  // Deep link from an automation-delivered turn (store.openAutomationEditor): land on that
  // task's editor. The list may not have landed yet, so this retries on every frame; an id
  // missing from a non-empty list is gone for good and is dropped instead of sticking.
  const editId = useAppStore((s) => s.automationEditId);
  useEffect(() => {
    if (!editId || automations.length === 0) return;
    const target = automations.find((a) => a.id === editId);
    useAppStore.setState({ automationEditId: null });
    if (target) setView({ mode: "edit", automation: target });
  }, [editId, automations]);

  useEffect(() => {
    if (!closeOnNextList.current) return;
    closeOnNextList.current = false;
    setView({ mode: "list" });
    toast(t("settingsPage.automations.savedToast"));
  }, [automations, t]);

  // Optimistic enable flip; the host's fresh automations_list reconciles any divergence.
  function flipEnabled(a: Automation) {
    const next = !a.enabled;
    useAppStore.setState((s) => ({ automations: s.automations.map((x) => (x.id === a.id ? { ...x, enabled: next } : x)) }));
    send({ type: "automations_toggle", id: a.id, enabled: next });
  }

  function onToggle(a: Automation, e: ReactMouseEvent) {
    e.stopPropagation();
    flipEnabled(a);
  }

  function onRefresh() {
    setNow(Date.now());
    setSpin(true);
    send({ type: "automations_list" });
    setTimeout(() => setSpin(false), 500);
  }

  function onMenuAction(kind: "run" | "edit" | "delete", a: Automation) {
    if (kind === "run") send({ type: "automations_run_now", id: a.id });
    else if (kind === "edit") setView({ mode: "edit", automation: a });
    else void onDelete(a);
  }

  async function onDelete(a: Automation) {
    if (
      await confirmDialog({
        title: t("settingsPage.automations.deleteTitle"),
        message: t("settingsPage.automations.deleteMsg", { name: a.title }),
        confirmText: t("common.delete"),
        danger: true,
      })
    ) {
      setView((v) => (v.mode === "edit" && v.automation.id === a.id ? { mode: "list" } : v));
      send({ type: "automations_delete", id: a.id });
    }
  }

  const visible = useMemo(
    () => (statusFilter === "all" ? automations : automations.filter((a) => statusKind(a) === statusFilter)),
    [automations, statusFilter],
  );

  if (view.mode !== "list") {
    // Edit view holds the live row when the list refreshes underneath it (host may rewrite
    // fields on every reconcile); fall back to the captured object if the row vanished.
    const initial =
      view.mode === "create"
        ? null
        : automations.find((a) => a.id === view.automation.id) ?? view.automation;
    return (
      <div className="al-page">
        <div className="al-col">
          <div className="al-edit-card">
            <AutomationEditView
              key={view.mode === "create" ? "__new" : view.automation.id}
              initial={initial}
              onBack={() => setView({ mode: "list" })}
              onSaved={() => {
                closeOnNextList.current = true;
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="al-page">
      <div className="al-col">
      <div className="al-head">
        <h1 className="al-title">{t("autoList.title")}</h1>
        <button type="button" className={"icon-btn pg-refresh" + (spin ? " spin" : "")} title={t("settingsPage.model.refresh")} onClick={onRefresh}>
          <Icon name="refresh" size={17} />
        </button>
        {/* Automations settings page (pg-automations): the agent-tools switch lives there,
            not on the task cards — it decides whether new sessions get the automation tools */}
        <button type="button" className="icon-btn" title={t("autoList.settingsTitle")} onClick={() => openSettings("pg-automations")}>
          <Icon name="settings" size={17} />
        </button>
        <button type="button" className="frm-primary" onClick={() => setView({ mode: "create" })}>{t("autoEdit.createBtn")}</button>
      </div>

      {automations.length > 0 && (
        <div className="al-filters">
          {STATUS_FILTERS.map((f) => (
            <button key={f} type="button" className={"al-pill" + (statusFilter === f ? " on" : "")} aria-pressed={statusFilter === f}
              onClick={() => setStatusFilter(f)}>
              {t(FILTER_LABELS[f])}
            </button>
          ))}
        </div>
      )}

      {automations.length === 0 ? (
        <div className="al-none">{t("autoList.emptyTitle")}</div>
      ) : visible.length === 0 ? (
        <div className="al-filter-empty">{t("autoList.filterEmpty")}</div>
      ) : (
        <div className="al-grid">
          {visible.map((a) => {
            const status = statusKind(a);
            const failed = status === "failed";
            const scheduleText = describeAutomation(a, t);
            const next = nextRunLabel(a.nextRunAt, now, t);
            // One bottom-left badge per card: active = green "schedule · next run",
            // paused/completed = the neutral gray pair, failed = red "failed · schedule".
            const badgeText =
              failed ? `${t("autoList.failedBadge")} · ${scheduleText}`
              : status === "completed" ? `${t("settingsPage.automations.statusCompleted")} · ${scheduleText}`
              : status === "paused" ? `${t("autoList.pausedBadge")} · ${scheduleText}`
              : next ? `${scheduleText} · ${t("autoList.cardNext", { time: next })}`
              : scheduleText;
            return (
              <div key={a.id} className={"al-card" + (status === "completed" ? " done" : "")} role="button" tabIndex={0}
                onClick={() => setView({ mode: "edit", automation: a })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setView({ mode: "edit", automation: a });
                  }
                }}
              >
                <div className="al-card-main">
                  <div className="al-card-head">
                    <b className="al-card-title" title={a.title}>{a.title}</b>
                  </div>
                  <p className="al-card-prompt">{a.prompt.replace(/\s+/g, " ").trim() || " "}</p>
                  <div className="al-card-meta">
                    <span className={"al-badge" + (failed ? " err" : status !== "active" ? " gray" : "")}
                      title={failed ? a.lastError ?? undefined : a.nextRunAt ? formatLocalTime(a.nextRunAt) : undefined}>
                      {status === "active" && !failed && <Icon name="clock" size={13} />}
                      <span className="al-badge-tx">{badgeText}</span>
                    </span>
                    {a.deliverTo && <span className="al-delivery">{t("autoList.deliveryBadge")}</span>}
                    <span className="al-runcount">{t("autoList.runCount", { n: a.runCount })}</span>
                  </div>
                </div>
                <div className="al-card-ctl">
                  <CardMenu a={a} onAction={onMenuAction} />
                  <div className={"tg" + (a.enabled ? " on" : "")}
                    title={a.enabled ? t("settingsPage.shared.enabledTip") : t("settingsPage.shared.disabledTip")}
                    onClick={(e) => onToggle(a, e)}>
                    <i />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}
