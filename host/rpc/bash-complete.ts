// bash_complete: terminal-style completion for the composer's ! bash mode.
// First token of the line completes executable names from a cached PATH scan
// (Windows extensions stripped: git.exe -> git, matching the embedded POSIX
// shell's command resolution); any later token completes paths relative to the
// session cwd (directories first, trailing / appended like a shell would).
import { readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sessions, defaultCwd } from "../state.ts";
import type { RpcHandler } from "./types";

export interface BashCompleteItem {
  label: string; // full replacement text for the token under the caret
  kind: "cmd" | "dir" | "file";
}

const MAX_ITEMS = 12;

// ---- PATH executable cache (filled once per host process) ----
let pathCommands: string[] | null = null;

function scanPathCommands(): string[] {
  const isWin = process.platform === "win32";
  const pathExt = isWin
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
    : null;
  const dirs = (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean);
  const names = new Set<string>();
  for (const dir of dirs) {
    // Missing/unreadable PATH entries are routine (uninstalled tools); skipping
    // them is enumeration, not error swallowing
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (isWin) {
        const dot = e.name.lastIndexOf(".");
        if (dot < 0 || !pathExt!.includes(e.name.slice(dot).toLowerCase())) continue;
        names.add(e.name.slice(0, dot));
      } else {
        names.add(e.name);
      }
    }
  }
  // Shell builtins the embedded POSIX shell resolves without a PATH hit
  for (const b of ["cd", "echo", "export", "pwd", "set", "source", "alias", "which", "type", "grep", "cat", "ls"]) {
    names.add(b);
  }
  return [...names].sort();
}

/** Expand a ~ prefix and resolve the token's directory part against cwd. */
function resolveDir(dirPart: string, cwd: string): string {
  const expanded = dirPart.startsWith("~") ? path.join(homedir(), dirPart.slice(1)) : dirPart;
  return path.resolve(cwd, expanded || ".");
}

async function completeToken(token: string, isFirst: boolean, cwd: string): Promise<BashCompleteItem[]> {
  if (isFirst) {
    const query = token.replace(/^!+/, ""); // strip the mode sigil(s)
    if (!query) return [];
    if (!pathCommands) pathCommands = scanPathCommands(); // lazy: first completion pays the scan
    const q = query.toLowerCase();
    return pathCommands
      .filter((c) => c.toLowerCase().startsWith(q) && c.toLowerCase() !== q)
      .slice(0, MAX_ITEMS)
      .map<BashCompleteItem>((c) => ({ label: c + " ", kind: "cmd" }));
  }
  // Path completion: split into directory part + base prefix (both / and \)
  const sep = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const dirPart = sep >= 0 ? token.slice(0, sep + 1) : "";
  const base = sep >= 0 ? token.slice(sep + 1) : token;
  if (base.includes("*")) return []; // globs are not completed
  let entries: Dirent[];
  try {
    entries = await readdir(resolveDir(dirPart, cwd), { withFileTypes: true });
  } catch {
    return []; // nonexistent/unreadable directory: nothing to offer
  }
  const b = base.toLowerCase();
  const matched = entries.filter((e) => e.name.toLowerCase().startsWith(b));
  matched.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
  return matched.slice(0, MAX_ITEMS).map<BashCompleteItem>((e) =>
    e.isDirectory()
      ? { label: dirPart + e.name + "/", kind: "dir" }
      : { label: dirPart + e.name + " ", kind: "file" },
  );
}

export const bashCompleteHandlers: Record<string, RpcHandler> = {
  async bash_complete(ws, msg) {
    const reqId = Number(msg.reqId ?? 0);
    const text = String(msg.text ?? "");
    const caret = Math.min(Math.max(Number(msg.caret ?? text.length), 0), text.length);
    const entry = msg.sessionId ? sessions.get(String(msg.sessionId)) : undefined;
    const cwd = entry ? entry.session.sessionManager.getCwd() : String(msg.cwd ?? defaultCwd);
    // Token under the caret: the non-space run ending at the caret; first token
    // iff no whitespace precedes it on the line (the ! sigil may be attached)
    const head = text.slice(0, caret);
    const lineStart = head.lastIndexOf("\n") + 1;
    const lineHead = head.slice(lineStart);
    const tokenMatch = lineHead.match(/(\S*)$/);
    const token = tokenMatch ? tokenMatch[1] : "";
    const isFirst = lineHead.trim().length <= token.length && token.length > 0;
    const items = token ? await completeToken(token, isFirst, cwd) : [];
    ws.send(JSON.stringify({ type: "bash_complete_result", reqId, items }));
  },
};
