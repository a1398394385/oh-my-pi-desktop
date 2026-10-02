// Terminal PTY service: built on the native PtySession of
// @oh-my-pi/pi-natives (cross-platform ConPTY / POSIX PTY), exposing the
// create/write/resize/dispose quartet to the frontend + data-frame /
// exit-frame push-back.
import { PtySession as NativePty } from "@oh-my-pi/pi-natives";
import { hostI18n } from "../ui-src/i18n/host.ts";

const isWindows = process.platform === "win32";

function resolveDefaultShell(): string {
  if (isWindows) {
    if (process.env.SHELL) return process.env.SHELL;
    return "powershell.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}

function buildShellArgs(shell: string, inheritProfile?: boolean): string[] {
  const lower = shell.toLowerCase();
  if (isWindows) {
    if (lower.endsWith("powershell.exe") || lower.endsWith("pwsh.exe") || lower === "powershell" || lower === "pwsh") {
      return ["-NoLogo"];
    }
    if (lower.endsWith("cmd.exe") || lower === "cmd") {
      return [];
    }
    if (lower.includes("bash") || lower.includes("zsh")) {
      return inheritProfile === false ? ["-i"] : ["-l", "-i"];
    }
    return [];
  }
  if (inheritProfile === false) {
    return ["-i"];
  }
  return ["-l", "-i"];
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

export interface PtySession {
  id: string;
  shell: string;
  cwd: string;
  native: NativePty;
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  dispose: () => void;
}

const sessions = new Map<string, PtySession>();
const byOwner = new WeakMap<object, Set<string>>();

// Create a session: start a native PTY via pi-natives.
// onData receives the raw pty output (UTF-8 string); onExit is called once
// after the child process exits.
export async function createTerminal(
  owner: object,
  opts: { id: string; cwd: string; cols: number; rows: number; shell?: string; inheritProfile?: boolean },
  onData: (data: string) => void,
  onExit: (code: number) => void,
): Promise<PtySession> {
  const id = opts.id;
  const shell = opts.shell ?? resolveDefaultShell();
  const args = buildShellArgs(shell, opts.inheritProfile);

  const native = new NativePty();

  let exited = false;
  const handleExit = (code: number) => {
    if (exited) return;
    exited = true;
    sessions.delete(id);
    const ownerSet = byOwner.get(owner);
    if (ownerSet) {
      ownerSet.delete(id);
      if (ownerSet.size === 0) byOwner.delete(owner);
    }
    onExit(code);
  };

  const { promise: startPromise, resolve: resolveStart, reject: rejectStart } = Promise.withResolvers<void>();

  const runPromise = native.startArgv(
    {
      application: shell,
      args,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: {
        ...cleanEnv(),
        TERM: "xterm-256color",
        OMP_LOGIN_SHELL: opts.inheritProfile === false ? "0" : "1",
      },
    },
    (_err, chunk) => {
      if (chunk) onData(chunk);
    },
    (err, _pid) => {
      if (err) rejectStart(err);
      else resolveStart();
    },
  );

  runPromise
    .then((result) => {
      handleExit(result.exitCode ?? (result.cancelled ? 137 : 0));
    })
    .catch((err) => {
      rejectStart(err);
      handleExit(1);
    });

  // Wait for the process to come up (3-second timeout backstop)
  await Promise.race([
    startPromise,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(hostI18n.t("errors.pty.startTimeout"))), 3000),
    ),
  ]);

  const session: PtySession = {
    id,
    shell,
    cwd: opts.cwd,
    native,
    send(data) {
      try {
        native.write(data);
      } catch {}
    },
    resize(cols, rows) {
      try {
        native.resize(cols, rows);
      } catch {}
    },
    dispose() {
      sessions.delete(id);
      const ownerSet = byOwner.get(owner);
      if (ownerSet) {
        ownerSet.delete(id);
        if (ownerSet.size === 0) byOwner.delete(owner);
      }
      try {
        native.kill();
      } catch {}
    },
  };

  sessions.set(id, session);
  let set = byOwner.get(owner);
  if (!set) byOwner.set(owner, (set = new Set()));
  set.add(id);

  return session;
}

// Fetch a session and verify ownership: a frontend may only operate PTYs under its own WS (undefined = absent or not owned)
export function terminalFor(owner: object, id: unknown): PtySession | undefined {
  if (typeof id !== "string") return undefined;
  const t = sessions.get(id);
  return t && byOwner.get(owner)?.has(id) ? t : undefined;
}

// On WS disconnect, clear all sessions under that frontend (the frontend is gone; a surviving PTY is an orphan process)
export function disposeTerminalsOf(owner: object) {
  const set = byOwner.get(owner);
  if (!set) return;
  for (const id of [...set]) sessions.get(id)?.dispose();
  byOwner.delete(owner);
}
