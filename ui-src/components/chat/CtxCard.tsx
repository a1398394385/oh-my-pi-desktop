// Context detail card (a 1:1 port of the ctxRing section from ui/ringpop.js's
// buildCtxCard/buildLimitsSection/mountRingPop/fillCtxCard/fillLimits/initRingpop
// into a React component).
// Interaction rules follow the "ring-pop popcard design spec" in AGENTS.md: a 150ms hover
// timer, a 250ms grace period when leaving toward the card, hover on the card does not close
// it, and data arrival uses "discard on move-away" (store updates while the card is closed
// do not rebuild it; the next hover re-requests).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../store/index";
import { fmtTokens } from "../../store/utils";
import { placeMenu } from "../../shell";
import { fmtLimitWindow, limitTone } from "../../lib/limits";
import type { LimitWindow } from "../../lib/limits";
import { t } from "../../i18n";

/** setTimeout handle (DOM and Node environments return different types; unified alias) */
type TimerHandle = ReturnType<typeof setTimeout>;

// Provider limits response shape (S.ctxLimits)
interface CtxLimits {
  label?: string;
  unsupported?: boolean;
  status?: string;
  windows?: LimitWindow[];
  balance?: { amount?: number | null; currency?: string } | null; // host always sends the field; null = no balance section
}

// Quota section (ported from the former buildLimitsSection): the popcard keeps the
// cx-sec/lx-* structure of the old ring-pop
function LimitsSection({ limits, noDiv }: { limits: CtxLimits; noDiv?: boolean }) {
  const windows = limits.windows ?? [];
  const balance = limits.balance;
  let body;
  if (limits.unsupported) {
    body = t("chat.providerNoLimits");
  } else if (limits.status === "notConfigured") {
    body = t("chat.providerNoCredentials");
  } else if (!windows.length && !balance) {
    body = t("chat.limitsUnavailable");
  } else {
    // Balance-type providers (a metric:'credits' window + balance synthesized host-side)
    // show only the balance number, without progress bars or percentages; providers with
    // percentage windows still render per window
    const pctWindows = windows.filter((w) => w.metric !== "credits");
    if (!pctWindows.length && balance?.amount != null) {
      body = (
        <div className="pt-[8px] text-dim text-[12px]" /* style-token-ignore */>{t("chat.balance", { amount: balance.amount, currency: balance.currency ?? "" })}</div>
      );
    } else if (!pctWindows.length) {
      body = t("chat.limitsUnavailable");
    } else {
      body = (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-[10px]">
            {pctWindows.slice(0, 4).map((w, i) => {
              const item = fmtLimitWindow(w);
              return (
                <div className="flex flex-col gap-[5px] min-w-0" key={i}>
                  <div className="flex items-center gap-[6px] text-dim text-[11.5px] whitespace-nowrap overflow-hidden" /* style-token-ignore */><span className="truncate">{item.label}</span></div>
                  <div className="text-[15px] font-semibold whitespace-nowrap" /* style-token-ignore */ style={{ color: limitTone(item.remaining) }}>
                    {item.remaining != null ? `${item.remaining}%` : "—"}
                    {item.resetIn ? <span className="text-faint text-[12px] font-normal" /* style-token-ignore */> · {item.resetIn}</span> : null}
                  </div>
                  <div className="lx-bar">
                    <i style={{ width: `${item.remaining != null ? Math.min(100, item.remaining) : 0}%`, background: limitTone(item.remaining) }} />
                  </div>
                </div>
              );
            })}
          </div>
          {balance?.amount != null && (
            <div className="pt-[8px] text-dim text-[12px]" /* style-token-ignore */>{t("chat.balance", { amount: balance.amount, currency: balance.currency ?? "" })}</div>
          )}
        </>
      );
    }
  }
  return (
    <div className={"cx-sec pb-[2px]" + (noDiv ? " no-div" : "")}>
      <div className="flex justify-between items-baseline text-[13.5px] pt-[2px] pb-[10px]" /* style-token-ignore */>
        <b>{t("chat.remainingQuota")}</b>
        <span className="text-faint text-[11.5px]" /* style-token-ignore */>{limits.label ?? ""}</span>
      </div>
      <div className="min-w-[268px]">{body}</div>
    </div>
  );
}

// Composition row dot colors: token equivalent of the old 6-step hardcoded blues (tokens only, no hardcoded hex)
const ROW_DOT_COLORS = ["var(--blue)", "var(--accent)", "var(--dim)", "var(--faint)", "var(--blue)", "var(--accent)"];

