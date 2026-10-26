// Main-column automation editor (replicates ZCodium's AutomationEditView structure on our
// data layer): header with back + title + actions, Settings/History pill tabs, label-over-field
// form (status chip → title → schedule bar → prompt + project/model toolbar → end conditions
// → next-run preview), and a history tab with the zcode run table (status dot, duration,
// client-side paging). State model and wire RPCs are the old settings-page editor's
// (AutomationPage.tsx), lifted into shared.tsx: the host reconciles every mutation with a
// fresh automations_list frame; save closes via the parent's onSaved latch.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, openSessionByPath, pathBase, fmtDurationMs } from "../../../store";
import Icon from "../../../Icon";
import {
  describeSchedule,
  describeCronExpr,
  formatLocalTime,
  isPlausibleCronExpr,
  endDateToMs,
  msToEndDate,
  type Automation,
  type AutomationRun,
  type AutomationUnit,
  type ScheduleRule,
} from "../../../lib/automations";
import { Pick, blankDraft, buildScheduleInput, clampInt, draftOf, type Draft } from "./shared";
import { EnabledModelPicker } from "../../ModelPicker";

/** Runs per history page (zcode RUNS_PAGE_SIZE parity). */
const RUNS_PAGE_SIZE = 8;

/** Page-number set for the history pager: all pages when few, otherwise a windowed
 *  first/last/current±1 set with "…" gaps (zcode buildRunsPageItems semantics). */
function runsPageItems(cur: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total]);
  for (const p of [cur - 1, cur, cur + 1]) if (p >= 1 && p <= total) pages.add(p);
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | "ellipsis")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("ellipsis");
    out.push(p);
  });
  return out;
}

/** Full-page automation editor. `initial` = null for create; drafts are captured at mount
 *  (mount with key={id} like the old editor — background list refreshes must not clobber
 *  in-progress edits). */
