// Remote SSH workspaces: the desktop's representation of a workspace that
// lives on a remote machine reached through an OMP-configured SSH host
// (user-scope ssh.json). OMP's native model is kept intact — the agent session
// runs locally in a stub directory and operates on the remote tree through
// `ssh://<host>/<path>` internal URLs plus remote bash (`ssh <host> '…'`),
// exactly like a base TUI user would; this module only materializes the stub
// and marks it with a metadata file (no system-prompt injection — the base
// keeps full ownership of the prompt).
//
// Marker layout: <stub>/.omp/remote-workspace.json — the stub's `.omp` dir is
// the ordinary OMP project agent dir, so no new conventions enter the base.
import * as fs from "node:fs";
import * as path from "node:path";
import { getRemoteDir, getSSHConfigPath } from "@oh-my-pi/pi-utils";
import { readSSHConfigFile, sanitizeHostName } from "./bootstrap.ts";

export interface RemoteWorkspaceInfo {
  /** SSH host alias (key in user-scope ssh.json) */
  host: string;
  /** Absolute POSIX path of the workspace root on the remote machine */
  remotePath: string;
}

/** Marker file name inside the stub's `.omp` directory. */
const MARKER_FILE = "remote-workspace.json";

/** Filesystem-safe, length-capped dir fragment for a remote path. */
function slugifyRemotePath(remotePath: string): string {
  const slug = remotePath.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (slug || "root").slice(0, 60);
}

/** Validate and normalize a remote workspace path. Returns null when invalid. */
export function normalizeRemotePath(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  let normalized = value.replace(/\/{2,}/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "") || "/";
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

/** Stub directory for a (host, remotePath) pair — deterministic, so reconnecting finds the same workspace. Root: <profile remote dir>/workspaces (sshfs mount points live directly under the remote dir, no overlap). */
export function remoteWorkspaceDir(host: string, remotePath: string): string {
  return path.join(getRemoteDir(), "workspaces", `${sanitizeHostName(host)}--${slugifyRemotePath(remotePath)}`);
}

// Marker read cache keyed by stub dir; mtime-keyed so writes invalidate and
// missing markers stay cached as null until a file appears.
const markerCache = new Map<string, { mtimeMs: number; info: RemoteWorkspaceInfo | null }>();

function markerPath(dir: string): string {
  return path.join(dir, ".omp", MARKER_FILE);
}

/** Read a stub dir's remote-workspace marker; null when the dir is not a remote workspace. */
export function readRemoteWorkspaceInfo(dir: string): RemoteWorkspaceInfo | null {
  const file = markerPath(dir);
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {}
  const cached = markerCache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.info;
  let info: RemoteWorkspaceInfo | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { host?: unknown; remotePath?: unknown };
    if (typeof raw.host === "string" && raw.host && typeof raw.remotePath === "string" && raw.remotePath.startsWith("/")) {
      info = { host: raw.host, remotePath: raw.remotePath };
    }
  } catch {}
  markerCache.set(dir, { mtimeMs, info });
  return info;
}

/** Materialize (or refresh) the stub directory + marker for a remote workspace; returns the stub path. */
export async function ensureRemoteWorkspaceDir(host: string, remotePath: string): Promise<string> {
  const dir = remoteWorkspaceDir(host, remotePath);
  await fs.promises.mkdir(path.join(dir, ".omp"), { recursive: true });
  await fs.promises.writeFile(markerPath(dir), `${JSON.stringify({ host, remotePath, version: 1 }, null, 2)}\n`, "utf8");
  return dir;
}

/** Look up a host alias in the current profile's user-scope ssh.json. */
export async function readUserSshHost(name: string): Promise<{ host: string; username?: string; port?: number; keyPath?: string } | undefined> {
  const config = await readSSHConfigFile(getSSHConfigPath("user"));
  return (config.hosts ?? {})[name];
}

/** Resolve a local path inside a remote-workspace stub to its remote target.
 *  Deterministic prefix match against the workspaces root (no ancestor walk):
 *  the first path segment under <remote dir>/workspaces is the stub dir, whose
 *  marker carries the host and remote root; remaining segments join onto the
 *  remote POSIX path. Returns null for normal local-session paths — one
 *  string compare, no fs access on the miss path. Mixed "/" and "\" input is
 *  normalized because the frontend tree joins entries with "/". */
export function resolveRemoteTarget(localPath: string): RemoteWorkspaceInfo | null {
  const wsRoot = path.join(getRemoteDir(), "workspaces").replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const norm = localPath.replace(/\\/g, "/");
  if (!norm.startsWith(wsRoot)) return null;
  const segments = norm.slice(wsRoot.length).split("/").filter(Boolean);
  if (!segments.length) return null;
  const info = readRemoteWorkspaceInfo(path.join(getRemoteDir(), "workspaces", segments[0]));
  if (!info) return null;
  const rel = segments.slice(1).filter((s) => s !== "." && s !== "..");
  return { host: info.host, remotePath: rel.length ? `${info.remotePath}/${rel.join("/")}` : info.remotePath };
}

