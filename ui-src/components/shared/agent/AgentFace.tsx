// Tile face: every subagent shares one violet-night body — the face itself is the species
// (the way ZCode's face is their app icon). Individuality rides the two features that move
// color together: the π brow and the pupils, both drawn in the agent's identity color.
//
// The identity palette is a free hue wheel, not the brand gradient: three brand anchors
// (pink/violet/cyan) plus six gap fillers, all bright enough to read on the night body.
// Nine fixed colors picked by `avatarIndex` (the tenth agent wraps); without a number,
// fall back to a hash of `name`. Callers pass the unique subagent id as `name` — our
// display names repeat across runs, ids do not, so the hash spreads evenly.
//
// Motion engine and expression vocabulary are ported 1:1 from ZCode's workflow face
// (see faceMotion.ts); the state sets the base expression, autonomous motion only touches
// SVG attributes. The eye band sits 4px lower than ZCode's to make room for the brow.
import { useEffect, useRef, type CSSProperties } from "react";
import { BASE_EXPRESSION, faceState, startFaceMotion } from "./faceMotion";
import type { StGroup } from "./subShared";

/** Unified body: brand-3 violet pulled down to night lightness (L≈0.16). Dark enough that
    every palette color — including violet itself — stays readable on it. */
export const FACE_BODY = "#2A0C4B";

/** Identity palette (hue order): red/orange/yellow/green/teal/cyan/blue/violet/pink.
    #5CD8E9, #9B40FD, #E53CAC are the brand gradient's stops; the rest fill the hue gaps
    at matching brightness. */
export const FACE_COLORS = [
  "#EA4045",
  "#F19D38",
  "#F5C94C",
  "#5BC67A",
  "#54B9A6",
  "#5CD8E9",
  "#72A3F0",
  "#9B40FD",
  "#E53CAC",
] as const;

/** Name-hash color pick (base-31 mod 360, mapped onto the nine-color board); only the fallback when no `avatarIndex` exists. */
export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return FACE_COLORS[hash % FACE_COLORS.length]!;
}

/** An agent's identity color: the index wins (nine-color ring, wrapping), the name hash is the fallback. */
export function agentColor(avatarIndex: number | undefined, name: string): string {
  if (avatarIndex === undefined) return avatarColor(name);
  return FACE_COLORS[
    ((avatarIndex % FACE_COLORS.length) + FACE_COLORS.length) % FACE_COLORS.length
  ]!;
}

const EXPRESSIONS = ["pill", "happy", "sleepy", "focused", "sad", "confused"] as const;

// Reference eye shapes drawn directly inside the 20-box, the whole band shifted down 4px
// for the brow; left and right share their start points so a face swap keeps the baseline.
function Eyes() {
  return (
    <g className="agent-face-eyes">
      <g transform="translate(0 4)">
        <g className="agent-face-bounce">
          <g className="agent-face-lids">
            <g data-eye-expression="dots" fill="var(--agent-face-eye)">
              {[5, 10, 15].map((cx) => (
                <circle key={cx} cx={cx} cy={10} r={1.5} />
              ))}
            </g>
            {EXPRESSIONS.map((expression) => (
              <g key={expression} data-eye-expression={expression} fill="var(--agent-face-eye)">
                {[7, 13].map((x, i) => {
                  if (expression === "pill" || expression === "confused") {
                    const short = expression === "confused" && i === 1;
                    return (
                      <rect key={x} x={x} y={short ? 8 : 6} width={4} height={short ? 4 : 6} rx={2} />
                    );
                  }
                  const paths = {
                    happy: "M0 11 V8 A2 2 0 0 1 4 8 V11 Z",
                    sleepy:
                      i === 0 ? "M0 8 L4 7 V9 A2 2 0 0 1 0 9 Z" : "M0 7 L4 8 V9 A2 2 0 0 1 0 9 Z",
                    focused:
                      i === 0 ? "M0 6 L4 8 V10 A2 2 0 0 1 0 10 Z" : "M0 8 L4 6 V10 A2 2 0 0 1 0 10 Z",
                    sad:
                      i === 0 ? "M0 8 L4 6 V10 A2 2 0 0 1 0 10 Z" : "M0 6 L4 8 V10 A2 2 0 0 1 0 10 Z",
                  };
                  return <path key={x} transform={`translate(${x} 0)`} d={paths[expression]} />;
                })}
              </g>
            ))}
          </g>
          {/* Closed eyes are drawn as separate capsules: a vertical scale would squash the
              rounded ends into hairlines. */}
          <g className="agent-face-closed" fill="var(--agent-face-eye)">
            {[7, 13].map((x) => (
              <rect key={x} x={x} y={8} width={4} height={2} rx={1} />
            ))}
          </g>
        </g>
      </g>
    </g>
  );
}

export function AgentFace({
  avatarIndex,
  className,
  name,
  status,
  idle = false,
  color,
}: {
  avatarIndex: number | undefined;
  className?: string;
  name: string;
  status: StGroup | undefined;
  idle?: boolean;
  color?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const state = idle ? "idle" : faceState(status);
  useEffect(() => {
    if (ref.current) return startFaceMotion(ref.current, state);
  }, [state]);
  // The identity color drives brow + pupils (var --agent-face-eye); the body is the
  // constant violet night, pinned inline so the face does not depend on CSS defaults.
  const style = {
    "--agent-face-body": FACE_BODY,
    "--agent-face-eye": color ?? agentColor(avatarIndex, name),
  } as CSSProperties;
  return (
    <svg
      aria-hidden
      className={"agent-face" + (className ? " " + className : "")}
      data-face-state={state}
      data-expression={BASE_EXPRESSION[state]}
      data-motion="idle"
      ref={ref}
      style={style}
      viewBox="0 0 20 20"
    >
      <rect className="agent-face-body" fill="var(--agent-face-body)" height={20} rx={5} width={20} />
      {/* The π brow: a static feature (never glances, never blinks), the brand mark of the
          species face; shares the individual identity color with the pupils. */}
      <path
        d="M4.6 4.6 H15.4 M7.2 4.6 V8.6 M12.8 4.6 V7.9 Q12.8 8.9 14 8.7"
        stroke="var(--agent-face-eye)"
        strokeWidth={1.7}
        strokeLinecap="round"
        fill="none"
      />
      <Eyes />
    </svg>
  );
}
