// Advisor advice rendering (base customType "advisor"). Two shapes share one severity
// vocabulary:
//   AdvisorInline  — the blocking notes of a batch, at the batch's stream position inside
//                    a visible process (that position is the injection point).
//   AdvisorCard    — everything else, at the turn's tail: severity counts in the head,
//                    per-note T-n only inside the expanded body.
// Collapsing the process (concise live view) routes the blockers here too — the renderer
// decides, the card only counts what it was given.
import { useEffect, useState } from "react";
import type { AdvisorNote, AdvisorSeverity } from "../../types/session";
import { useAppStore } from "../../store/index";
import Icon from "../../Icon";
import { t } from "../../i18n";

const SEV_ORDER: AdvisorSeverity[] = ["blocker", "concern", "nit"];

// Highest severity in the list (drives the card's edge color and head dot)
function topSeverity(notes: AdvisorNote[]): AdvisorSeverity {
  for (const s of SEV_ORDER) {
    if (notes.some((n) => (n.severity ?? "concern") === s)) return s;
  }
  return "nit";
}

function SevChip({ severity }: { severity: AdvisorSeverity }) {
  const label = severity === "blocker" ? "advisorSevBlocker" : severity === "concern" ? "advisorSevConcern" : "advisorSevNit";
  return <span className={"adv-chip " + severity}>{t(`chat.${label}`)}</span>;
}

// One blocking note inline in the process. Body carries the raw guidance (same text the
// model received); the T-n age sits in the head because the row has no expanded state.
export function AdvisorInline({ notes }: { notes: AdvisorNote[] }) {
  return (
    <div className="adv-inline">
      {notes.map((n, i) => {
        const sev = n.severity ?? "concern";
        return (
          <div className={"adv-inline-item " + sev} key={i}>
            <div className="adv-inline-head">
              <span className="adv-dot" />
              <span className="adv-src">advisor</span>
              {n.advisor ? <span className="adv-who">{n.advisor}</span> : null}
              <SevChip severity={sev} />
              {n.turnsAgo !== undefined ? <span className="adv-age">T-{n.turnsAgo}</span> : null}
            </div>
            <div className="adv-tx">{n.note}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Turn-tail advisor card. Default open state follows the process display style: the
 * detailed/expanded styles already put all process rows on screen, so the card opens with
 * them; standard/concise keep it folded until the reader asks. A manual toggle survives
 * row updates but is re-seeded when the style changes (the style is the intent, the toggle
 * is a per-card override).
 */
export default function AdvisorCard({ notes }: { notes: AdvisorNote[] }) {
  const style = useAppStore((st) => st.uiPrefs.agentProcessStyle);
  const autoOpen = style === "detailed" || style === "expanded";
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => setOpen(autoOpen), [autoOpen]);
  const counts = SEV_ORDER.map((s) => [s, notes.filter((n) => (n.severity ?? "concern") === s).length] as const).filter(
    ([, n]) => n > 0,
  );
  return (
    <div className={"adv-card tone-" + topSeverity(notes) + (open ? " open" : "")}>
      <button className="adv-head" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="adv-dot" />
        <span className="adv-src">advisor</span>
        {counts.map(([s, n]) => (
          <span className="adv-count" key={s}>
            <SevChip severity={s} />
            <span className="adv-age">×{n}</span>
          </span>
        ))}
        <Icon name="chevronDown" className="adv-chev" />
      </button>
      {open ? (
        <div className="adv-body">
          {notes.map((n, i) => (
            <div className="adv-note" key={i}>
              <div className="adv-note-head">
                <SevChip severity={n.severity ?? "concern"} />
                {n.advisor ? <span className="adv-who">{n.advisor}</span> : null}
                {n.turnsAgo !== undefined ? <span className="adv-age">T-{n.turnsAgo}</span> : null}
              </div>
              <div className="adv-tx">{n.note}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
