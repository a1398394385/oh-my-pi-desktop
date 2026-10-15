// GUI environment bootstrap: a host spawned by the Tauri shell (Finder/Dock)
// inherits a stripped PATH (/usr/bin:/bin:/usr/sbin:/sbin), so commands
// installed via nvm/Homebrew/pnpm (npx, codegraph, ...) fail MCP stdio spawn
// with "Executable not found in $PATH". nvm initializes in .zshrc, which only
// interactive shells load — a plain login shell is NOT enough. Same trick as
// VSCode's shell-env: run one interactive login shell, extract the full PATH
// via sentinels, and append entries missing from the host PATH (original
// order preserved, extend-only, no reordering). Writing process.env.PATH
// covers every downstream spawn: assets.ts health probe ({...process.env})
// and the SDK stdio transport ({...Bun.env}, Bun.env === process.env).

import { safeStderr } from "./stderr.ts";
const SENTINEL_BEGIN = "__OMP_PATH_BEGIN__";
const SENTINEL_END = "__OMP_PATH_END__";
const SHELL_TIMEOUT_MS = 3000;

async function readShellPath(shell: string): Promise<string | null> {
  try {
    // Single-line sentinel wrapping keeps rc-file banners / nvm notices out
    const proc = Bun.spawn([shell, "-ilc", `printf '${SENTINEL_BEGIN}%s${SENTINEL_END}' "$PATH"`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), SHELL_TIMEOUT_MS);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const m = out.match(new RegExp(`${SENTINEL_BEGIN}(.*?)${SENTINEL_END}`));
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

let promise: Promise<void> | null = null;

// Idempotent singleton: host.ts fires it early (overlapping the SDK static
// graph load of main.ts); main.ts awaits the same promise.
function run(): Promise<void> {
  return (async () => {
    if (process.platform !== "darwin") return;
    const shell = process.env.SHELL || "/bin/zsh";
    const shellPath = await readShellPath(shell);
    if (!shellPath) {
      safeStderr(`[host] PATH augment skipped: ${shell} -ilc returned no PATH (keeping GUI default PATH)\n`);
      return;
    }
    const current = (process.env.PATH ?? "").split(":").filter(Boolean);
    const seen = new Set(current);
    const additions = shellPath.split(":").filter((p) => p && !seen.has(p));
    if (!additions.length) return;
    process.env.PATH = [...current, ...additions].join(":");
    safeStderr(`[host] PATH augmented: appended ${additions.length} entries from ${shell}\n`);
  })();
}

export function augmentGuiPath(): Promise<void> {
  if (!promise) promise = run().catch((err) => {
    safeStderr(`[host] PATH augment error: ${err}\n`);
  });
  return promise;
}
