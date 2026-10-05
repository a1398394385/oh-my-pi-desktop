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
  } catch {
    // Best-effort: a failed launch must never break the calling flow.
  }
}
