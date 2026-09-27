// 定向验证：编译产物 omp-host 以 `__omp_worker_*` 选择器运行时必须分发为真 worker，
// 不再落成完整桌面宿主（BUG-011 回归验证）。覆盖 daemon broker / blob broker / lsp mux
// 三个子进程形态 broker；js_eval 走同一 resolveWorkerSpawnCmd 路径，分发层等价。
// 用法：OMP_PROFILE=omp-desktop-test bun scripts/smoke-worker-dispatch.ts [产物路径]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const hostBin = process.argv[2] ?? path.join(import.meta.dir, "..", "host-dist", "omp-host.exe");
if (!fs.existsSync(hostBin)) throw new Error(`编译产物不存在: ${hostBin}`);

function spawnWorker(arg: string, env: Record<string, string>) {
	return Bun.spawn([hostBin, arg], {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
}

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
	try {
		await fn();
		console.log(`✓ ${name}`);
	} catch (err) {
		failures.push(name);
		console.error(`✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function waitUntil(deadlineMs: number, probe: () => Promise<boolean>): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (await probe()) return true;
		await Bun.sleep(200);
	}
	return false;
}

// 宿主形态的标志：stdout 首行 READY ws://（修复前 worker 参数被无视，整个桌面宿主启动）
async function assertNotHost(stdout: ReadableStream<Uint8Array>, label: string) {
	const reader = stdout.getReader();
	const { value } = await reader.read();
	const text = new TextDecoder().decode(value ?? new Uint8Array());
	reader.cancel();
	if (/READY ws:\/\//.test(text)) {
		throw new Error(`${label} 落成了完整桌面宿主（stdout 出现 READY 行）`);
	}
}

await check("daemon broker：分发为真 broker（scope.json + 无宿主 READY + 空闲自退）", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dispatch-daemon-"));
	const runtimeDir = path.join(root, "run");
	fs.mkdirSync(runtimeDir, { recursive: true });
	fs.writeFileSync(path.join(runtimeDir, "broker.token"), "smoke-token-not-a-secret");
	const proc = spawnWorker("__omp_worker_daemon_broker", {
		OMP_DAEMON_PROJECT_DIR: path.join(root, "project"),
		OMP_DAEMON_RUNTIME_DIR: runtimeDir,
		OMP_DAEMON_IDLE_GRACE: "3000",
	});
	const exited = waitUntil(20_000, async () => {
		const scope = path.join(runtimeDir, "scope.json");
		return fs.existsSync(scope) && fs.statSync(scope).size > 0;
	});
	await assertNotHost(proc.stdout, "daemon broker");
	if (!(await exited)) throw new Error("runtime 目录未出现 scope.json（broker 语义未生效）");
	// 空闲宽限后 broker 必须自退（修复前永不退出）
	const reaped = await waitUntil(15_000, async () => await proc.exited !== undefined ? true : false);
	if (!reaped) {
		proc.kill();
		throw new Error("broker 未在空闲宽限后退出（宿主泄漏形态）");
	}
	fs.rmSync(root, { recursive: true, force: true });
});

await check("blob broker：分发为真 broker（socket 出现 + 无宿主 READY）", async () => {
	const socket = path.join(os.tmpdir(), `omp-dispatch-blob-${process.pid.toString(36)}.sock`);
	const proc = spawnWorker("__omp_worker_blob_broker", {
		OMP_BLOB_BROKER_SOCKET: socket,
		OMP_BLOB_BROKER_CONFIG: JSON.stringify({ kind: "direct", options: {}, credentials: {}, bindHost: "127.0.0.1" }),
	});
	await assertNotHost(proc.stdout, "blob broker");
	const up = await waitUntil(20_000, async () => fs.existsSync(socket));
	if (!up) {
		proc.kill();
		throw new Error("blob broker socket 未出现");
	}
	proc.kill();
});

await check("lsp mux：分发为真 mux（socket 出现 + 无宿主 READY）", async () => {
	const socket = path.join(os.tmpdir(), `omp-dispatch-lsp-${process.pid.toString(36)}.sock`);
	const proc = spawnWorker("__omp_worker_lsp_mux", {
		OMP_LSP_MUX_SOCKET: socket,
		OMP_LSP_MUX_PROJECT_DIR: process.cwd(),
	});
	await assertNotHost(proc.stdout, "lsp mux");
	const up = await waitUntil(20_000, async () => fs.existsSync(socket));
	if (!up) {
		proc.kill();
		throw new Error("lsp mux socket 未出现");
	}
	proc.kill();
});

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败：${failures.join("、")}`);
	process.exit(1);
}
console.log("\nworker 分发验证全部通过");
