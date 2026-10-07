// SSH domain RPCs: manage OMP user-scope SSH hosts (ssh.json) and create
// remote-workspace stubs. Host CRUD mirrors the base's `omp ssh` CLI
// (add/update/remove over the same file, capability caches reset after
// mutations so live sessions re-read ssh.json on the next ssh:// resolve).
// add_remote_workspace validates the remote path over a real SSH probe before
// materializing the local stub (host/remote-workspaces.ts).
import { getSSHConfigPath } from "@oh-my-pi/pi-utils";
import {
  readSSHConfigFile,
  addSSHHost,
  updateSSHHost,
  removeSSHHost,
  validateHostName,
  resetCapabilities,
  clearCapabilityFsCache,
  buildSshTarget,
  quotePosixPath,
} from "../bootstrap.ts";
import { ensureRemoteWorkspaceDir, normalizeRemotePath, readUserSshHost } from "../remote-workspaces.ts";
import { safeStderr } from "../stderr.ts";
import { hostI18n } from "../../ui-src/i18n/host.ts";
import type { RpcHandler } from "./types";

export interface SshHostConfigShape {
  host: string;
  username?: string;
  port?: number;
  keyPath?: string;
  description?: string;
  compat?: boolean;
}

function userSshJsonPath(): string {
  return getSSHConfigPath("user");
}

/** Read the user-scope host table as an ordered array (ssh.json key order). */
async function listUserHosts(): Promise<Array<SshHostConfigShape & { name: string }>> {
  const config = await readSSHConfigFile(userSshJsonPath());
  return Object.entries(config.hosts ?? {}).map(([name, host]) => ({ name, ...host }));
}

async function sendHostList(ws: { send(data: string): unknown }): Promise<void> {
  ws.send(JSON.stringify({ type: "ssh_hosts", hosts: await listUserHosts() }));
}

/** Reset the base's discovery caches after an ssh.json mutation (mirrors /ssh). */
function invalidateSshCaches(): void {
  resetCapabilities();
  clearCapabilityFsCache();
}

// Longest error we surface in a frame (the rest is only interesting in the host log).
const MAX_ERROR_CHARS = 3000;

/**
 * Windows OpenSSH escapes every non-ASCII byte of a message as literal
 * `\NNN` octal (mprintf keeps diagnostics ASCII-safe). Left as-is the user sees
 * `\350\202\226...` instead of their CJK username. Re-encode the escape runs
 * back to bytes so the original UTF-8 text survives the round trip.
 *
 * The run matters: one CJK glyph is 3 escaped bytes, and decoding them one at a
 * time fails (a continuation byte alone is not valid UTF-8). NUL bytes are
 * dropped — they are password-prompt padding, not content.
 */
function decodeSshOctalEscapes(text: string): string {
  if (!text.includes("\\")) return text;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  return text.replace(/(?:\\[0-7]{1,3})+/g, (run) => {
    const bytes: number[] = [];
    for (const octal of run.slice(1).split("\\")) bytes.push(Number.parseInt(octal, 8));
    try {
      return utf8.decode(Uint8Array.from(bytes)).replace(/\0/g, "");
    } catch {
      // Not valid UTF-8 on its own (a lone escape): keep the literal text.
      return run;
    }
  });
}