export function AutomationEditView({ initial, onBack, onSaved }: {
  initial: Automation | null;
  onBack: () => void;
  onSaved: () => void; // parent's close-on-next-automations_list latch (save close + toast)
}) {
  const { t } = useTranslation();
  const isNew = !initial;
  const [tab, setTab] = useState<"settings" | "history">("settings");
  const [runsPage, setRunsPage] = useState(1);
  const [draft, setDraft] = useState<Draft>(() => {
    if (initial) return draftOf(initial);
    const d = blankDraft();
    // Create form preselects the default project (then the first registered one).
    const st = useAppStore.getState();
    d.cwd = st.defaultWorkspace || st.allProjects.find((c) => !st.removedProjects.includes(c)) || "";
    return d;
  });
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  const modelNames = useAppStore((s) => s.modelNames);
  const automationPreview = useAppStore((s) => s.automationPreview);
  // Live row for the status chip / menu gating (optimistic toggles reconcile through it);
  // find returns the stored object reference, so this is a selector-safe read.
  const live = useAppStore((s) => (initial ? s.automations.find((x) => x.id === initial.id) : undefined));
  const shown = live ?? initial;

  // Project options: registered projects minus removed ones; the edited automation's own cwd
  // always stays selectable even when it is not registered. No projects at all → free-text input.
  // The default-workspace sentinel dir renders as the localized "Default project" (list parity).
  const projectLabel = (cwd: string) => {
    const base = pathBase(cwd);
    return base === ".omp-default" ? t("misc.defaultProject") : base;
  };
  const projectOptions = useMemo(() => {
    const list = allProjects.filter((c) => !removedProjects.includes(c)).map((c) => ({ id: c, label: projectLabel(c) }));
    if (draft.cwd && !list.some((o) => o.id === draft.cwd)) list.push({ id: draft.cwd, label: projectLabel(draft.cwd) });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProjects, removedProjects, draft.cwd]);

  // Model selector: EnabledModelPicker below (same pool as the composer model menu).

  const scheduleInput = useMemo(() => buildScheduleInput(draft), [draft]);
  const cronBad = draft.schedKind === "cron" && draft.cronExpr.trim() !== "" && !isPlausibleCronExpr(draft.cronExpr);
  const endAt = draft.endMode === "date" ? endDateToMs(draft.endDate) : null;
  const endBad = draft.endMode === "date" && endAt === null;
  const canSave =
    draft.title.trim() !== "" && draft.prompt.trim() !== "" && draft.cwd.trim() !== "" && !!scheduleInput && !cronBad && !endBad;

  // Live next-run preview: debounced automations_preview; the reply is only trusted while its
  // request signature is still the current one (in-order replies make this staleness-proof).
  const sig = scheduleInput ? JSON.stringify(scheduleInput) : "";
  const [sentSig, setSentSig] = useState<string | null>(null);
  useEffect(() => {
    if (!scheduleInput) return undefined;
    const timer = setTimeout(() => {
      setSentSig(sig);
      send({ type: "automations_preview", schedule: scheduleInput });
    }, 300);
    return () => clearTimeout(timer);
  }, [sig, scheduleInput]);
  const previewTimes = scheduleInput && sentSig === sig && automationPreview ? automationPreview : null;

  // In-bar schedule summary (zcode schedulePreview): human sentence for rules, raw expr for cron.
  const schedSummary = useMemo(() => {
    if (!scheduleInput) return "";
    if (scheduleInput.kind === "cron") return describeCronExpr(scheduleInput.cronExpr);
    // anchorAt is creation bookkeeping the describer never reads; the persisted anchor (or
    // "now" for a fresh draft) only satisfies the ScheduleRule shape. minute/hourly rules
    // carry no time-of-day on the wire — fill the required fields with 0 (never read).
    const rule: ScheduleRule = {
      unit: scheduleInput.unit,
      interval: scheduleInput.interval,
      hour: scheduleInput.hour ?? 0,
      minute: scheduleInput.minute ?? 0,
      weekdays: scheduleInput.weekdays,
      monthDays: scheduleInput.monthDays,
      anchorAt: initial?.scheduleRule?.anchorAt ?? Date.now(),
    };
    return describeSchedule(rule, t);
  }, [scheduleInput, initial, t]);

  function save() {
    if (!canSave || !scheduleInput) return;
    onSaved();
    const base = {
      title: draft.title.trim(),
      prompt: draft.prompt,
      cwd: draft.cwd.trim(),
      model: draft.model || null,
      computer: draft.computer,
      recurring: draft.endMode !== "count",
      maxRuns: draft.endMode === "count" ? clampInt(draft.maxRuns, 1, 100000, 1) : null,
      endAt: draft.endMode === "date" ? endAt : null,
    };
    if (isNew) {
      send({ type: "automations_create", automation: { ...base, schedule: scheduleInput } });
      return;
    }
    // Update: omit the schedule and end-shape fields when nothing about them changed — the host
    // recomputes nextRunAt (re-aims the phase) whenever any of them is present in the patch.
    const a = initial!;
    const sameSchedule = JSON.stringify(buildScheduleInput(draftOf(a))) === JSON.stringify(scheduleInput);
    const sameEnd = a.recurring === base.recurring && (a.maxRuns ?? null) === base.maxRuns && (a.endAt ?? null) === base.endAt;
    send({
      type: "automations_update",
      id: a.id,
      ...base,
      ...(sameSchedule ? {} : { schedule: scheduleInput }),
      ...(sameSchedule && sameEnd ? { recurring: undefined, maxRuns: undefined, endAt: undefined } : {}),
    });
  }

  // History tab: runs ride the automations_list snapshot; poll lightly while visible so
  // finished runs show up without manual refresh (zcode 5s onLoadRuns parity).
  const runs: AutomationRun[] = useAppStore((s) => (initial ? s.automationRuns[initial.id] : undefined)) ?? [];
  useEffect(() => {
    if (tab !== "history" || isNew) return undefined;
    send({ type: "automations_list" });
    const timer = setInterval(() => send({ type: "automations_list" }), 5000);
    return () => clearInterval(timer);
  }, [tab, isNew]);

  // Client-side history paging; the page clamps when rows shrink.
  const runsTotalPages = Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE));
  const runsCurrentPage = Math.min(runsPage, runsTotalPages);
  const pagedRuns = runs.slice((runsCurrentPage - 1) * RUNS_PAGE_SIZE, runsCurrentPage * RUNS_PAGE_SIZE);

  // Status chip kind: lastError wins, then terminal lifecycle, then enabled state.
  const stKind = !shown
    ? null
    : shown.lastError || shown.lifecycle === "failed"
      ? "failed"
      : shown.lifecycle === "completed"
        ? "completed"
        : shown.enabled
          ? "active"
          : "paused";
  const stLabel =
    stKind === "failed"
      ? t("settingsPage.automations.status_failed")
      : stKind === "completed"
        ? t("settingsPage.automations.statusCompleted")
        : stKind === "paused"
          ? t("autoEdit.lifecyclePaused")
          : t("autoEdit.lifecycleActive");

  const summaryTitle = draft.title.trim() || t("autoEdit.untitled");
  const summaryPrompt = draft.prompt.replace(/\s+/g, " ").trim() || t("settingsPage.automations.promptPlaceholder");
  const summaryNextRun = previewTimes
    ? previewTimes.length > 0
      ? formatLocalTime(previewTimes[0])
      : t("settingsPage.automations.previewNone")
    : shown?.nextRunAt
      ? formatLocalTime(shown.nextRunAt)
      : t("settingsPage.automations.previewWait");
  const summarySchedule = schedSummary || t("settingsPage.automations.descNone");
  const summaryLastRun = shown?.lastRunAt ? formatLocalTime(shown.lastRunAt) : t("autoEdit.neverRun");
  const summaryLastResult = shown?.lastError
    ? t("autoEdit.lastRunFailed")
    : shown?.lastRunAt
      ? t("autoEdit.lastRunSucceeded")
      : t("autoEdit.neverRun");

  return (
    <div className="aued" id="autoEditView">
      <div className="aued-head">
        <button type="button" className="icon-btn aued-back" title={t("autoEdit.back")} onClick={onBack}>
          <span><Icon name="back" size={17} /></span>
        </button>
        <div className="aued-tt">
          <div className="aued-title-row">
            <div className="aued-title">{isNew ? t("autoEdit.titleCreate") : t("autoEdit.titleEdit")}</div>
            <span className="sp" />
            {/* Delivery automations are agent-owned: the host rejects automations_update for
                them, so the editor must not offer a save that would silently fail */}
            {tab === "settings" && (
              <button
                type="button"
                className="frm-primary aued-save"
                disabled={!canSave || !!initial?.deliverTo}
                title={initial?.deliverTo ? t("autoEdit.deliveryLocked") : undefined}
                onClick={save}
              >
                {t("common.save")}
              </button>
            )}
          </div>
          <div className="aued-sub">{t(isNew ? "autoEdit.subtitleCreate" : "autoEdit.subtitleEdit")}</div>
        </div>
      </div>

      <div className="aued-tabrow">
        <div className="aued-tabs" role="tablist">
          <button type="button" role="tab" className={"aued-tab" + (tab === "settings" ? " on" : "")}
            onClick={() => setTab("settings")}>{t("autoEdit.tabSettings")}</button>
          {!isNew && (
            <button type="button" role="tab" className={"aued-tab" + (tab === "history" ? " on" : "")}
              onClick={() => setTab("history")}>{t("autoEdit.tabHistory")}</button>
          )}
        </div>
      </div>

      {tab === "settings" ? (
        <div className="aued-layout">
          {initial?.deliverTo ? (
            <div className="aued-delivery-lock">{t("autoEdit.deliveryLocked")}</div>
          ) : null}
          <aside className="aued-summary">
            <div className="aued-summary-head">
              {!isNew && stKind && (
                <span className={"aued-chip st-" + stKind} title={shown?.lastError ?? undefined}>
                  <i className="aued-dot" />
                  {stLabel}
                </span>
              )}
              <h2>{summaryTitle}</h2>
              <p title={draft.prompt}>{summaryPrompt}</p>
            </div>
            <div className="aued-summary-next">
              <span>{t("autoEdit.nextRunLabel")}</span>
              <strong className="aued-next-time">{summaryNextRun}</strong>
              <span className="aued-next-rule" title={summarySchedule}>{summarySchedule}</span>
            </div>
            {!isNew && shown && (
              <>
                <div className="aued-summary-meta">
                  <div><span>{t("autoEdit.statusLabel")}</span><strong>{stLabel}</strong></div>
                  <div><span>{t("autoEdit.runCountLabel")}</span><strong>{shown.runCount}</strong></div>
                  <div><span>{t("autoEdit.lastRunLabel")}</span><strong>{summaryLastRun}</strong></div>
                  <div><span>{t("autoEdit.lastResultLabel")}</span><strong className={shown.lastError ? "is-error" : undefined}>{summaryLastResult}</strong></div>
                </div>
                <button type="button" className="save-btn aued-run-now" disabled={!shown.enabled}
                  title={shown.enabled ? undefined : t("settingsPage.shared.disabledTip")}
                  onClick={() => send({ type: "automations_run_now", id: shown.id })}>
                  {t("settingsPage.automations.runNowTitle")}
                </button>
              </>
            )}
          </aside>

          <div className="aued-form frm-rows">
            <section className="frm-row">
              <div className="frm-label">
                <strong>{t("autoEdit.basicInfo")}</strong>
                <span className="frm-hint">{t("autoEdit.basicInfoHint")}</span>
              </div>
              <div className="frm-ctl">
                <input id="auedTitle" className="inp" spellCheck={false} maxLength={200} value={draft.title}
                  placeholder={t("settingsPage.automations.titlePlaceholder")}
                  onChange={(e) => patch({ title: e.target.value })} />
              </div>
            </section>

            <section className="frm-row">
              <div className="frm-label">
                <strong>{t("autoEdit.scheduleSection")}</strong>
                <span className="frm-hint">{t("autoEdit.scheduleSectionHint")}</span>
              </div>
              <div className="frm-ctl">
                <div className="aued-schedule-grid">
                  <div className="aued-schedule-note">
                    <strong>{schedSummary || t("settingsPage.automations.descNone")}</strong>
                    <span>{t("autoEdit.scheduleSummaryHint")}</span>
                  </div>
                  <div className="aued-sched">
                    <Pick
                      id="autoFreqSel"
                      plain
                      value={draft.schedKind === "cron" ? "cron" : draft.unit}
                      options={[
                        { id: "minute", label: t("settingsPage.automations.freqMinute") },
                        { id: "hourly", label: t("settingsPage.automations.freqHourly") },
                        { id: "daily", label: t("settingsPage.automations.freqDaily") },
                        { id: "weekly", label: t("settingsPage.automations.freqWeekly") },
                        { id: "monthly", label: t("settingsPage.automations.freqMonthly") },
                        { id: "cron", label: t("settingsPage.automations.freqCron") },
                      ]}
                      onChange={(id) =>
                        id === "cron"
                          ? patch({ schedKind: "cron" })
                          : patch({ schedKind: "rule", unit: id as AutomationUnit })
                      }
                    />
                    {draft.schedKind === "cron" ? (
                      <span className="aued-field-inline">
                        <input className="inp aued-cron" spellCheck={false} value={draft.cronExpr} placeholder="30 14 * * *"
                          onChange={(e) => patch({ cronExpr: e.target.value })} />
                        {cronBad && <span className="aued-err">{t("settingsPage.automations.cronInvalid")}</span>}
                      </span>
                    ) : (
                      <>
                        {(draft.unit === "minute" || draft.unit === "hourly") && (
                          <span className="aued-field-inline">
                            <span className="aued-fl">{t("settingsPage.automations.everyPrefix")}</span>
                            <input className="inp aued-inp-sm" inputMode="numeric" value={draft.interval}
                              onChange={(e) => patch({ interval: e.target.value })} />
                            <span className="aued-fl">{t(`settingsPage.automations.unit_${draft.unit}`)}</span>
                          </span>
                        )}
                        {draft.unit !== "minute" && draft.unit !== "hourly" && (
                          <span className="aued-field-inline">
                            <span className="aued-fl">{t("settingsPage.automations.timeLabel")}</span>
                            <input className="inp aued-inp-sm" inputMode="numeric" value={draft.hour}
                              onChange={(e) => patch({ hour: e.target.value })} />
                            <span className="aued-sep">:</span>
                            <input className="inp aued-inp-sm" inputMode="numeric" value={draft.minute}
                              onChange={(e) => patch({ minute: e.target.value })} />
                          </span>
                        )}
                        {draft.unit === "weekly" && (
                          <span className="aued-pills">
                            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                              <button key={d} type="button"
                                className={"mcp-type-pill" + (draft.weekdays.includes(d) ? " on" : "")}
                                onClick={() => {
                                  if (draft.weekdays.includes(d)) {
                                    if (draft.weekdays.length === 1) return; // at least one day stays selected (host rejects empty)
                                    patch({ weekdays: draft.weekdays.filter((x) => x !== d) });
                                  } else {
                                    patch({ weekdays: [...draft.weekdays, d] });
                                  }
                                }}>
                                {t(`settingsPage.automations.weekday${d}`)}
                              </button>
                            ))}
                          </span>
                        )}
                        {draft.unit === "monthly" && (
                          <span className="aued-field-inline">
                            <span className="aued-fl">{t("settingsPage.automations.monthDaysLabel")}</span>
                            <input className="inp aued-cron" spellCheck={false} value={draft.monthDays} placeholder="1,15"
                              onChange={(e) => patch({ monthDays: e.target.value })} />
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className="frm-row">
              <div className="frm-label">
                <strong>{t("autoEdit.contentSection")}</strong>
                <span className="frm-hint">{t("autoEdit.contentSectionHint")}</span>
              </div>
              <div className="frm-ctl">
                <div className="aued-promptwrap">
                  <textarea id="auedPrompt" className="aued-prompt" spellCheck={false} value={draft.prompt}
                    placeholder={t("settingsPage.automations.promptPlaceholder")}
                    onChange={(e) => patch({ prompt: e.target.value })} />
                  <div className="aued-tools">
                    {projectOptions.length > 0 ? (
                      <Pick id="autoProjectSel" plain icon="folderLine" value={draft.cwd} options={projectOptions} onChange={(cwd) => patch({ cwd })} />
                    ) : (
                      <input className="inp aued-grow" spellCheck={false} value={draft.cwd} placeholder="/path/to/project"
                        onChange={(e) => patch({ cwd: e.target.value })} />
                    )}
                    {/* Per-run computer control for this automation's sessions; sits right of the
                        project picker (the two per-run routing choices stay adjacent). */}
                    <button
                      type="button"
                      id="autoComputerBtn"
                      className={"aued-toggle" + (draft.computer ? " on" : "")}
                      title={t("autoEdit.computerHint")}
                      onClick={() => patch({ computer: !draft.computer })}
                    >
                      <Icon name="computer" size={14} />
                      <span>{t("autoEdit.computerLabel")}</span>
                      <i className="aued-toggle-k" />
                    </button>
                    <EnabledModelPicker
                      // The cascade menus portal to body (fixed overlay) and always render
                      // fully — no scroll-container clipping, no direction override needed.
                      selClassName="plain"
                      label={draft.model ? (modelNames.get(draft.model) ?? draft.model) : t("settingsPage.automations.modelDefault")}
                      selectedId={draft.model || undefined}
                      pinnedRows={[
                        // "Follow global default" stays a first-level row above the provider cascade
                        { key: "__default", label: t("settingsPage.automations.modelDefault"), onPick: () => patch({ model: "" }) },
                      ]}
                      onPick={(model) => patch({ model })}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section className="frm-row">
              <div className="frm-label">
                <strong>{t("autoEdit.boundarySection")}</strong>
                <span className="frm-hint">{t("autoEdit.boundarySectionHint")}</span>
              </div>
              <div className="frm-ctl">
                <div className="aued-endrow">
                  <span className="aued-pills">
                    {["never", "count", "date"].map((m) => (
                      <button key={m} type="button" className={"mcp-type-pill" + (draft.endMode === m ? " on" : "")}
                        onClick={() => {
                          const mode = m as Draft["endMode"];
                          // An empty date value renders as the locale placeholder (reads like
                          // today) but fails validation — seed today when switching to date mode.
                          patch(mode === "date" && !draft.endDate ? { endMode: mode, endDate: msToEndDate(Date.now()) } : { endMode: mode });
                        }}>
                        {t(`settingsPage.automations.end_${m}`)}
                      </button>
                    ))}
                  </span>
                  <span className={"aued-endval" + (draft.endMode === "never" ? " off" : "")}>
                    {draft.endMode === "count" ? (
                      <input className="inp aued-inp-sm" inputMode="numeric" value={draft.maxRuns}
                        title={t("settingsPage.automations.maxRunsTitle")}
                        onChange={(e) => patch({ maxRuns: e.target.value })} />
                    ) : (
                      <span className="aued-field-inline">
                        <input type="date" className="inp aued-inp-sm aued-date" value={draft.endDate}
                          onChange={(e) => patch({ endDate: e.target.value })} />
                        {endBad && <span className="aued-err">{t("settingsPage.automations.endDateInvalid")}</span>}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </section>
          </div>
        </div>
      ) : (
        <div className="aued-history">
          {runs.length === 0 ? (
            <div className="aued-runsempty">{t("settingsPage.automations.historyEmpty")}</div>
          ) : (
            <>
              <table className="aued-runs">
                <thead>
                  <tr>
                    <th>{t("autoEdit.runsColTime")}</th>
                    <th>{t("autoEdit.runsColTrigger")}</th>
                    <th>{t("autoEdit.runsColStatus")}</th>
                    <th>{t("autoEdit.runsColDuration")}</th>
                    <th className="aued-runs-sess">{t("autoEdit.runsColSession")}</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRuns.map((r) => (
                    <tr key={r.runId}>
                      <td className="aued-run-time">{formatLocalTime(r.scheduledAt ?? r.createdAt)}</td>
                      <td className="aued-run-dim">{t(r.trigger === "manual" ? "settingsPage.automations.triggerManual" : "settingsPage.automations.triggerSchedule")}</td>
                      <td>
                        <span className={"aued-run-st st-" + r.status} title={r.status === "failed" ? (r.error ?? t("autoEdit.runsErrorUnavailable")) : undefined}>
                          <i className="aued-dot" />
                          {t(`settingsPage.automations.status_${r.status}`)}
                        </span>
                      </td>
                      <td className="aued-run-dim">{fmtDurationMs(r.updatedAt - r.createdAt)}</td>
                      <td className="aued-runs-sess">
                        {r.sessionPath ? (
                          <button type="button" className="aued-open"
                            onClick={() => {
                              openSessionByPath(r.sessionPath!, initial!.cwd);
                              onBack(); // the session takes over the main view; drop the editor state
                            }}>
                            {t("settingsPage.automations.openSessionBtn")}
                          </button>
                        ) : r.sessionId ? (
                          <span className="aued-run-sid" title={r.sessionId}>{r.sessionId.slice(0, 8)}</span>
                        ) : (
                          <span className="aued-run-dim">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {runsTotalPages > 1 && (
                <nav className="aued-pager">
                  <button type="button" className="aued-page-btn" disabled={runsCurrentPage <= 1}
                    onClick={() => setRunsPage(Math.max(1, runsCurrentPage - 1))}>
                    {t("autoEdit.runsPrevPage")}
                  </button>
                  <span className="aued-pages">
                    {runsPageItems(runsCurrentPage, runsTotalPages).map((item, i) =>
                      item === "ellipsis" ? (
                        <span key={`e${i}`} className="aued-page-ellipsis">…</span>
                      ) : (
                        <button key={item} type="button"
                          className={"aued-page-num" + (item === runsCurrentPage ? " on" : "")}
                          aria-current={item === runsCurrentPage ? "page" : undefined}
                          onClick={() => setRunsPage(item)}>
                          {item}
                        </button>
                      ),
                    )}
                  </span>
                  <button type="button" className="aued-page-btn" disabled={runsCurrentPage >= runsTotalPages}
                    onClick={() => setRunsPage(Math.min(runsTotalPages, runsCurrentPage + 1))}>
                    {t("autoEdit.runsNextPage")}
                  </button>
                </nav>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
