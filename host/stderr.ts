// Safe stderr writes. The host's stderr (and stdout) is a pipe created by the
// Tauri shell; once the shell dies the read end is closed and every further
// write throws EPIPE. Most logging happens inside timers or async callbacks
// (e.g. the 5-minute quota refresh), where the throw becomes an unhandled
// rejection and drags the whole host into the fatal teardown. That teardown
// appends a session_exit entry to every open session's journal, and during a
// host-overlap window (shell restart / two app instances) those sessions are
// owned by the successor host — the append forks the whole journal into a
// duplicate session file (the 2026-10-05 triple-session incident). Logging
// must never kill the process.

/** Write one line to stderr, dropping it silently when the pipe is gone. Accepts console.error-style variadic args. */
export function safeStderr(...args: unknown[]): void {
  try {
    if (args.length === 1 && typeof args[0] === "string") process.stderr.write(args[0]);
    else process.stderr.write(`${args.map(arg => (typeof arg === "string" ? arg : Bun.inspect(arg, { depth: 4 }))).join(" ")}\n`);
  } catch {
    // Broken pipe (parent shell already gone): drop the line. The parent-death
    // self-monitor in main.ts reaps this process shortly.
  }
}

// Stream errors do not always throw synchronously: an unhandled "error" event
// on the stream would crash the process just the same, so keep one no-op
// listener. Module top level runs once per process regardless of import count.
process.stderr?.on?.("error", () => {});
