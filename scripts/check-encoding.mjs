#!/usr/bin/env node
// Source encoding gate (regression defense for BUG-026, executable half of RULE-009):
// 1. Invalid UTF-8 bytes -- tracked text files must be valid UTF-8 (whole-file rewrites like `9b077bd` break this most easily);
// 2. Mojibake signature chars -- artifacts of GBK/CP936 misreading UTF-8 bytes (punctuation fragments, foreign letters, PUA, U+20AC);
//    these never occur in normal text in this repo; any hit is an error;
// 3. Double-encoding fingerprint -- decode the whole line back to bytes via CP936 then as UTF-8; if it fails in very few places and the result is still CJK,
//    the line is most likely UTF-8 text that was once read as GBK.
// Thresholds calibrated on real data: 0 false positives across 67455 clean lines repo-wide, 493/507 lines hit on the broken HEAD revision.
// Usage:
//   node scripts/check-encoding.mjs              # scan all tracked text files (used by bun run check)
//   node scripts/check-encoding.mjs --staged     # scan only the staging area (used by .githooks/pre-commit)
//   node scripts/check-encoding.mjs <file...>     # scan only the given files (ad-hoc checks; untracked files allowed)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXT = /\.(css|ts|tsx|js|jsx|mjs|cjs|json|jsonc|html|svg|md|mdc|yml|yaml|toml|py|sh|txt|rs|go|java|kt|swift|c|cc|cpp|h|hpp)$/i;
// Extension-less text files (editor/git configs, hooks) must be scanned too
const TEXT_NAME = /(^|\/)(\.editorconfig|\.gitattributes|\.gitignore|Dockerfile|Makefile|pre-commit|pre-push|commit-msg)$/i;
// Docs allowed to quote mojibake as evidence (incident ledger / rule book): exempt from mojibake fingerprints only; UTF-8 validity is still checked
const EVIDENCE_DOCS = new Set([".agents/BUGS.md", ".agents/rules.md"]);

// Mojibake signature chars: GBK-misread UTF-8 punctuation fragments + foreign letters/symbols never used in this repo + PUA + euro sign
// (written as codepoint escapes: this file itself must not contain the literals, or scanning itself would false-positive)
const HINT_CHARS = new Set([
  "\u9239", "\u951b", "\u9286", "\u9225", "\u951f", // U+9239/951B/9286/9225/951F: fragments of U+2500/U+FF1A/U+3002/U+2014/U+FFFD
  "\u20ac",                                        // U+20AC: euro sign decoded from CP936 single byte 0x80
  ...Array.from({ length: 0x100 }, (_, i) => String.fromCodePoint(0xe000 + i)),      // PUA start range
  ...Array.from({ length: 0xf8ff - 0xf800 + 1 }, (_, i) => String.fromCodePoint(0xf800 + i)),
]);
for (const [lo, hi] of [[0x0400, 0x0500], [0x0530, 0x0590], [0x0590, 0x0600]]) {
  for (let c = lo; c < hi; c++) HINT_CHARS.add(String.fromCodePoint(c)); // Cyrillic / Armenian / Hebrew
}

// CP936 reverse lookup table (char -> two bytes), used for double-encoding fingerprints; 0x80 -> U+20AC aligned with Windows CP936
const gbkEnc = new Map();
{
  const dec = new TextDecoder("gbk");
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue;
      const s = dec.decode(Uint8Array.of(hi, lo));
      if (s.length === 1 && s !== "\uFFFD" && !gbkEnc.has(s)) gbkEnc.set(s, (hi << 8) | lo);
    }
  }
}
function toGbkBytes(line) {
  const out = [];
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (cp === 0x20ac) out.push(0x80);
    else {
      const pair = gbkEnc.get(ch);
      if (pair === undefined) out.push(0x3f); // Fall back to '?' on no match (same as the original mojibake tool)
      else out.push(pair >> 8, pair & 0xff);
    }
  }
  return Uint8Array.from(out);
}
const utf8Loose = new TextDecoder("utf-8");
const cjkCount = (s) => [...s].filter((c) => c >= "\u4e00" && c <= "\u9fff").length;
// Double-encoding fingerprint: <=3 failed positions when decoding back, result holds >=4 CJK chars, low failure density (thresholds in the header calibration note)
function doubleEncoded(line) {
  const decoded = utf8Loose.decode(toGbkBytes(line));
  const bad = (decoded.match(/\uFFFD/g) || []).length;
  const cjk = cjkCount(decoded);
  return bad <= 3 && cjk >= 4 && bad * 2 <= cjk;
}

function listFiles(argv) {
  const explicit = argv.filter((a) => !a.startsWith("--"));
  if (explicit.length) return explicit;
  const args = argv.includes("--staged")
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["ls-files", "-co", "--exclude-standard"];
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

const problems = [];
const warnings = [];
for (const rel of listFiles(process.argv.slice(2))) {
  if (!TEXT_EXT.test(rel) && !TEXT_NAME.test(rel)) continue;
  let buf;
  try {
    buf = readFileSync(join(root, rel));
  } catch {
    continue; // Deleted / unreadable
  }
  const evidence = EVIDENCE_DOCS.has(rel.replace(/\\/g, "/"));
  if (buf.includes(0x00)) { // Text extension but contains NUL: skip as binary (mislabeled images etc.)
    if (!evidence) warnings.push(`${rel}: 含 NUL 字节，跳过`);
    continue;
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) warnings.push(`${rel}: 存在 UTF-8 BOM`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    problems.push(`${rel}: 非法 UTF-8 字节（文件已不是合法 UTF-8 文本）`);
    continue;
  }
  if (evidence) continue;
  text.split("\n").forEach((line, i) => {
    const hit = [...line].filter((c) => HINT_CHARS.has(c)).length;
    if (hit > 0) problems.push(`${rel}:${i + 1}: 乱码特征字符 ${hit} 个 —— ${line.trim().slice(0, 90)}`);
    else if (doubleEncoded(line)) problems.push(`${rel}:${i + 1}: 疑似双重编码 —— ${line.trim().slice(0, 90)}`);
  });
}

for (const w of warnings) console.warn(`⚠ ${w}`);
if (problems.length) {
  console.error(`✗ 编码门禁失败：${problems.length} 处（改动前请先修复，或在 .agents/rules.md RULE-009 记明理由）`);
  for (const p of problems.slice(0, 50)) console.error(`  ${p}`);
  if (problems.length > 50) console.error(`  … 其余 ${problems.length - 50} 处省略`);
  process.exit(1);
}
console.log("✓ 编码门禁通过：文本文件均为合法 UTF-8，无乱码特征");
