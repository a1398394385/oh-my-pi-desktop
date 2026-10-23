// LAN remote-control server (spec §3): the second Bun.serve — fixed port,
// 0.0.0.0, serves the built UI statically and upgrades /ws connections that
// present the access key, stamping them data.remote = true. Write-side RPC is
// denied for remote connections via REMOTE_WRITE_DENYLIST (enforced in
// rpc/index.ts) and the UI hides settings remotely; this module owns the
// server lifecycle, the omp-desktop.json remote section and static serving.
//
// Spec contract §3.5: every NEW write-class RPC must be added to
// REMOTE_WRITE_DENYLIST (the capabilities bidirectional diff is the recheck).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { readDesktopSection, writeDesktopSection } from "./desktop-json.ts";
import { safeStderr } from "./stderr.ts";

export const REMOTE_DEFAULT_PORT = 16800;

// Write-side RPC denied for remote (ws.data.remote) connections — spec §3.5
// full 61-item circle (settings/models/provider-wizard/login/assets/
// automations/ssh/session write domains). Keep in sync with new write RPCs.
// reload_settings stays OUT: it only re-reads model settings from disk into
// memory (no persistence) and the UI sends it when opening any session.
export const REMOTE_WRITE_DENYLIST: ReadonlySet<string> = new Set([
  // settings.ts (21)
  "set_setting", "set_locale", "set_ui_prefs", "set_external_browser", "set_computer_provider",
  "set_computer_default", "set_approval_mode", "set_acp_enabled", "set_acp_config",
  "set_session_context_enabled", "set_keepalive_enabled", "set_keepalive_config",
  "set_automation_agent_enabled",
  "set_kimi_auto_thinking", "set_hooks_enabled", "set_plugins_enabled", "set_skills_enabled",
  "set_desktop_env", "switch_profile", "set_auto_review", "set_session_title_refresh", "set_branch_titles",
  // models.ts (2)
  "set_enabled_model", "set_model_role",
  // provider-wizard.ts (2)
  "save_provider_models", "save_provider_model",
  // login.ts (10)
  "provider_login", "provider_logout", "provider_list_accounts", "provider_disable_account",
  "provider_enable_account", "provider_reorder_account", "provider_login_cancel",
  "provider_set_key", "login_prompt_reply", "open_models_config",
  // assets.ts (12)
  "asset_file_write", "asset_file_create", "asset_skill_toggle", "asset_plugin_toggle", "asset_plugin_install",
  "asset_skill_delete", "toggle_extension_item", "toggle_extension_provider",
  "toggle_extension_user_source", "set_mcp_server_enabled", "save_mcp_server", "delete_mcp_server",
  // automations.ts (4)
  "automations_create", "automations_update", "automations_delete", "automations_toggle",
  // ssh.ts (3)
  "ssh_save_host", "ssh_remove_host", "add_remote_workspace",
  // session.ts (12)
  "set_session_pinned", "archive_session", "set_project_expanded", "add_project", "remove_project",
  "reorder_projects", "delete_session", "rename_session", "compact_session", "branch_session", "fork_session",
  "edit_resend",
  // collab.ts (3): collab_state is a pure read and stays requestable
  "collab_start", "collab_join", "collab_leave",
  // worktree.ts (2): worktree_status is a pure read
  "worktree_create", "worktree_remove",
]);

export interface RemoteConfig {
  enabled: boolean;
  port: number;
  /** 128-bit hex; empty = not generated yet (generated on first enable) */
  accessKey: string;
  /**
   * Show the session stats bar on narrow (phone) clients. Defaults to false: the phone
   * layout hides it because the bar eats the small viewport; the remote settings page
   * toggles it. Desktop ignores it entirely.
   */
  mobileStatsBar: boolean;
}

/** One historical remote visitor, recorded on each authenticated /ws upgrade (settings page card). */
export interface RemoteDeviceRecord {
  /** Brand label parsed from the User-Agent (e.g. "iPhone · Safari"); "Unknown" when unusable */
  name: string;
  ip: string;
  /** Epoch ms of the most recent visit */
  lastAt: number;
}

