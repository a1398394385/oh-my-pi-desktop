// Settings · Automations page: scheduled-task list, inline expand-down editor
// (schedule builder + advanced cron + end conditions + next-run preview) and per-task
// run history. Row/expand skeleton follows the Skills/MCP .mem-expand pattern
// (row .on highlight + caret rotation + popIn); all state is host-authoritative —
// every mutating automations_* RPC replies with a fresh automations_list frame and
// the editor closes when that reconciliation lands.
import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast, openSessionByPath, closeSettings, pathBase } from "../../../store";
import Icon from "../../../Icon";
import { confirmDialog, emptyRow } from "../common";
import {
  describeAutomation,
  describeSchedule,
  describeCronExpr,
  formatLocalTime,
  isPlausibleCronExpr,
  endDateToMs,
  msToEndDate,
  type Automation,
  type AutomationScheduleInput,
  type AutomationUnit,
} from "../../../lib/automations";

/** Editor draft: text-field state mirrors the raw inputs; numeric parsing happens at build time. */
interface Draft {
  title: string;
  prompt: string;
  cwd: string;
  model: string; // "" = follow the global default
  schedKind: "rule" | "cron";
  unit: AutomationUnit;
  interval: string;
  hour: string;
  minute: string;
  weekdays: number[];
  monthDays: string;
  cronExpr: string;
  endMode: "never" | "count" | "date";
  maxRuns: string;
  endDate: string; // yyyy-mm-dd (<input type="date"> value)
}

/** Blank draft for the create form (defaults: every 1 day at 09:00, unbounded). */
function blankDraft(): Draft {
  return {
    title: "",
    prompt: "",
    cwd: "",
    model: "",
    schedKind: "rule",
    unit: "daily",
    interval: "1",
    hour: "9",
    minute: "0",
    weekdays: [1],
    monthDays: "1",
    cronExpr: "",
    endMode: "never",
    maxRuns: "1",
    endDate: "",
  };
}

/** Draft pre-filled from a persisted automation (cron schedules keep the raw expression). */
function draftOf(a: Automation): Draft {
  const d = blankDraft();
  d.title = a.title;
  d.prompt = a.prompt;
  d.cwd = a.cwd;
  d.model = a.model ?? "";
  if (a.cronExpr && !a.scheduleRule) {
    d.schedKind = "cron";
    d.cronExpr = a.cronExpr;
  } else if (a.scheduleRule) {
    d.schedKind = "rule";
    d.unit = a.scheduleRule.unit;
    d.interval = String(a.scheduleRule.interval);
    d.hour = String(a.scheduleRule.hour);
    d.minute = String(a.scheduleRule.minute);
    d.weekdays = a.scheduleRule.weekdays?.slice() ?? [1];
    d.monthDays = (a.scheduleRule.monthDays ?? []).join(",");
  }
  if (a.endAt) {
    d.endMode = "date";
    d.endDate = msToEndDate(a.endAt);
  } else if (!a.recurring) {
    d.endMode = "count";
    d.maxRuns = String(a.maxRuns ?? 1);
  }
  return d;
}

/** Clamp helper for the small numeric inputs. */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Build the wire schedule input from the draft; null = locally incomplete/invalid. */
function buildScheduleInput(d: Draft): AutomationScheduleInput | null {
  if (d.schedKind === "cron") {
    const expr = d.cronExpr.trim();
    return expr ? { kind: "cron", cronExpr: expr } : null;
  }
  const interval = clampInt(d.interval, 1, 200, 1);
  const hour = clampInt(d.hour, 0, 23, 9);
  const minute = clampInt(d.minute, 0, 59, 0);
  switch (d.unit) {
    case "minute":
      // minute/hourly carry no time-of-day on the wire: the phase derives from the host-side
      // anchor (types.ts contract), so nothing else is sent.
      return { kind: "rule", unit: "minute", interval };
    case "hourly":
      return { kind: "rule", unit: "hourly", interval };
    case "daily":
      return { kind: "rule", unit: "daily", interval, hour, minute };
    case "weekly":
      // Empty selection is invalid (host buildScheduleRule throws); the pill group also
      // refuses to deselect the last day.
      if (d.weekdays.length === 0) return null;
      return { kind: "rule", unit: "weekly", interval, hour, minute, weekdays: d.weekdays.slice().sort((a, b) => a - b) };
    case "monthly": {
      const days = [...new Set(d.monthDays.split(/[,，、\s]+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 31))];
      if (days.length === 0) return null;
      return { kind: "rule", unit: "monthly", interval, hour, minute, monthDays: days.sort((a, b) => a - b) };
    }
  }
}

