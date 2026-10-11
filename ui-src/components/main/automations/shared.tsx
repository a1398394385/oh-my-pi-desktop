// Shared building blocks for the main-column Automations pages (list + edit view),
// lifted verbatim from the old settings-page editor (ui-src/components/settings/pages/
// AutomationsPage.tsx): draft model, numeric clamp, wire-schedule builder and the
// boxed dropdown (.sel/.menu language, same behavior contract as the MCP form's Sel).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "../../../Icon";
import { useAppStore } from "../../../store";
import {
  endDateToMs,
  isPlausibleCronExpr,
  msToEndDate,
  type Automation,
  type AutomationScheduleInput,
  type AutomationUnit,
} from "../../../lib/automations";

/** Editor draft: text-field state mirrors the raw inputs; numeric parsing happens at build time. */
export interface Draft {
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
export function blankDraft(): Draft {
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
export function draftOf(a: Automation): Draft {
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
export function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Build the wire schedule input from the draft; null = locally incomplete/invalid. */
export function buildScheduleInput(d: Draft): AutomationScheduleInput | null {
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

/** Boxed dropdown (.sel container + .menu, same behavior contract as the MCP form's Sel:
 * click to toggle, item click picks, click-outside closes). */
export function Pick({
  value,
  options,
  onChange,
  id,
  plain,
  icon,
}: {
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
  id?: string;
  plain?: boolean; // borderless inset-bar trigger (zcode schedule/toolbar rows)
  icon?: string; // leading icon inside the trigger
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  // The menu portals to body and is placed fixed (same approach as the sidebar ctx-menu)
  // so it escapes the page scroll container's overflow clipping and stays fully visible
  // past the card edge; its left edge aligns with the trigger's left edge.
  useLayoutEffect(() => {
    const sel = ref.current;
    const menu = menuRef.current;
    if (!open || !sel || !menu) return undefined;
    const z = useAppStore.getState().zoomLevel || 1; // fixed-menu coordinate compensation: set zoom first, then divide back
    (menu.style as CSSStyleDeclaration & { zoom: string }).zoom = String(z);
    const sr = sel.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(sr.left, window.innerWidth - mr.width - 8));
    let top = sr.bottom + 6;
    if (top + mr.height > window.innerHeight - 8 && sr.top - mr.height - 6 > 8) {
      top = sr.top - mr.height - 6; // no room below: flip upward
    }
    menu.style.left = left / z + "px";
    menu.style.top = top / z + "px";
    return undefined;
  }, [open, options]);
  const cur = options.find((o) => o.id === value);
  return (
    <div className={"sel auto-sel" + (plain ? " plain" : "") + (open ? " open" : "")} id={id} ref={ref}>
      <button
        type="button"
        className="auto-sel-btn"
        title={cur?.label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {icon && <Icon name={icon} size={14} className="auto-sel-ic" />}
        <span className="truncate">{cur?.label ?? value}</span>
        <span className="caret-svg"><Icon name="caret" size={12} /></span>
      </button>
      {open &&
        createPortal(
          <div
            className="menu open auto-sel-menu"
            ref={menuRef}
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
          </div>,
          document.body,
        )}
    </div>
  );
}