/** History cap: oldest entries drop off beyond this (a LAN typically has a handful of devices) */
const REMOTE_DEVICE_HISTORY_LIMIT = 20;

function isDeviceRecord(v: unknown): v is RemoteDeviceRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.name === "string" && typeof r.ip === "string" && typeof r.lastAt === "number";
}

/** Read the omp-desktop.json remote section (missing/invalid fields fall back to defaults). */
export function readRemoteConfig(): RemoteConfig {
  const s = readDesktopSection("remote");
  return {
    enabled: s.enabled === true,
    port: typeof s.port === "number" && Number.isInteger(s.port) && s.port > 0 && s.port <= 65535 ? s.port : REMOTE_DEFAULT_PORT,
    accessKey: typeof s.accessKey === "string" && /^[0-9a-f]{32}$/.test(s.accessKey) ? s.accessKey : "",
    mobileStatsBar: s.mobileStatsBar === true,
    devices: Array.isArray(s.devices) ? s.devices.filter(isDeviceRecord).slice(0, REMOTE_DEVICE_HISTORY_LIMIT) : [],
  };
}

/** Read-modify-write the remote section (sibling sections and unmentioned fields survive). */
export function writeRemoteConfig(patch: Partial<RemoteConfig>): RemoteConfig {
  const next = { ...readRemoteConfig(), ...patch };
  writeDesktopSection("remote", {
    enabled: next.enabled,
    port: next.port,
    accessKey: next.accessKey,
    mobileStatsBar: next.mobileStatsBar,
    devices: next.devices,
  });
  return next;
}

export function generateRemoteAccessKey(): string {
  return randomBytes(16).toString("hex"); // 128-bit hex (spec §3.1)
}

/** First non-internal IPv4, for the settings page's copy-link URL; undefined when off-LAN. */
function lanIpv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return undefined;
}

/** Settings-frame projection of the remote section (spec §3.1; key field named "key" per wire contract). */
export function remotePayload(): { enabled: boolean; port: number; key: string; mobileStatsBar: boolean; url?: string; devices?: RemoteDeviceRecord[] } {
  const cfg = readRemoteConfig();
  const ip = lanIpv4();
  return {
    enabled: cfg.enabled,
    port: cfg.port,
    key: cfg.accessKey,
    mobileStatsBar: cfg.mobileStatsBar,
    ...(ip && cfg.accessKey ? { url: `http://${ip}:${cfg.port}/?t=${cfg.accessKey}` } : {}),
    ...(cfg.devices.length ? { devices: cfg.devices } : {}),
  };
}

// ---------- server lifecycle ----------

interface RemoteWsData {
  remote: boolean;
  /** Peer identity captured at upgrade; consumed by the shared open handler */
  meta?: { ua: string; ip: string };
}

let srv: Bun.Server<RemoteWsData> | null = null;
let wsHandlers: Bun.WebSocketHandler<RemoteWsData> | null = null;

/** Injected by main.ts at startup (the shared open/message/close handlers; avoids a remote->rpc->remote import cycle). */
export function setRemoteWsHandlers(handlers: Bun.WebSocketHandler<RemoteWsData>): void {
  wsHandlers = handlers;
}

export function remoteStatus(): { enabled: boolean; port: number } {
  return { enabled: srv !== null, port: srv?.port ?? 0 };
}

