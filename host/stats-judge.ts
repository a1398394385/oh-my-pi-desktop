// Stats dashboard judge: omp-stats classifies messages with an LLM only when
// the hosting process registers a judge. The standalone `omp stats` server
// registers one; the desktop serves that same API itself, so without this the
// frustration page only had regex signals and its judge button was disabled.
// Same judge role chain as the base CLI (`omp stats` → openStandaloneJudge),
// but reusing the host's open auth store and model registry instead of opening
// a second one.
import { resolveJudge, sharedJudgmentCache } from "./bootstrap.ts";
import { safeStderr } from "./stderr.ts";

/** Settings + model registry types, taken from the judge's own dependency shape. */
type JudgeDeps = Parameters<typeof resolveJudge>[0];

/**
 * Register the judge omp-stats' frustration classification needs.
 *
 * Called on every profile apply: the judge resolves its role chain from the
 * profile's settings, and re-registering drops omp-stats' cached judge so a
 * profile switch cannot keep billing the previous profile's model. The import
 * runs in the background — it must not delay the ready frame.
 */
export function registerStatsJudge(settings: JudgeDeps["settings"], registry: JudgeDeps["registry"]): void {
  void (async () => {
    const { setStatsJudgeProvider } = await import("@oh-my-pi/omp-stats/frustration");
    setStatsJudgeProvider(async () =>
      resolveJudge({
        settings,
        registry,
        sessionId: crypto.randomUUID(),
        purpose: "stats_frustration",
        cache: sharedJudgmentCache(),
      }),
    );
  })().catch((err: unknown) => {
    safeStderr(`[stats] judge registration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}
