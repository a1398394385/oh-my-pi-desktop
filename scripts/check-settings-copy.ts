#!/usr/bin/env bun
// Settings-copy gate for the desktop settings page:
// 1. Parity — a key with a Chinese description must have an English one, and the
//    other way round. The settings page falls back to the base schema (English)
//    for anything the pack misses, so a one-sided entry shows one language's copy
//    next to the other's. Keys that never render as a schema row (hidden keys,
//    and the ones a page renders with its own control) are exempt.
// 2. No blank descriptions: an empty string renders an empty second line.
// 3. Length ceiling — a settings row is one line of helper text; a paragraph
//    belongs in a docs page, not in the row.
// 4. Ratchet — descriptions that only restate their own label (the mechanical
//    "Maximum number of X" style) must not increase. Baseline lives in
//    scripts/settings-copy-baseline.json; regenerate with --update.
//
// Usage: bun scripts/check-settings-copy.ts [--update]
import { readFileSync, writeFileSync } from "node:fs";
import { SETTINGS_ZH } from "../ui-src/i18n/locales/settings-zh-CN.ts";
import { SETTINGS_EN } from "../ui-src/i18n/locales/settings-en.ts";
import { HIDDEN_KEYS, SPECIAL_KEY_PAGES } from "../ui-src/components/settings/placement.ts";

const BASELINE_PATH = "scripts/settings-copy-baseline.json";
const MAX_ZH = 120;
const MAX_EN = 400;

const problems: string[] = [];
// Keys that never render through SchemaRows: hidden everywhere, or rendered by a
// page-specific control that carries its own copy.
const exempt = new Set([...Object.keys(HIDDEN_KEYS), ...Object.keys(SPECIAL_KEY_PAGES)]);
// Rows whose copy is a dense enumeration of several modes; long on purpose.
const dense = new Set(["tools.xdev", "providers.openai-codex.codeMode"]);

// ---- 1. parity -----------------------------------------------------------------
for (const [key, zh] of Object.entries(SETTINGS_ZH)) {
	if (exempt.has(key)) continue;
	const en = SETTINGS_EN[key];
	if (zh.description && !en?.description) problems.push(`${key}: 中文有描述，英文缺失`);
}
for (const [key, en] of Object.entries(SETTINGS_EN)) {
	if (exempt.has(key)) continue;
	const zh = SETTINGS_ZH[key];
	if (en.description && !zh?.description) problems.push(`${key}: English has a description, 中文缺失`);
}

// ---- 2 + 3. blank / oversized ---------------------------------------------------
for (const [key, zh] of Object.entries(SETTINGS_ZH)) {
	if (zh.description !== undefined && zh.description.trim() === "") problems.push(`${key}: 中文描述为空`);
	if (!exempt.has(key) && !dense.has(key) && zh.description && zh.description.length > MAX_ZH) {
		problems.push(`${key}: 中文描述过长 (${zh.description.length} > ${MAX_ZH})`);
	}
}
for (const [key, en] of Object.entries(SETTINGS_EN)) {
	if (en.description !== undefined && en.description.trim() === "") problems.push(`${key}: English description is empty`);
	if (!exempt.has(key) && !dense.has(key) && en.description && en.description.length > MAX_EN) {
		problems.push(`${key}: English description too long (${en.description.length} > ${MAX_EN})`);
	}
}

// ---- 4. restates-label ratchet --------------------------------------------------
/** Strip whitespace and punctuation so a label can be looked up inside its own description. */
function normalize(text: string): string {
	return text.replace(/[\s·.,;:!?、，。；：！？（）()[\]/\\"'`—–-]/g, "").toLowerCase();
}

/** A description that adds fewer than 12 characters beyond its own label carries no new information. */
function restatesLabel(label: string, description: string): boolean {
	const l = normalize(label);
	const d = normalize(description);
	if (l.length < 2 || !d.includes(l)) return false;
	return d.length - l.length < 12;
}

let restating = 0;
for (const zh of Object.values(SETTINGS_ZH)) {
	if (zh.description && restatesLabel(zh.label, zh.description)) restating += 1;
}

if (process.argv.includes("--update")) {
	writeFileSync(BASELINE_PATH, `${JSON.stringify({ restating }, null, 2)}\n`, "utf8");
	console.log(`baseline updated: restating = ${restating}`);
} else {
	const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { restating: number };
	if (restating > baseline.restating) {
		problems.push(`复述标签的描述变多了: ${restating} > 基线 ${baseline.restating}（用 --update 并在提交信息里说明理由才能上调）`);
	}
}

if (problems.length) {
	console.error("settings-copy gate failed:");
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log(`settings-copy gate ok (${Object.keys(SETTINGS_ZH).length} zh keys, ${Object.keys(SETTINGS_EN).length} en keys, restating ${restating})`);
