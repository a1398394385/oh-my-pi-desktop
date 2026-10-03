#!/usr/bin/env node
// Link-time guard for @oh-my-pi/* base upgrades: dry-bundles the entry points whose
// import graphs reach into @oh-my-pi packages. `bun build` resolves imports and
// validates named exports WITHOUT executing anything, so a renamed export or a removed
// sub-path export (e.g. `@oh-my-pi/pi-tui/chat/transcript-entry`) fails HERE with a
// precise message, instead of at host:build / tauri build / app startup.
// Failure mode this was built for: BUG-036 (18.5.0 renamed version-sentinel helpers;
// host:build died at Bun's link time with "Export named ... not found").
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Entry points that reach @oh-my-pi modules:
// - host/host.ts covers the whole runtime graph (host/ + ui-src/i18n host bridge),
//   including every sub-path exports dependency in host/*.ts;
// - scripts/build-host.ts covers the build tool itself.
const entries = ["host/host.ts", "scripts/build-host.ts"];

let failed = false;
for (const entry of entries) {
	const tmp = mkdtempSync(path.join(tmpdir(), "omp-check-imports-"));
	// Same external as scripts/build-host.ts: optional runtime dynamic import inside
	// pi-coding-agent's legacy plugin compat layer; an absent module is a handled fallback.
	const build = spawnSync("bun", ["build", "--target=bun", "--external", "omp-legacy-pi-modules", entry, "--outdir", tmp], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	rmSync(tmp, { recursive: true, force: true });
	if (build.status !== 0) {
		failed = true;
		console.error(`[check-omp-imports] ${entry} 打包失败——底座依赖的导出或子路径已变更:`);
		console.error((build.stderr || build.stdout || "(no output)").trim());
	}
}
if (failed) {
	console.error("[check-omp-imports] 刚升级过 @oh-my-pi/* 的话，请按上方报错同步本仓调用点后重跑 bun run check");
	process.exit(1);
}
console.log(`[check-omp-imports] ${entries.length} 个入口链接校验通过`);