/** Tidy an ssh diagnostic for display: octal escapes decoded, CRLF folded, tail-capped. */
export function formatSshError(stderr: string, stdout: string, code: number | null): string {
  const raw = stderr.trim() || stdout.trim() || `exit ${code ?? "killed"}`;
  const text = decodeSshOctalEscapes(raw).replace(/\r\n/g, "\n").trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}\n…` : text;
}

/**
 * Run one SSH command against a host config. BatchMode keeps failures
 * non-interactive (no password prompts hanging the RPC); accept-new records
 * first-seen host keys instead of blocking. Returns exit code, stdout, stderr.
 */
export async function runSshCommand(host: SshHostConfigShape, command: string, timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.min(10, Math.ceil(timeoutMs / 1000))}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    ...(host.port ? ["-p", String(host.port)] : []),
    ...(host.keyPath ? ["-i", host.keyPath] : []),
    buildSshTarget(host.username, host.host),
    command,
  ];
  const proc = Bun.spawn(["ssh", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
/**
 * Resolve an RPC target: by saved alias (msg.name), or from inline form fields
 * (host required, username/port/keyPath optional). Shared by the probe and the
 * directory listing so both accept the same message shape.
 */
async function resolveHostConfig(msg: Record<string, unknown>): Promise<{ name: string | null; config: SshHostConfigShape }> {
  const name = typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : null;
  if (name) {
    const config = await readUserSshHost(name);
    if (!config) throw new Error(hostI18n.t("errors.ssh.hostNotFound", { name }));
    return { name, config };
  }
  const host = String(msg.host ?? "").trim();
  if (!host) throw new Error(hostI18n.t("errors.ssh.missingAddress"));
  const config: SshHostConfigShape = { host };
  const username = String(msg.username ?? "").trim();
  const keyPath = String(msg.keyPath ?? "").trim();
  if (username) config.username = username;
  if (msg.port !== undefined && msg.port !== null && msg.port !== "") config.port = Number(msg.port);
  if (keyPath) config.keyPath = keyPath;
  return { name, config };
}

export const sshHandlers: Record<string, RpcHandler> = {
  async ssh_list_hosts(ws) {
    await sendHostList(ws);
  },
  async ssh_save_host(ws, msg) {
    const name = String(msg.name ?? "").trim();
    if (!name) throw new Error(hostI18n.t("errors.ssh.missingName"));
    const nameError = validateHostName(name);
    if (nameError) throw new Error(hostI18n.t("errors.ssh.nameInvalid", { detail: nameError }));
    const address = String(msg.host ?? "").trim();
    if (!address) throw new Error(hostI18n.t("errors.ssh.missingAddress"));
    const port = msg.port === undefined || msg.port === null || msg.port === "" ? undefined : Number(msg.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error(hostI18n.t("errors.ssh.portInvalid"));
    }
    const config: SshHostConfigShape = { host: address };
    const username = String(msg.username ?? "").trim();
    const keyPath = String(msg.keyPath ?? "").trim();
    const description = String(msg.description ?? "").trim();
    if (username) config.username = username;
    if (port !== undefined) config.port = port;
    if (keyPath) config.keyPath = keyPath;
    if (description) config.description = description;
    if (msg.compat === true) config.compat = true;
    const filePath = userSshJsonPath();
    const existing = (await readSSHConfigFile(filePath)).hosts ?? {};
    if (existing[name]) await updateSSHHost(filePath, name, config);
    else await addSSHHost(filePath, name, config);
    invalidateSshCaches();
    await sendHostList(ws);
  },
  async ssh_remove_host(ws, msg) {
    const name = String(msg.name ?? "").trim();
    if (!name) throw new Error(hostI18n.t("errors.ssh.missingName"));
    await removeSSHHost(userSshJsonPath(), name);
    invalidateSshCaches();
    await sendHostList(ws);
  },
  async ssh_test_host(ws, msg) {
    const { name, config } = await resolveHostConfig(msg);
    const startedAt = Date.now();
    const result = await runSshCommand(config, "echo PI_SSH_OK");
    const latencyMs = Date.now() - startedAt;
    const ok = result.code === 0 && result.stdout.trim() === "PI_SSH_OK";
    if (!ok) {
      // The frame caps the error for the dialog; the untruncated diagnostic
      // (which is what a bug report needs) only lives in the host log.
      const full = decodeSshOctalEscapes(result.stderr || result.stdout).replace(/\r\n/g, "\n").trim();
      safeStderr(`[host] SSH 探测失败 ${buildSshTarget(config.username, config.host)} (exit ${result.code ?? "killed"}):\n${full}\n`);
    }
    ws.send(
      JSON.stringify({
        type: "ssh_test_result",
        name,
        ok,
        latencyMs,
        ...(ok ? {} : { error: formatSshError(result.stderr, result.stdout, result.code) }),
      }),
    );
  },
  // Remote directory listing for the workspace-path picker: `ls -1ap` prints one
  // name per line with a trailing "/" on directories. Failure (missing dir, no
  // perms) replies ok:false — the picker closes silently, the user keeps typing.
  async ssh_list_dirs(ws, msg) {
    const base = normalizeRemotePath(msg.path);
    if (!base) {
      ws.send(JSON.stringify({ type: "ssh_dirs", ok: false, path: String(msg.path ?? "") }));
      return;
    }
    const { config } = await resolveHostConfig(msg);
    const result = await runSshCommand(config, `ls -1ap ${quotePosixPath(base)}`, 8_000);
    const dirs =
      result.code === 0
        ? result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.endsWith("/") && line !== "./" && line !== "../")
            .map((line) => line.slice(0, -1))
            .filter((name) => name.length > 0)
            .slice(0, 200)
        : undefined;
    ws.send(
      JSON.stringify({
        type: "ssh_dirs",
        ok: result.code === 0,
        path: base,
        ...(dirs ? { dirs } : { error: formatSshError(result.stderr, result.stdout, result.code) }),
      }),
    );
  },
  async add_remote_workspace(ws, msg) {
    const name = String(msg.host ?? "").trim();
    if (!name) throw new Error(hostI18n.t("errors.ssh.missingName"));
    const config = await readUserSshHost(name);
    if (!config) throw new Error(hostI18n.t("errors.ssh.hostNotFound", { name }));
    const remotePath = normalizeRemotePath(msg.remotePath);
    if (!remotePath) throw new Error(hostI18n.t("errors.ssh.invalidPath", { path: String(msg.remotePath ?? "") }));
    // Probe before materializing: the stub must not exist for a path that
    // is unreachable or not a directory. Failure replies ok:false (dialog
    // state machine) instead of an error frame.
    const probe = await runSshCommand(config, `if [ -d ${quotePosixPath(remotePath)} ]; then echo PI_DIR_OK; else echo PI_DIR_MISSING; fi`);
    if (probe.code !== 0) {
      ws.send(
        JSON.stringify({
          type: "remote_workspace_added",
          ok: false,
          error: hostI18n.t("errors.ssh.unreachable", { detail: formatSshError(probe.stderr, probe.stdout, probe.code) }),
        }),
      );
      return;
    }
    if (probe.stdout.trim() !== "PI_DIR_OK") {
      ws.send(JSON.stringify({ type: "remote_workspace_added", ok: false, error: hostI18n.t("errors.ssh.dirMissing", { path: remotePath }) }));
      return;
    }
    const cwd = await ensureRemoteWorkspaceDir(name, remotePath);
    ws.send(JSON.stringify({ type: "remote_workspace_added", ok: true, cwd, host: name, remotePath }));
  },
};
