#!/usr/bin/env bun
// Build orchestration for omp-host.exe: embed the .node files of @oh-my-pi/pi-natives as one zstd
// frame each (the manifest protocol the loader has required since 18.10.0, mirrored from upstream
// packages/natives/scripts/embed-native.ts), which the loader unpacks to ~/.omp/natives/<version>/ at runtime. In the npm-published pi-natives,
// embedded-addon.js is a null stub (the embed flow only exists in the upstream source repo), so a plain bun build --compile
// produces an exe without the native addon, guaranteed to fail on a clean machine.
// Flow copied from upstream ci-release-build-utils: embed -> compile -> reset (reset in finally,
// so a failed compile leaves no non-stub embedded-addon.js behind that would misclassify dev mode as compiled).
// The compile step also wipes host-dist first: the Tauri bundle maps the whole host-dist directory
// into Contents/Resources, so any leftover file there (e.g. a hand-copied pi_natives.*.node from an
// older base version — the addon actually ships embedded inside the exe, see above) is packaged into
// the .app and the updater artifact as dead weight. Measured on this repo: two such leftovers
// inflated the .app from 148 MB to 465 MB and the updater tar.gz from 79 MB to 153 MB.
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Build-time helper from the installed base package (patched for npm layouts, see
// patches/@oh-my-pi%2Fpi-coding-agent*.patch): materializes the legacy Pi virtual module.
import { createLegacyPiVirtualModulePlugin } from "../node_modules/@oh-my-pi/pi-coding-agent/scripts/legacy-pi-virtual-module.ts";
// Version-identity check, mirrored from @oh-my-pi/pi-natives native/version-sentinel.js
// (as of 18.5.0). Deliberately inlined instead of deep-imported: that file ships in the
// npm package but is not exposed via package `exports`, and upstream renames its helpers
// between releases (per-release sentinel -> post-link stamp in 18.5.0), which broke the
// deep import at Bun's link time when the base version was bumped (BUG-036). If the
// check below fails right after a base upgrade, re-mirror from the installed
// version-sentinel.js of the new version.
const VERSION_STAMP_MAGIC = "PI_NATIVES_VERSION_STAMP:";

// True when addon bytes identify themselves as exactly `version`: the post-link stamp
// slot for current addons, or the pre-stamp legacy sentinel export name.
function addonBytesMatchVersion(bytes: Buffer, version: string): boolean {
	if (version.length === 0) return false;
	// Current addons: fixed-size stamp slot "PI_NATIVES_VERSION_STAMP:<version>\0" written after linking.
	if (bytes.indexOf(`${VERSION_STAMP_MAGIC}${version}\0`, 0, "utf8") !== -1) return true;
	// Pre-stamp addons: exact `__piNativesV18_5_0` export (a longer name must not match).
	const needle = `__piNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`;
	for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) {
		const next = bytes[at + needle.length];
		const continues =
			next !== undefined &&
			((next >= 0x30 && next <= 0x39) || (next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a) || next === 0x5f);
		if (!continues) return true;
	}
	return false;
}

const repoRoot = path.join(import.meta.dir, "..");
const nativesPkgDir = path.join(repoRoot, "node_modules", "@oh-my-pi", "pi-natives");
const nativeDir = path.join(nativesPkgDir, "native");
const leafPkgDir = path.join(repoRoot, "node_modules", "@oh-my-pi", `pi-natives-${process.platform}-${process.arch}`);
const embeddedAddonPath = path.join(nativeDir, "embedded-addon.js");
const platformTag = `${process.platform}-${process.arch}`;
// Mirrors upstream EMBEDDED_ADDON_ZSTD_LEVEL: each addon is its own frame with no timestamp, so
// identical addon bytes embed identically across builds.
const EMBEDDED_ADDON_ZSTD_LEVEL = 19;
const version = (JSON.parse(await Bun.file(path.join(nativesPkgDir, "package.json")).text())).version as string;
// Prompt mirrors: host/prompts/*.md are verbatim copies of the SDK's approval
// prompts, inlined into the exe via bunfig's text loader (host/bootstrap.ts
// readSdkPrompt — the standalone exe cannot read SDK files at runtime). Every
// build verifies the mirrors match the installed SDK, so a base upgrade cannot
// silently ship stale approval wording; run with --sync-prompts to refresh.
const codingAgentPkgDir = path.join(repoRoot, "node_modules", "@oh-my-pi", "pi-coding-agent");
const sdkPromptsDir = path.join(codingAgentPkgDir, "src", "prompts", "system");
const mirrorDir = path.join(repoRoot, "host", "prompts");
const promptMirrors = ["plan-mode-approved.md", "plan-mode-compact-instructions.md"] as const;

if (process.argv.includes("--sync-prompts")) {
	for (const file of promptMirrors) {
		await fs.copyFile(path.join(sdkPromptsDir, file), path.join(mirrorDir, file));
	}
	console.log(`已同步 ${promptMirrors.length} 个 prompt 镜像到 host/prompts/`);
	process.exit(0);
}

