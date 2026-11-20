// Face motion engine, ported 1:1 from ZCode's workflow-face-motion.ts (packages/ui/src/
// components/workflow-timeline). States, expressions, timings and the DOM-only update
// strategy are identical; two integrations differ:
// 1. The status input is our StGroup (subShared) instead of their StepRunStatus. Their
//    vocabulary has no "aborted": a stopped run maps to "idle" (neutral, blinks and
//    glances only) rather than "sad" — aborted is not a failure.
// 2. The motion gate is the app's three-way data-motion contract (shell.motionEnabled)
//    instead of a bare matchMedia check, and data-motion flips restart the loop through a
//    MutationObserver — the media-change event cannot see attribute-forced overrides.
import { motionEnabled } from "../../../shell";
import type { StGroup } from "./subShared";

export type FaceState = "idle" | "waiting" | "scanning" | "content" | "sad";
export type EyeExpression = "dots" | "pill" | "happy" | "sleepy" | "focused" | "sad" | "confused";
export function faceState(status: StGroup | undefined): FaceState {
  return status === "running"
    ? "scanning"
    : status === "completed"
      ? "content"
      : status === "failed"
        ? "sad"
        : status === "aborted"
          ? "idle"
          : "waiting";
}
export const BASE_EXPRESSION: Record<FaceState, EyeExpression> = {
  idle: "pill",
  waiting: "dots",
  scanning: "pill",
  content: "happy",
  sad: "sad",
};
const SPECIAL: Record<FaceState, readonly EyeExpression[]> = {
  idle: [],
  scanning: ["focused", "confused"],
  waiting: [],
  content: [],
  sad: [],
};

/** A face owns a single pending timer; DOM-only updates never re-render React. */
export function startFaceMotion(face: SVGSVGElement, state: FaceState): () => void {
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = true;
  let rounds = 0;
  let lookingLeft = false;
  let previous: EyeExpression | undefined;
  const random = (min: number, max: number) => min + Math.random() * (max - min);
  const later = (delay: number, action: () => void) => {
    timer = setTimeout(action, delay);
  };
  const motion = (value: string) => {
    face.dataset.motion = value;
  };
  const base = () => {
    face.dataset.expression = BASE_EXPRESSION[state];
    motion("idle");
    face.style.setProperty("--agent-face-x", "0px");
    face.style.setProperty("--agent-face-y", state === "sad" ? "0.3px" : "0px");
  };
  const pause = () => {
    motion("idle");
    later(
      state === "waiting"
        ? random(1500, 3000)
        : state === "scanning"
          ? random(1000, 2000)
          : state === "sad"
            ? random(1800, 4000)
            : random(6000, 10000),
      cycle,
    );
  };
  // Swap silhouettes while the eyes are closed, so a round eye never jumps straight into a
  // slanted one; returning to the base expression uses the same transition.
  const morph = (expression: EyeExpression, next: () => void) => {
    motion("morph");
    later(80, () => {
      face.dataset.expression = expression;
      later(100, () => {
        motion("idle");
        next();
      });
    });
  };
  const maybeExpression = () => {
    // An idle face only blinks and glances: it never borrows run states or random task expressions.
    if (state === "idle") {
      pause();
      return;
    }
    rounds++;
    const probability = state === "scanning" ? 0.45 : 0.25;
    if (rounds < 2 || Math.random() >= probability) {
      pause();
      return;
    }
    const choices = SPECIAL[state].filter((e) => e !== previous);
    // A result state with a single occasional expression still waits two base rounds between
    // visits — it must never swap face twice in a row.
    const pool = choices.length ? choices : SPECIAL[state];
    const expression = pool[Math.floor(Math.random() * pool.length)]!;
    previous = expression;
    rounds = 0;
    const hold = expression === "confused" ? random(2200, 3800) : random(800, 1800);
    morph(expression, () => later(hold, () => morph(BASE_EXPRESSION[state], pause)));
  };
  const glance = () => {
    motion("glance");
    // The shift must land on the other side of the face; the old ±0.65 nudge read as eye
    // jitter, not as a look that stays.
    lookingLeft = !lookingLeft;
    face.style.setProperty("--agent-face-x", lookingLeft ? "-4px" : "0px");
    later(360, maybeExpression);
  };
  function cycle() {
    if (state === "waiting") {
      motion("dots-wave");
      later(900, pause);
      return;
    }
    if (state === "sad") {
      const floats = Math.random() < 0.5 ? 1 : 2;
      face.style.setProperty("--agent-face-floats", String(floats));
      motion("float");
      later(floats * 600, () => {
        if (Math.random() >= 0.4) {
          pause();
          return;
        }
        morph("focused", () => {
          const shakes = 3 + Math.floor(Math.random() * 3);
          face.style.setProperty("--agent-face-shakes", String(shakes));
          motion("shake");
          later(shakes * 90, () => {
            motion("idle");
            later(random(500, 1000), () => morph("sad", pause));
          });
        });
      });
      return;
    }
    if (state === "content") {
      const hops = Math.random() < 0.5 ? 2 : 3;
      face.style.setProperty("--agent-face-hops", String(hops));
      motion("hop");
      later(hops * 240, () => {
        face.dataset.expression = "pill";
        motion("idle");
        later(250, () => {
          const duration = random(260, 320);
          face.style.setProperty("--agent-face-blinks", "1");
          face.style.setProperty("--agent-face-blink-time", `${duration}ms`);
          motion("blink");
          later(duration, () => {
            face.dataset.expression = "happy";
            pause();
          });
        });
      });
    } else {
      const blinks = Math.random() < 0.5 ? 2 : 3;
      const duration = state === "scanning" ? random(200, 260) : random(260, 320);
      face.style.setProperty("--agent-face-blinks", String(blinks));
      face.style.setProperty("--agent-face-blink-time", `${duration}ms`);
      motion("blink");
      later(duration * blinks, glance);
    }
  }
  const restart = () => {
    clearTimeout(timer);
    timer = undefined;
    rounds = 0;
    lookingLeft = false;
    base();
    if (!document.hidden && motionEnabled() && visible) later(random(1200, 2800), cycle);
  };
  const observer =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          const next = entries[0]?.isIntersecting ?? true;
          if (next !== visible) {
            visible = next;
            restart();
          }
        });
  observer?.observe(face);
  // The user-facing motion switch flips html[data-motion], which no media query can observe.
  const motionObserver = new MutationObserver(restart);
  motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  document.addEventListener("visibilitychange", restart);
  media?.addEventListener?.("change", restart);
  restart();
  return () => {
    clearTimeout(timer);
    observer?.disconnect();
    motionObserver.disconnect();
    document.removeEventListener("visibilitychange", restart);
    media?.removeEventListener?.("change", restart);
    base();
  };
}
