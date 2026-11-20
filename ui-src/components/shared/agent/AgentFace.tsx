// Tile face in ZCode style: the body itself is the agent's identity color and the eyes are
// always white — no extra features ride on top.
//
// The identity palette is a mixed board, not the raw brand gradient: the four brand stops
// (pink/magenta/violet/cyan) are kept and the five hue gaps filled at matching brightness, so
// nine agents stay mutually distinguishable (raw gradient samples crowd the pink→violet half).
// Nine fixed colors picked by `avatarIndex` (the tenth agent wraps); without a number,
// fall back to a hash of `name`. Callers pass the unique subagent id as `name` — our
// display names repeat across runs, ids do not, so the hash spreads evenly.
//
// Motion engine and expression vocabulary are ported 1:1 from ZCode's workflow face
// (see faceMotion.ts); the state sets the base expression, autonomous motion only touches
// SVG attributes.
import { useEffect, useRef, type CSSProperties } from "react";
import { BASE_EXPRESSION, faceState, startFaceMotion } from "./faceMotion";
import type { StGroup } from "./subShared";

/** Identity palette (hue order): red/orange/yellow/green/teal/cyan/violet/magenta/pink.
    #5CD8E9, #9B40FD, #C738E2, #E53CAC are the brand gradient's stops; the rest fill the hue
    gaps at matching brightness. */
export const FACE_COLORS = [
  "#EA4045",
  "#F19D38",
  "#F5C94C",
  "#5BC67A",
  "#54B9A6",
  "#5CD8E9",
  "#9B40FD",
  "#C738E2",
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

// Reference eye shapes drawn directly inside the 20-box; left and right share their start
// points so a face swap keeps the baseline.
function Eyes() {
  return (
    <g className="agent-face-eyes">
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
  // The identity color drives the body (var --agent-face-body); the eyes are always white.
  // Both are pinned inline so the face does not depend on CSS defaults.
  const identity = color ?? agentColor(avatarIndex, name);
  const style = {
    "--agent-face-body": identity,
    "--agent-face-eye": "#FFFFFF",
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
      <rect className="agent-face-body" fill="var(--agent-face-body)" height={20} rx={7} width={20} />
      <Eyes />
    </svg>
  );
}