// Boxed dropdown (.sel container + .menu, same behavior contract as the MCP form's Sel:
// click to toggle, item click picks, click-outside closes).
function Pick({
  value,
  options,
  onChange,
  id,
}: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
  id?: string;
}) {
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
  const cur = options.find((o) => o.id === value);
  return (
    <div className="sel auto-sel" id={id} ref={ref}>
      <button
        type="button"
        className="auto-sel-btn"
        title={cur?.label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="truncate">{cur?.label ?? value}</span>
        <span className="caret-svg"><Icon name="caret" size={12} /></span>
      </button>
      <div
        className={"menu" + (open ? " open" : "")}
        onClick={(e) => {
          e.stopPropagation();
          const mi = (e.target as HTMLElement).closest(".mi") as HTMLElement | null;
          if (!mi) return;
          setOpen(false);
          onChange(mi.getAttribute("data-id") ?? "");
        }}
      >
        {options.map((o) => (
          <div key={o.id} className={"mi" + (o.id === value ? " on" : "")} data-id={o.id}>
            {o.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// Inline expand-down editor for one automation (create = initial null).
function AutomationEditor({
  initial,
  onClose,
  onSaved,
  onDelete,
}: {
  initial: Automation | null;
  onClose: () => void;
  onSaved: () => void; // parent flips the close-on-next-list latch before we save
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isNew = !initial;
  const [draft, setDraft] = useState<Draft>(() => (initial ? draftOf(initial) : blankDraft()));
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  const modelCatalog = useAppStore((s) => s.modelCatalog);
  const automationPreview = useAppStore((s) => s.automationPreview);

  // Project options: registered projects minus removed ones; the edited automation's own cwd
  // always stays selectable even when it is not registered. No projects at all → free-text input.
  const projectOptions = useMemo(() => {
    const list = allProjects.filter((c) => !removedProjects.includes(c)).map((c) => ({ id: c, label: pathBase(c) }));
    if (draft.cwd && !list.some((o) => o.id === draft.cwd)) list.push({ id: draft.cwd, label: pathBase(draft.cwd) });
    return list;
  }, [allProjects, removedProjects, draft.cwd]);

  // Model options: chat-kind catalog entries (same filter as the model page's role pickers);
  // a pinned model outside the catalog stays selectable.
  const modelOptions = useMemo(() => {
    const list = [{ id: "", label: t("settingsPage.automations.modelDefault") }];
    for (const m of modelCatalog.filter((x) => (x.kind ?? "chat") === "chat")) list.push({ id: m.id, label: m.name });
    if (draft.model && !list.some((o) => o.id === draft.model)) list.push({ id: draft.model, label: draft.model });
    return list;
  }, [modelCatalog, draft.model, t]);

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

  function save() {
    if (!canSave || !scheduleInput) return;
    onSaved();
    const base = {
      title: draft.title.trim(),
      prompt: draft.prompt,
      cwd: draft.cwd.trim(),
      model: draft.model || null,
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

  const runs = useAppStore((s) => (initial ? s.automationRuns[initial.id] : undefined)) ?? [];

  return (
    <div className="mem-expand auto-expand">
      <div className="mem-exp-head">
        <span>{isNew ? t("settingsPage.automations.editorTitleNew") : t("settingsPage.automations.editorTitleEdit")}</span>
        {!isNew && <span className="sub">{initial!.id}</span>}
        <span className="sp" />
        <button type="button" className="save-btn" onClick={onClose}>{t("settingsPage.shared.collapse")}</button>
      </div>

      <div className="auto-form">
        <div className="auto-frow">
          <span className="auto-fl">{t("settingsPage.automations.titleLabel")}</span>
          <input className="inp auto-grow" spellCheck={false} value={draft.title}
            placeholder={t("settingsPage.automations.titlePlaceholder")}
            onChange={(e) => patch({ title: e.target.value })} />
        </div>
        <div className="auto-frow">
          <span className="auto-fl">{t("settingsPage.automations.promptLabel")}</span>
          <textarea className="inp auto-prompt" spellCheck={false} value={draft.prompt}
            placeholder={t("settingsPage.automations.promptPlaceholder")}
            onChange={(e) => patch({ prompt: e.target.value })} />
        </div>
        <div className="auto-frow">
          <span className="auto-fl">{t("settingsPage.automations.projectLabel")}</span>
          {projectOptions.length > 0 ? (
            <Pick id="autoProjectSel" value={draft.cwd} options={projectOptions} onChange={(cwd) => patch({ cwd })} />
          ) : (
            <input className="inp auto-grow" spellCheck={false} value={draft.cwd} placeholder="/path/to/project"
              onChange={(e) => patch({ cwd: e.target.value })} />
          )}
          <span className="auto-fl">{t("settingsPage.automations.modelLabel")}</span>
          <Pick id="autoModelSel" value={draft.model} options={modelOptions} onChange={(model) => patch({ model })} />
        </div>
        <div className="auto-frow">
          <span className="auto-fl">{t("settingsPage.automations.freqLabel")}</span>
          <Pick
            id="autoFreqSel"
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
            <span className="auto-field">
              <input className="inp auto-cron" spellCheck={false} value={draft.cronExpr} placeholder="30 14 * * *"
                onChange={(e) => patch({ cronExpr: e.target.value })} />
              {cronBad && <span className="auto-err">{t("settingsPage.automations.cronInvalid")}</span>}
            </span>
          ) : (
            <>
              <span className="auto-field">
                <span className="auto-fl">{t("settingsPage.automations.everyPrefix")}</span>
                <input className="inp auto-inp-sm" inputMode="numeric" value={draft.interval}
                  onChange={(e) => patch({ interval: e.target.value })} />
                <span className="auto-fl">{t(`settingsPage.automations.unit_${draft.unit}`)}</span>
              </span>
              {draft.unit !== "minute" && draft.unit !== "hourly" && (
                <span className="auto-field">
                  <span className="auto-fl">{t("settingsPage.automations.timeLabel")}</span>
                  <input className="inp auto-inp-sm" inputMode="numeric" value={draft.hour}
                    onChange={(e) => patch({ hour: e.target.value })} />
                  <span className="auto-time-sep">:</span>
                  <input className="inp auto-inp-sm" inputMode="numeric" value={draft.minute}
                    onChange={(e) => patch({ minute: e.target.value })} />
                </span>
              )}
              {draft.unit === "weekly" && (
                <span className="auto-pills">
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
                <span className="auto-field">
                  <span className="auto-fl">{t("settingsPage.automations.monthDaysLabel")}</span>
                  <input className="inp auto-cron" spellCheck={false} value={draft.monthDays} placeholder="1,15"
                    onChange={(e) => patch({ monthDays: e.target.value })} />
                </span>
              )}
            </>
          )}
        </div>
        <div className="auto-frow">
          <span className="auto-fl">{t("settingsPage.automations.endLabel")}</span>
          <span className="auto-pills">
            {(["never", "count", "date"] as const).map((m) => (
              <button key={m} type="button" className={"mcp-type-pill" + (draft.endMode === m ? " on" : "")}
                onClick={() => patch({ endMode: m })}>
                {t(`settingsPage.automations.end_${m}`)}
              </button>
            ))}
          </span>
          {draft.endMode === "count" && (
            <input className="inp auto-inp-sm" inputMode="numeric" value={draft.maxRuns}
              title={t("settingsPage.automations.maxRunsTitle")}
              onChange={(e) => patch({ maxRuns: e.target.value })} />
          )}
          {draft.endMode === "date" && (
            <span className="auto-field">
              <input type="date" className="inp auto-inp-sm auto-date" value={draft.endDate}
                onChange={(e) => patch({ endDate: e.target.value })} />
              {endBad && <span className="auto-err">{t("settingsPage.automations.endDateInvalid")}</span>}
            </span>
          )}
        </div>
        <div className="auto-frow">
          <span className="auto-fl">{t("settingsPage.automations.previewLabel")}</span>
          {!scheduleInput ? (
            <span className="auto-preview"><span className="ph">{t("settingsPage.automations.previewNone")}</span></span>
          ) : previewTimes ? (
            previewTimes.length > 0 ? (
              <span className="auto-preview">
                {previewTimes.map((ts) => (
                  <span key={ts}>{formatLocalTime(ts)}</span>
                ))}
              </span>
            ) : (
              <span className="auto-preview"><span className="ph">{t("settingsPage.automations.previewNone")}</span></span>
            )
          ) : (
            <span className="auto-preview"><span className="ph">{t("settingsPage.automations.previewWait")}</span></span>
          )}
        </div>
      </div>

      <div className="auto-foot">
        <button type="button" className="save-btn" disabled={!canSave} onClick={save}>{t("common.save")}</button>
        {!isNew && (
          <button type="button" className="save-btn danger" onClick={onDelete}>{t("common.delete")}</button>
        )}
      </div>

      {!isNew && (
        <div className="auto-history">
          <div className="auto-history-tt">{t("settingsPage.automations.historyLabel")}</div>
          {runs.length === 0 ? (
            <div className="auto-run-empty">{t("settingsPage.automations.historyEmpty")}</div>
          ) : (
            runs.map((r) => (
              <div className="auto-run-row" key={r.runId}>
                <span className="auto-run-time">{formatLocalTime(r.updatedAt)}</span>
                <span className="auto-run-badge dim">
                  {t(r.trigger === "manual" ? "settingsPage.automations.triggerManual" : "settingsPage.automations.triggerSchedule")}
                </span>
                <span className={"auto-run-badge " + (r.status === "succeeded" ? "ok" : r.status === "failed" ? "bad" : "dim")}>
                  {t(`settingsPage.automations.status_${r.status}`)}
                </span>
                {r.error && <span className="auto-run-err" title={r.error}>{r.error}</span>}
                {r.sessionId && <span className="auto-run-sid" title={r.sessionId}>{r.sessionId.slice(0, 8)}</span>}
                {r.sessionPath && (
                  <button type="button" className="auto-run-open"
                    onClick={() => {
                      openSessionByPath(r.sessionPath!, initial!.cwd);
                      closeSettings(); // the session takes over the main view; drop the settings overlay
                    }}>
                    {t("settingsPage.automations.openSessionBtn")}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function AutomationsPage() {
  const { t } = useTranslation();
  const automations = useAppStore((s) => s.automations);
  const [spin, setSpin] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null); // expanded automation id, "__new" = create form
  const closeOnNextList = useRef(false); // save in flight → collapse the editor when the reconciling list lands

  // Data refresh on page open (automations_list reply lands via the wsHandler table).
  useEffect(() => {
    send({ type: "automations_list" });
  }, []);

  // The editor closes only when the host's authoritative list arrives (failed saves keep it open;
  // the error frame already toasts the reason).
  useEffect(() => {
    if (!closeOnNextList.current) return;
    closeOnNextList.current = false;
    setOpenId(null);
    toast(t("settingsPage.automations.savedToast"));
  }, [automations, t]);

  function onRefresh() {
    setSpin(true);
    send({ type: "automations_list" });
    setTimeout(() => setSpin(false), 500);
  }

  function toggleEditor(a: Automation) {
    setOpenId((cur) => (cur === a.id ? null : a.id));
  }

  function onToggle(a: Automation, e: ReactMouseEvent) {
    e.stopPropagation();
    const next = !a.enabled;
    // Optimistic flip (host replies with a fresh automations_list that reconciles).
    useAppStore.setState((s) => ({ automations: s.automations.map((x) => (x.id === a.id ? { ...x, enabled: next } : x)) }));
    send({ type: "automations_toggle", id: a.id, enabled: next });
  }

  async function onRowDelete(a: Automation, e: ReactMouseEvent) {
    e.stopPropagation();
    if (
      await confirmDialog({
        title: t("settingsPage.automations.deleteTitle"),
        message: t("settingsPage.automations.deleteMsg", { name: a.title }),
        confirmText: t("common.delete"),
        danger: true,
      })
    ) {
      if (openId === a.id) setOpenId(null);
      send({ type: "automations_delete", id: a.id });
    }
  }

  function onRunNow(a: Automation, e: ReactMouseEvent) {
    e.stopPropagation();
    send({ type: "automations_run_now", id: a.id });
  }

  async function onEditorDelete(a: Automation) {
    if (
      await confirmDialog({
        title: t("settingsPage.automations.deleteTitle"),
        message: t("settingsPage.automations.deleteMsg", { name: a.title }),
        confirmText: t("common.delete"),
        danger: true,
      })
    ) {
      closeOnNextList.current = false;
      setOpenId(null);
      send({ type: "automations_delete", id: a.id });
    }
  }

  const openAutomation = openId && openId !== "__new" ? automations.find((a) => a.id === openId) ?? null : null;

  return (
    <div className="set-page" id="pg-automations">
      <div className="set-tt auto-tt">
        {t("settingsPage.nav.automations")}
        <button type="button" className={"icon-btn pg-refresh" + (spin ? " spin" : "")} title={t("settingsPage.model.refresh")} onClick={onRefresh}>
          <Icon name="refresh" size={17} />
        </button>
        <button type="button" className="add-btn" onClick={() => setOpenId("__new")}>{t("settingsPage.shared.newBtn")}</button>
      </div>
      <div className="auto-hint">{t("settingsPage.automations.unattendedHint")}</div>

      <div className="set-card" id="automationsList">
        {!openAutomation && openId === "__new" && (
          <AutomationEditor
            key="__new"
            initial={null}
            onClose={() => setOpenId(null)}
            onSaved={() => {
              closeOnNextList.current = true;
            }}
            onDelete={() => setOpenId(null)}
          />
        )}
        {automations.length === 0 && openId !== "__new" ? (
          emptyRow(t("settingsPage.automations.empty"))
        ) : (
          automations.map((a) => (
            <Fragment key={a.id}>
              <div className={"srow auto-row" + (openId === a.id ? " on" : "")} data-id={a.id} onClick={() => toggleEditor(a)}>
                <div className="srow-tx">
                  <b>{a.title}</b>
                  <span title={a.scheduleRule ? describeSchedule(a.scheduleRule, t) : describeCronExpr(a.cronExpr ?? "")}>
                    {describeAutomation(a, t)}
                  </span>
                </div>
                <div className="srow-ctl">
                  <span className={"auto-status" + (a.lastError ? " err" : a.lifecycle === "completed" ? " done" : "")}
                    title={a.lastError ?? undefined}>
                    {a.lastError
                      ? t("settingsPage.automations.statusError", { error: a.lastError.length > 40 ? a.lastError.slice(0, 40) + "…" : a.lastError })
                      : a.lifecycle === "completed"
                        ? t("settingsPage.automations.statusCompleted")
                        : a.nextRunAt
                          ? t("settingsPage.automations.nextRunAt", { time: formatLocalTime(a.nextRunAt) })
                          : ""}
                  </span>
                  <div className={"tg" + (a.enabled ? " on" : "")}
                    title={a.enabled ? t("settingsPage.shared.enabledTip") : t("settingsPage.shared.disabledTip")}
                    onClick={(e) => onToggle(a, e)}>
                    <i />
                  </div>
                  <button type="button" className="plus-btn" title={t("settingsPage.automations.runNowTitle")}
                    onClick={(e) => onRunNow(a, e)}>
                    <span><Icon name="play" size={13} /></span>
                  </button>
                  <button type="button" className="plus-btn auto-danger" title={t("common.delete")}
                    onClick={(e) => void onRowDelete(a, e)}>
                    <span><Icon name="trash" size={13} /></span>
                  </button>
                </div>
                <span className="mem-caret"><Icon name="caretSlim" size={14} /></span>
              </div>
              {openId === a.id && (
                <AutomationEditor
                  key={a.id}
                  initial={a}
                  onClose={() => setOpenId(null)}
                  onSaved={() => {
                    closeOnNextList.current = true;
                  }}
                  onDelete={() => void onEditorDelete(a)}
                />
              )}
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}
