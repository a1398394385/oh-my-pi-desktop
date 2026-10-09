#!/usr/bin/env bun
// Version SSOT: src-tauri/tauri.conf.json#version is the single source; Cargo.toml#version is
// mirrored from it. The Tauri bundler refuses to build when the two drift, and the updater
// compares the version baked into the app against the one on the release manifest, so a stale
// Cargo.toml silently ships a build that either fails to bundle or offers the same update twice.
//
//   bun scripts/sync-version.ts            # mirror Cargo.toml to the tauri.conf.json version
//   bun scripts/sync-version.ts --check    # verify only (wired into `bun run check`)
//   bun scripts/sync-version.ts 0.2.0      # set the version everywhere, then mirror
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const confPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
const cargoPath = path.join(repoRoot, "src-tauri", "Cargo.toml");

// Tauri's updater compares SemVer; a non-SemVer value makes every install look like an update
// (or none). Kept deliberately narrow: digits and dots only, no prerelease/build metadata.
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}

async function readVersionFromConf(): Promise<string> {
	const conf = JSON.parse(await fs.readFile(confPath, "utf8")) as { version?: string };
	if (typeof conf.version !== "string" || conf.version.length === 0) fail("src-tauri/tauri.conf.json 缺少 version");
	return conf.version;
}

async function writeVersionToConf(version: string): Promise<void> {
	const raw = await fs.readFile(confPath, "utf8");
	const next = raw.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`);
	if (next === raw && !raw.includes(`"version": "${version}"`)) fail("未能定位 src-tauri/tauri.conf.json 的 version 字段");
	await fs.writeFile(confPath, next, "utf8");
}

async function readVersionFromCargo(): string {
	const cargo = await fs.readFile(cargoPath, "utf8");
	const match = /^version = "([^"]+)"/m.exec(cargo);
	if (!match) fail("src-tauri/Cargo.toml 缺少顶层 version");
	return match[1];
}

async function writeVersionToCargo(version: string): Promise<void> {
	const cargo = await fs.readFile(cargoPath, "utf8");
	const next = cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`);
	if (next === cargo && !cargo.includes(`version = "${version}"`)) fail("未能定位 src-tauri/Cargo.toml 的 version 字段");
	await fs.writeFile(cargoPath, next, "utf8");
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const explicit = args.find((a) => !a.startsWith("--"));

if (explicit !== undefined) {
	if (!SEMVER_RE.test(explicit)) fail(`版本号必须是 x.y.z 形式的 SemVer，收到：${explicit}`);
	await writeVersionToConf(explicit);
	console.log(`版本号已设为 ${explicit}`);
}

const confVersion = await readVersionFromConf();
if (!SEMVER_RE.test(confVersion)) fail(`src-tauri/tauri.conf.json 的 version 不是 x.y.z 形式的 SemVer：${confVersion}`);

const cargoVersion = await readVersionFromCargo();
if (checkOnly) {
	if (cargoVersion !== confVersion) {
		fail(`版本号漂移：tauri.conf.json=${confVersion}、Cargo.toml=${cargoVersion}。修复：bun scripts/sync-version.ts`);
	}
	console.log(`✓ 版本号一致：${confVersion}`);
} else {
	if (cargoVersion !== confVersion) {
		await writeVersionToCargo(confVersion);
		console.log(`✓ 已同步 Cargo.toml → ${confVersion}（原 ${cargoVersion}）`);
	} else {
		console.log(`✓ 版本号一致：${confVersion}`);
	}
}