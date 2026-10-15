// Regression smoke for computer.display reconciliation (host/computer-display.ts).
//
// computer.display persists the raw Win32 monitor handle that the base's capture
// path uses as a display id (xcap Monitor::id() = HMONITOR from
// EnumDisplayMonitors). The kernel reassigns that handle on every boot, so a
// value that resolved yesterday names nothing today and the base hard-fails with
// `InvalidTarget: selected display '<id>' is not active` until the user re-picks.
// The desktop remembers the picked monitor by EDID name + geometry
// (omp-desktop.json's computerDisplay section) and re-points computer.display at
// its current id on every profile apply.
//
// Phases (each boots a real host against the isolated test profile):
//   A. stale id + remembered monitor  -> computer.display is re-pointed at that monitor's current id
//   B. valid id + no memory           -> the memory is (re)recorded, the value is left alone
//   C. stale id + no memory           -> nothing is written (never guess a substitute screen)
//
// Usage: OMP_PROFILE=omp-desktop-test bun scripts/smoke-computer-display.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createDesktopSession } from "@oh-my-pi/pi-natives/desktop";

process.env.OMP_PROFILE = "omp-desktop-test";
process.env.PI_PROFILE = "omp-desktop-test";

const profileDir = path.join(homedir(), ".omp", "profiles", "omp-desktop-test");
const cfgPath = path.join(profileDir, "agent", "config.yml");
const desktopPath = path.join(profileDir, "agent", "omp-desktop.json");

const failures: string[] = [];
const fail = (message: string): void => {
	failures.push(message);
	console.error(`  ✗ ${message}`);
};
const ok = (message: string): void => console.log(`  ✓ ${message}`);

// ---------- fixture plumbing (raw text backup, restored on every exit path) ----------
const backups: Array<{ file: string; text: string | null }> = [];
function stash(file: string): void {
	if (backups.some(entry => entry.file === file)) return;
	backups.push({ file, text: existsSync(file) ? readFileSync(file, "utf8") : null });
}
function restore(): void {
	for (const { file, text } of backups) {
		try {
			if (text === null) {
				if (existsSync(file)) unlinkSync(file);
			} else writeFileSync(file, text);
		} catch {}
	}
}
let child: ChildProcess | null = null;
function bounce(): void {
	if (!child?.pid) return;
	child.kill("SIGTERM");
	child = null;
}

/** Replace the top-level `computer:` block of the profile config with a fresh one (other keys stay untouched). */
function seedConfig(display: string): void {
	stash(cfgPath);
	const text = (existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "").replace(/^computer:\n(?:[ \t]+\S.*\n?)*/m, "");
	writeFileSync(cfgPath, `${text.trimEnd()}\ncomputer:\n  display: "${display}"\n`);
}

/** Seed (or clear) the remembered monitor in omp-desktop.json, leaving the rest of the file intact. */
function seedDesktopJson(hint: Record<string, unknown> | null): void {
	stash(desktopPath);
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(readFileSync(desktopPath, "utf8")) as Record<string, unknown>;
	} catch {}
	if (hint) raw.computerDisplay = hint;
	else delete raw.computerDisplay;
	writeFileSync(desktopPath, JSON.stringify(raw, null, 2));
}

const readConfigDisplay = (): string | null =>
	readFileSync(cfgPath, "utf8").match(/^computer:\n(?:[ \t]+\S.*\n?)*?[ \t]+display: "([^"]*)"/m)?.[1] ?? null;
const readRemembered = (): Record<string, unknown> | null => {
	try {
		const hit = (JSON.parse(readFileSync(desktopPath, "utf8")) as Record<string, unknown>).computerDisplay;
		return hit && typeof hit === "object" ? (hit as Record<string, unknown>) : null;
	} catch {
		return null;
	}
};

/** Boot the host and wait for readiness (the reconcile runs inside profileReady, so callers poll the files). */
async function startHost(): Promise<string> {
	const c = spawn("bun", ["host/host.ts"], {
		cwd: Bun.fileURLToPath(new URL("..", import.meta.url)),
		env: { ...process.env },
		stdio: ["ignore", "pipe", "inherit"],
	});
	child = c;
	return await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("host not ready within 60s")), 60_000);
		c.stdout!.setEncoding("utf8");
		c.stdout!.on("data", (chunk: string) => {
			const hit = chunk.match(/READY (ws:\/\/\S+)/);
			if (!hit) return;
			clearTimeout(timer);
			resolve(hit[1]);
		});
		c.on("exit", code => reject(new Error(`host exited early (code=${code})`)));
	});
}