// Context detail composition (S.ctxDetail.breakdown): constrains only the fields this component reads
interface CtxBreakdown {
  usedTokens: number;
  contextWindow: number;
  mcpToolsTokens?: number;
  systemToolsTokens: number;
  systemPromptTokens: number;
  skillsTokens: number;
  messagesTokens: number;
  systemContextTokens: number;
}

export default function CtxCard({ anchor }: { anchor: HTMLElement | null }) {
  const ctxDetail = useAppStore((s) => s.ctxDetail); // response arrival triggers redraw (while the card is open)
  const ctxLimits = useAppStore((s) => s.ctxLimits);
  const cur = useAppStore((s) => (s.activePath ? s.openSessions.get(s.activePath) : undefined));
  const [open, setOpen] = useState(false);
  const [noModel, setNoModel] = useState(false); // no session and no model picked in the composer: the card shows "no model available"
  const [compactBusy, setCompactBusy] = useState(false); // compact button pending (the response is finalized by existing core logic)
  const popRef = useRef<HTMLDivElement | null>(null); // popcard DOM (portaled to body; needed for positioning and grace-period checks)
  const enterTimer = useRef<TimerHandle | undefined>(undefined); // ring hover timer (150ms; pop only after dwelling long enough)
  const leaveTimer = useRef<TimerHandle | undefined>(undefined); // ring→card gap grace timer (250ms; no close while moving toward the card)

  // Close the card: discard on move-away — the DOM unmounts, leftover transient data is
  // cleared and re-requested on the next hover
  const dismiss = () => {
    clearTimeout(leaveTimer.current);
    setOpen(false);
  };

  // Anchor (ctxRing) hover wiring: controlled rendering, events attach to the span without
  // touching ctxRing's internal svg structure.
  // Depends on the anchor element itself (not the ref object): the ring renders only after
  // session data is ready, so bind once the element is at hand — otherwise reading
  // current=null once at mount means no listener ever (hover popcard breaks)
  useEffect(() => {
    const el = anchor;
    if (!el) return;
    const onEnter = () => {
      const st = useAppStore.getState();
      const s = st.activePath ? st.openSessions.get(st.activePath) : undefined;
      clearTimeout(enterTimer.current);
      clearTimeout(leaveTimer.current);
      setNoModel(false);
      setCompactBusy(false);
      // 150ms hover timer: a quick pass-through does not disturb; leaving early cancels
      enterTimer.current = setTimeout(() => {
        // Clear the popcard's transient data (discard on move-away): last time's leftovers
        // are not shown; after results arrive the store fills them in (silent write, no bump)
        useAppStore.setState({ ctxDetail: null, ctxLimits: null });
        setOpen(true);
        if (s) {
          st.send({ type: "get_context_detail", sessionId: s.sessionId });
          st.send({ type: "get_limits", sessionId: s.sessionId });
        } else {
          // Popping outside a session is allowed: no context detail, only the quota of the
          // provider of the model currently selected in the composer
          // The model id is in "provider/model" format (host modelsPayload); take the first segment
          const prov = st.newSessionModel ? st.newSessionModel.split("/")[0] : "";
          if (prov) st.send({ type: "get_limits", provider: prov });
          else setNoModel(true);
        }
      }, 150);
    };
    const onLeave = (e: MouseEvent) => {
      clearTimeout(enterTimer.current);
      const pop = popRef.current;
      if (pop?.contains(e.relatedTarget as Node | null)) return; // moved straight into the card; its own mouseleave closes it
      clearTimeout(leaveTimer.current);
      // Grace period only when leaving upward toward the card area (7px ring↔card gap;
      // relatedTarget may be null mid-way); leaving sideways/downward retracts immediately
      const r = el.getBoundingClientRect();
      const pr = pop?.getBoundingClientRect();
      const towardCard = !!pr && e.clientY <= r.top + 2 && e.clientX >= pr.left - 12 && e.clientX <= pr.right + 12;
      if (!towardCard) {
        dismiss();
        return;
      }
      leaveTimer.current = setTimeout(() => {
        if (popRef.current && !popRef.current.matches(":hover")) dismiss();
      }, 250);
    };
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      clearTimeout(enterTimer.current);
      clearTimeout(leaveTimer.current);
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [anchor]);

  // Positioning: the popcard appears right above the ring, bottom edge 7px from the ring
  // top, horizontally center-aligned, inset 8px inside the viewport;
  // visual coordinates go through placeMenu which divides by zoomLevel (fixed + zoom
  // double-scaling pitfall).
  // No deps: runs on every render — content height changes after data-arrival redraws need
  // repositioning (equivalent to placeRingPop inside the old mountRingPop)
  useLayoutEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const el = anchor;
    if (!pop || !el) return;
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), window.innerWidth - w - 8);
    const top = Math.max(r.top - h - 7, 8);
    placeMenu(pop, left, top);
  });

  if (!open) return null; // discard on move-away: nothing renders while closed; store arrivals do not rebuild it

  // breakdown is the expansion of the core's getContextBreakdown (frames.ts annotates the
  // shape per SDK): narrowed to the fields this component reads; missing keys are undefined
  // at runtime, and the presentation layer's existing fallback semantics stay unchanged
  const b = (ctxDetail?.breakdown ?? null) as CtxBreakdown | null;
  const limits: CtxLimits | null = (ctxLimits ?? null) as CtxLimits | null;
  // Compact-context entry: shown only when the session is non-empty and usage > 0; disabled
  // while streaming (races with the running turn).
  // Compacting is non-destructive, so it runs directly without a confirm; pending is set on
  // click, and the response toast / messages frames are finalized by existing store logic
  const canCompact = !!cur && cur.items.length > 0 && !!b && b.usedTokens > 0;

  return createPortal(
    <div
      className="ring-pop"
      ref={popRef}
      onMouseEnter={() => clearTimeout(leaveTimer.current)} // entering the card cancels the grace-period close
      onMouseLeave={dismiss} // leaving the card (not hovering its area anymore) closes directly
    >
      {b ? (
        <>
          <div className="flex justify-between items-center text-ui-md mb-[10px]">
            <b>{t("chat.context")}</b>
            {/* Right-side numbers match the category rows below: value | percentage, bar-separated, right-aligned */}
            <span className="cx-total">
              <span className="cx-val">{fmtTokens(b.usedTokens)}</span>
              <i className="cx-sep" />
              <span className="cx-pct">{((b.usedTokens / b.contextWindow) * 100).toFixed(1)}%</span>
            </span>
          </div>
          <div className="cx-bar">
            <i style={{ width: `${Math.min(100, (b.usedTokens / b.contextWindow) * 100).toFixed(1)}%` }} />
          </div>
          {/* Composition rows are a fixed set of 6 (same categories as ZCode): value and
              percentage right-aligned with equal width, dotted separator between.
              MCP tools = schema tokens of mcp__-prefixed tools (estimated separately by the
              host); Other = system context injection */}
          {(() => {
            const mcpTokens = b.mcpToolsTokens ?? 0;
            const pct = (v: number) => (b.usedTokens > 0 ? ((v / b.usedTokens) * 100).toFixed(1) : "0.0") + "%";
            const rows: [string, number][] = [
              [t("chat.ctxSystemTools"), Math.max(0, b.systemToolsTokens - mcpTokens)],
              [t("chat.ctxMcpTools"), mcpTokens],
              [t("chat.ctxSystemPrompt"), b.systemPromptTokens],
              [t("chat.ctxSkills"), b.skillsTokens],
              [t("chat.ctxMessages"), b.messagesTokens],
              [t("chat.ctxOther"), b.systemContextTokens],
            ];
            return rows.map(([label, v], i) => (
              <div className="cx-row" key={label}>
                <span className="dot" style={{ background: ROW_DOT_COLORS[i] }} />
                <span>{label}</span>
                <span className="cx-val">{fmtTokens(v)}</span>
                <i className="cx-sep" />
                <span className="cx-pct">{pct(v)}</span>
              </div>
            ));
          })()}
        </>
      ) : null}
      {limits ? <LimitsSection limits={limits} noDiv={!b} /> : null}
      {canCompact && (
        <div className="mt-[10px] pt-[10px] border-t border-line-soft">
          <button
            className={"cx-compact-btn" + (compactBusy ? " busy" : "")}
            disabled={!!cur.streaming || compactBusy}
            onClick={() => {
              if (compactBusy) return;
              setCompactBusy(true);
              useAppStore.getState().send({ type: "compact_session", sessionId: cur.sessionId });
            }}
          >
            {compactBusy ? t("chat.compacting") : t("chat.compactContext")}
          </button>
        </div>
      )}
      {/* Empty states: no model provider shows "no model available"; detail response arrived
          but has no composition/limits shows "no data"; otherwise wait for the response */}
      {!b && !limits ? (noModel ? t("chat.noModelAvailable") : ctxDetail ? t("chat.ctxNoData") : t("common.loading")) : null}
    </div>,
    document.body,
  );
}