async function verifyPromptMirrors(): Promise<void> {
	const stale: string[] = [];
	for (const file of promptMirrors) {
		if ((await Bun.file(path.join(mirrorDir, file)).text()) !== (await Bun.file(path.join(sdkPromptsDir, file)).text())) stale.push(file);
	}
	if (stale.length > 0) {
		throw new Error(
			`host/prompts 镜像与已安装 SDK 不一致：${stale.join("、")}。底座升级后请运行 bun run host:sync-prompts 重新镜像`,
		);
	}
}

const candidates =
	process.arch === "x64"
		? [
				{ variant: "modern", filename: `pi_natives.${platformTag}-modern.node` },
				{ variant: "baseline", filename: `pi_natives.${platformTag}-baseline.node` },
			]
		: [{ variant: "default", filename: `pi_natives.${platformTag}.node` }];

async function resetEmbeddedAddon(): Promise<void> {
	await Bun.write(
		embeddedAddonPath,
		"// AUTOGENERATED FILE -- DO NOT EDIT DIRECTLY\n// See scripts/build-host.ts\n\n/** @type {null} */\nexport const embeddedAddon = null;\n",
	);
	for (const { filename } of candidates) {
		await fs.rm(path.join(nativeDir, `${filename}.zst`), { force: true });
	}
}

async function embedNativeAddon(): Promise<void> {
	await resetEmbeddedAddon();
	const available: Array<{ variant: string; filename: string; bytes: Buffer }> = [];
	for (const { variant, filename } of candidates) {
		const sourcePath = path.join(leafPkgDir, filename);
		if (!(await Bun.file(sourcePath).exists())) continue;
		// Must be a Node Buffer: Buffer.indexOf supports substring search, Uint8Array.indexOf only matches a single byte
		const bytes = await fs.readFile(sourcePath);
		if (!addonBytesMatchVersion(bytes, version)) {
			throw new Error(
				`${sourcePath} 不含 @oh-my-pi/pi-natives@${version} 版本标识（stamp / legacy sentinel），依赖版本不一致，请重装依赖；若刚升级底座版本，按 scripts/build-host.ts 头部注释重新镜像版本校验逻辑`,
			);
		}
		available.push({ variant, filename, bytes });
	}
	if (available.length === 0) {
		throw new Error(`${leafPkgDir} 下没有任何 native addon（期望 ${candidates.map(c => c.filename).join(" 或 ")}）`);
	}
	const imports: string[] = [];
	const fileEntries: string[] = [];
	let embeddedBytes = 0;
	for (const [index, { variant, filename, bytes }] of available.entries()) {
		// The loader decompresses each frame with Bun.zstdDecompressSync and checks the byte
		// length against `size`, so the frame must carry the raw addon bytes unmodified.
		const frame = await Bun.zstdCompress(bytes, { level: EMBEDDED_ADDON_ZSTD_LEVEL });
		embeddedBytes += frame.length;
		await Bun.write(path.join(nativeDir, `${filename}.zst`), frame);
		imports.push(`import zstdPath${index} from ${JSON.stringify(`./${filename}.zst`)} with { type: "file" };`);
		fileEntries.push(
			`\t\t{ variant: ${JSON.stringify(variant)}, filename: ${JSON.stringify(filename)}, size: ${bytes.length}, zstdPath: zstdPath${index} },`,
		);
	}
	await Bun.write(
		embeddedAddonPath,
		`// AUTOGENERATED FILE -- DO NOT EDIT DIRECTLY\n// See scripts/build-host.ts\n\n${imports.join("\n")}\n\nexport const embeddedAddon = {\n\tplatformTag: ${JSON.stringify(platformTag)},\n\tversion: ${JSON.stringify(version)},\n\tfiles: [\n${fileEntries.join("\n")}\n\t],\n};\n`,
	);
	console.log(
		`已内嵌 native addon：${available.length} 个变体，zstd 帧共 ${(embeddedBytes / 1024 / 1024).toFixed(1)} MB`,
	);
}

// Wipe host-dist before compiling so only the fresh omp-host artifact survives into the
// Tauri bundle (see the header note on bundle bloat). Scoped to host-dist, which is
// gitignored and holds build output only — nothing hand-written lives there.
const hostDistDir = path.join(repoRoot, "host-dist");
await fs.rm(hostDistDir, { recursive: true, force: true });

await verifyPromptMirrors();
await embedNativeAddon();
try {
	// The base's legacy-pi compat layer dynamically imports the "omp-legacy-pi-modules"
	// virtual module; the build plugin materializes its lazy loader registry in memory.
	// Without it the compiled exe cannot load any legacy-style plugin extension
	// (e.g. ponytail) — USE_BUNDLED_PI_MODULES is always true in a compiled binary,
	// so `--external` there meant a guaranteed runtime failure (BUG-059).
	const build = await Bun.build({
		entrypoints: [path.join(repoRoot, "host/host.ts")],
		minify: true,
		plugins: [await createLegacyPiVirtualModulePlugin()],
		compile: { outfile: path.join(hostDistDir, "omp-host.exe") },
	});
	if (!build.success) {
		for (const message of build.logs) console.error(message);
		process.exitCode = 1;
	}
} finally {
	await resetEmbeddedAddon();
}