/** Brand label from a User-Agent ("iPhone · Safari"); hand-rolled — brand words need no i18n. */
function deviceNameFromUa(ua: string): string {
  const os = /\(iPhone/.test(ua)
    ? "iPhone"
    : /\(iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /CriOS|Chrome\//.test(ua)
      ? "Chrome"
      : /FxiOS|Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return os && browser ? `${os} · ${browser}` : os || browser || "Unknown";
}

// Same-device reconnect storms (phone lock/unlock) must not rewrite history every time
const deviceSeenAt = new Map<string, number>();

/** Record an authenticated remote visit; true when history changed and settings should re-push. */
export function recordRemoteDevice(meta: { ua: string; ip: string }): boolean {
  const key = `${meta.ua}\n${meta.ip}`;
  const now = Date.now();
  if ((deviceSeenAt.get(key) ?? 0) > now - 60_000) return false;
  deviceSeenAt.set(key, now);
  const name = deviceNameFromUa(meta.ua);
  const devices = readRemoteConfig().devices.filter((d) => !(d.name === name && d.ip === meta.ip));
  devices.unshift({ name, ip: meta.ip, lastAt: now });
  writeRemoteConfig({ devices: devices.slice(0, REMOTE_DEVICE_HISTORY_LIMIT) });
  return true;
}

/**
 * Start (or rebind) the remote server on `port`. The new listener is bound
 * BEFORE the old one stops, so a bind failure (e.g. EADDRINUSE) leaves the
 * previous server untouched (spec §3.2: failure returns error, state kept).
 */
export function startRemoteServer(port: number): { ok: boolean; port?: number; error?: string } {
  if (!wsHandlers) return { ok: false, error: "remote ws handlers not wired" };
  if (srv && srv.port === port) return { ok: true, port: srv.port };
  let next: Bun.Server<RemoteWsData>;
  try {
    next = Bun.serve<RemoteWsData>({ port, hostname: "0.0.0.0", fetch: remoteFetch, websocket: wsHandlers });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const prev = srv;
  srv = next;
  prev?.stop(true);
  safeStderr(`[remote] listening port=${next.port}\n`);
  return { ok: true, port: next.port };
}

export function stopRemoteServer(): void {
  if (!srv) return;
  srv.stop(true);
  srv = null;
  safeStderr("[remote] stopped\n");
}

// ---------- fetch behavior (spec §3.3) ----------

function remoteFetch(req: Request, server: Bun.Server<RemoteWsData>): Response | undefined {
  const url = new URL(req.url);
  if (url.pathname === "/ws" && (req.headers.get("upgrade")?.toLowerCase() ?? "") === "websocket") {
    if (!tokenOk(url.searchParams.get("t"))) return new Response("unauthorized", { status: 401 });
    // Peer identity travels with the socket: the open handler (ws-shared) turns it into history
    server.upgrade(req, {
      data: { remote: true, meta: { ua: req.headers.get("user-agent") ?? "", ip: server.requestIP(req)?.address ?? "" } },
    });
    return;
  }
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  return serveStatic(url.pathname);
}

/** Constant-time compare against remote.accessKey; fail closed on missing key/token. */
function tokenOk(t: string | null): boolean {
  const key = readRemoteConfig().accessKey;
  if (!t || !key) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Static root (spec §3.3): the compiled single-file build keeps import.meta.dir inside Bun's
 * embedded virtual root — "/$bunfs/root" on POSIX, "B:\~BUN\root" on Windows, and the POSIX
 * spelling itself became "/$$bunfs/root" in newer Bun — so no string test on it is a stable
 * discriminator, and the dist ships next to the executable instead (tauri.windows|macos
 * .conf.json maps ../ui/dist to ui/dist in the bundle). Dev layout = <repo>/ui/dist, probed
 * by existence; the bundle case is the fallback.
 */
function staticRoot(): string {
  const besideExec = join(dirname(process.execPath), "ui", "dist");
  if (existsSync(besideExec)) return besideExec;
  return join(import.meta.dir, "..", "ui", "dist");
}

function serveStatic(pathname: string): Response {
  const root = staticRoot();
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  // "/" maps to index.html; join keeps a trailing slash otherwise ("/" alone would resolve to the dist dir)
  const target = normalize(join(root, rel === "/" ? "index.html" : rel));
  // Normalized escape out of dist (path traversal) -> 400
  if (target !== root && !target.startsWith(root + sep)) return new Response("bad path", { status: 400 });
  if (!existsSync(target)) return new Response("not found", { status: 404 });
  // index.html names the hashed asset files, so a cached copy pins the phone to an old
  // build: after reinstalling the UI the client kept running the previous JS/CSS and
  // looked like the fix "did not work". Assets carry a content hash and stay cacheable.
  const noStore = target.endsWith(".html");
  return new Response(Bun.file(target), noStore ? { headers: { "Cache-Control": "no-store" } } : undefined);
}
