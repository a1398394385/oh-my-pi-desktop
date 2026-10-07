// i18n key parity gate: every key the UI asks for must exist in BOTH language
// bundles, and the two bundles must carry the same key set.
//
// Motivation: a missing key does not fail the build — i18next silently renders
// the raw key string ("settingsPage.exp.railDeviceDefault"), which is exactly
// the kind of defect that ships and is only noticed by looking at the screen
// (BUG: the music-reactivity device row shipped showing its raw key).
//
// Two halves:
//   1. Used keys: literal `t("...")` / `i18next.t("...")` call sites in ui-src
//      are collected; dynamic keys (template strings, variables) are skipped
//      since they cannot be resolved statically.
//   2. Defined keys: the en / zh-CN bundles are loaded through bun and walked.
//      The UI half of the comparison only runs when bun is available (it is —
//      the script is a bun script); the source half works under plain node.
//
// Usage: bun scripts/check-i18n-keys.ts   (or node, for the call-site half only)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Every literal key passed to t()/i18next.t() across the UI sources. */
function collectUsedKeys(): { key: string; file: string; line: number }[] {
  const out: { key: string; file: string; line: number }[] = [];
  const skip = new Set(["node_modules", "dist", "out", "target"]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      // i18n bundles are definitions, not call sites.
      if (full.includes(`${join("ui-src", "i18n")}`)) continue;
      const src = readFileSync(full, "utf8");
      src.split("\n").forEach((line, idx) => {
        // Only literal keys: `t("a.b")`. Two shapes look literal but are not —
        // a partial prefix being concatenated (`t("a." + k)`) and a template
        // literal (`` t(`a.${k}`) ``). Neither is statically resolvable, so
        // blank out every such call before scanning for real literals.
        const literal = line
          // `t("..." + expr` / `t("..."+expr` — concatenations
          .replace(/\b(?:i18next\.)?t\(\s*"[^"]*"\s*\+[^)]*\)/g, " ")
          // `t("..." + expr)` where expr ends the call — catch-all for the above
          .replace(/\b(?:i18next\.)?t\(\s*`[^`]*`/g, " ");
        const re = /\b(?:i18next\.)?t\(\s*"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)"(?![+`])/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(literal)) !== null) {
          out.push({ key: m[1], file: full.slice(root.length + 1), line: idx + 1 });
        }
      });
    }
  };
  walk(join(root, "ui-src"));
  return out;
}

/** Flatten a nested bundle object into dotted key paths. */
function flatten(obj: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const sub of flatten(v, path)) out.add(sub);
    } else {
      out.add(path);
    }
  }
  return out;
}

/**
 * i18next plural suffixes (`key_one` / `key_other`) are resolved at lookup time,
 * not stored per-locale: zh has only `_other`, en has both. Comparing raw key
 * names would flag every pluralized string, so the plural family is collapsed to
 * its base key before the parity check.
 */
function collapsePlurals(keys: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const key of keys) out.add(key.replace(/_(zero|one|two|few|many|other)$/, ""));
  return out;
}

// Bundles are statically importable (fixed paths), and bun compiles the TS
// locale files on the fly — importing them is what lets the gate compare the
// real key sets instead of regex-scanning source.
import enBundle from "../ui-src/i18n/locales/en";
import zhBundle from "../ui-src/i18n/locales/zh-CN";

const used = collectUsedKeys();
const failures: string[] = [];

// ---- Half 1: bundle parity (en vs zh-CN) ----
const en = collapsePlurals(flatten(enBundle));
const zh = collapsePlurals(flatten(zhBundle));
for (const key of en) if (!zh.has(key)) failures.push(`zh-CN 缺失: ${key}`);
for (const key of zh) if (!en.has(key)) failures.push(`en 缺失: ${key}`);

// ---- Half 2: every used key must be defined in both ----
for (const { key, file, line } of used) {
  if (!en.has(key)) failures.push(`${file}:${line} 用了未定义的 key: ${key}`);
}

if (failures.length > 0) {
  console.error(`✗ i18n key 门禁失败 (${failures.length} 项):`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  if (failures.length > 40) console.error(`  ... 另有 ${failures.length - 40} 项`);
  console.error("  出路:在 ui-src/i18n/locales/ui/*.en.ts 与 *.zh.ts 里补齐对应 key（两个语言包必须同时改）。");
  process.exit(1);
}

console.log(
  `✓ i18n key 门禁通过:调用点 ${used.length} 个,en ${en.size} 个 key,zh-CN ${zh.size} 个 key,两包 key 集合完全一致`,
);