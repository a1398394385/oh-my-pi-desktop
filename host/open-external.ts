/**
 * Cross-platform "open in default app": URLs in the default browser, files in
 * their default editor, folders in the file manager.
 *
 * Bun.spawn(["open", ...]) is macOS-only — on Windows there is no `open`
 * binary and the spawn throws ENOENT (callers used to swallow it, leaving
 * e.g. the OAuth device flow "Waiting for device authorization..." with a
 * browser that never opens). Windows goes through rundll32
 * url.dll,FileProtocolHandler (ShellExecute semantics: URL → browser, file →
 * default app, folder → Explorer; direct CreateProcess, no cmd.exe parsing of
 * '&' in query strings). Linux/BSD fall back to xdg-open.
 */
import { safeStderr } from "./stderr.ts";

export function openExternal(target: string): void {
  if (!target) return;
  try {
    if (process.platform === "win32") {
      Bun.spawn(["rundll32", "url.dll,FileProtocolHandler", target], { stdout: "ignore", stderr: "ignore" });
    } else if (process.platform === "darwin") {
      Bun.spawn(["open", target], { stdout: "ignore", stderr: "ignore" });
    } else {
      Bun.spawn(["xdg-open", target], { stdout: "ignore", stderr: "ignore" });
    }
  } catch (err) {
    // Still best-effort for the caller, but a silent failure left the user staring
    // at "browser opened" with nothing on screen — log the reason at least.
    safeStderr(`[host] openExternal failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
