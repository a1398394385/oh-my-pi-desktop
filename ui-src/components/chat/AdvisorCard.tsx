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

// Blocking notes inline in the process. Folded by default: the head row (severity chip,
// advisor, age) is enough to notice the block; the raw guidance the model received
// expands on click, matching the turn-tail card's disclosure language. A single note
// renders its text bare under the head (the head already carries its meta); multiple
// notes keep the full per-item rows so each severity/author stays distinguishable.
export function AdvisorInline({ notes }: { notes: AdvisorNote[] }) {
  const [open, setOpen] = useState(false);
  const first = notes[0];
  return (
    <div className={"adv-inline" + (open ? " open" : "")}>
      <button className="adv-inline-head" type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {first ? (
          <>
            <span className="adv-dot" />
            <span className="adv-src">advisor</span>
            {first.advisor ? <span className="adv-who">{first.advisor}</span> : null}
            <SevChip severity={first.severity ?? "concern"} />
            {first.turnsAgo !== undefined ? <span className="adv-age">T-{first.turnsAgo}</span> : null}
          </>
        ) : null}
        {notes.length > 1 ? <span className="adv-age">×{notes.length}</span> : null}
        <Icon name="chevronDown" className="adv-chev" />
      </button>
      {open ? (
        notes.length === 1 ? (
          <div className="adv-tx">{first.note}</div>
        ) : (
          notes.map((n, i) => (
            <div className={"adv-inline-item " + (n.severity ?? "concern")} key={i}>
              <div className="adv-inline-head">
                <span className="adv-dot" />
                <span className="adv-src">advisor</span>
                {n.advisor ? <span className="adv-who">{n.advisor}</span> : null}
                <SevChip severity={n.severity ?? "concern"} />
                {n.turnsAgo !== undefined ? <span className="adv-age">T-{n.turnsAgo}</span> : null}
              </div>
              <div className="adv-tx">{n.note}</div>
            </div>
          ))
        )
      ) : null}
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