/** The display dropdown's own RPC path (list_displays), so the shared enumeration is covered end to end. */
async function requestDisplays(wsUrl: string): Promise<Array<{ id: string; name: string }>> {
	const ws = new WebSocket(wsUrl);
	const frame = await new Promise<{ displays?: Array<{ id: string; name: string }>; error?: string | null }>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("list_displays timed out")), 20_000);
		ws.onopen = () => ws.send(JSON.stringify({ type: "list_displays" }));
		ws.onmessage = event => {
			const msg = JSON.parse(String(event.data));
			if (msg.type !== "displays") return;
			clearTimeout(timer);
			resolve(msg);
		};
		ws.onerror = () => reject(new Error("ws error"));
	});
	ws.close();
	if (frame.error) throw new Error(`list_displays error: ${frame.error}`);
	return frame.displays ?? [];
}

/** Poll until `check` returns a value (profileReady is async and unobserved by the READY line). */
async function settle<T>(check: () => T | null, timeoutMs = 20_000): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const hit = check();
		if (hit !== null) return hit;
		if (Date.now() > deadline) return null;
		await Bun.sleep(200);
	}
}

// ---------- fixture: what the machine actually reports right now ----------
const probe = createDesktopSession({});
const displays = (await probe.listDisplays()).map(d => ({
	id: String(d.id),
	name: String(d.name ?? d.id),
	width: d.width,
	height: d.height,
	isPrimary: !!d.isPrimary,
}));
await probe.close().catch(() => {});
if (displays.length === 0) {
	console.log("computer display smoke: SKIPPED (no physical display enumerated)");
	process.exit(0);
}
const target = displays[0];
// A value that cannot name any current display: what a previous boot's handle looks like today.
let stale = 2_000_000_000;
while (displays.some(d => d.id === String(stale))) stale++;
console.log(`computer display smoke: target=${target.name} id=${target.id} stale=${stale}`);

try {
	bounce();

	// ---------- Phase A: the boot bug ----------
	console.log("phase A: stale id + remembered monitor");
	seedConfig(String(stale));
	seedDesktopJson({
		name: target.name,
		width: target.width,
		height: target.height,
		isPrimary: target.isPrimary,
	});
	await startHost();
	const remapped = await settle(() => (readConfigDisplay() === target.id ? true : null));
	if (remapped) ok(`computer.display ${stale} → ${target.id}`);
	else fail(`computer.display not re-pointed (still ${readConfigDisplay()})`);
	const remembered = readRemembered();
	if (remembered?.name === target.name && remembered.width === target.width && remembered.height === target.height)
		ok("remembered monitor refreshed");
	else fail(`remembered monitor wrong: ${JSON.stringify(remembered)}`);
	bounce();

	// ---------- Phase B: a valid id only refreshes the memory ----------
	console.log("phase B: valid id + no memory");
	seedConfig(target.id);
	seedDesktopJson(null);
	await startHost();
	const learned = await settle(() => (readRemembered()?.name === target.name ? true : null));
	if (learned) ok("pick re-recorded on a resolving id");
	else fail(`memory not recorded: ${JSON.stringify(readRemembered())}`);
	if (readConfigDisplay() === target.id) ok("resolving value left alone");
	else fail(`resolving value rewritten to ${readConfigDisplay()}`);
	bounce();

	// ---------- Phase C: never guess ----------
	console.log("phase C: stale id + no memory");
	seedConfig(String(stale));
	seedDesktopJson(null);
	const wsUrl = await startHost();
	await settle(() => null, 5_000); // give the reconcile time to (wrongly) rewrite
	if (readConfigDisplay() === String(stale)) ok("no substitute screen picked");
	else fail(`guessed a substitute: ${readConfigDisplay()}`);

	// ---------- Phase D: the dropdown's own RPC still enumerates ----------
	console.log("phase D: list_displays over the wire");
	const viaRpc = await requestDisplays(wsUrl);
	const listed = viaRpc.find(d => d.id === target.id);
	if (listed) ok(`list_displays returns ${listed.name} as ${listed.id}`);
	else fail(`list_displays missing ${target.id}: ${JSON.stringify(viaRpc)}`);
} finally {
	bounce();
	await Bun.sleep(500); // let the host finish exiting before the fixture is restored
	restore();
}

if (failures.length > 0) {
	console.error(`\ncomputer display smoke: FAILED (${failures.length})`);
	process.exit(1);
}
console.log("computer display smoke: all checks passed");
