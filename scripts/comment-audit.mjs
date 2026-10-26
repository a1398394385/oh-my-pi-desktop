#!/usr/bin/env node
// Comment audit for the comment governance plan (docs/comment-style.md §8):
// per-directory text lines, comment lines, Chinese comment lines and TODO/FIXME counts.
// The heuristic differs from scripts/check-comment-language.mjs (that one is the gate;
// this one reports volume, so the numbers are comparable but not identical).
// Usage: node scripts/comment-audit.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const root = process.cwd();
const SCOPE = ["host", "ui-src", "scripts", "src-tauri/src", "ui", "(root)"];
const EXCLUDED = new Set(["node_modules", "dist", "out", "release", "target", "coverage"]);
const EXEMPT = ["ui-src/i18n/", "ui-src/components/settings/settings-zh.ts", "ui-src/components/composer/commands-zh.ts"];
const MARKERS = { js: ["//", "/*"], rust: ["//", "/*"], css: ["/*"], shell: ["#"], html: ["<!--", "//", "/*"] };
const FAMILY = { ".ts": "js", ".tsx": "js", ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".rs": "rust", ".css": "css", ".scss": "css", ".sh": "shell", ".html": "html", ".htm": "html" };
const CJK = /[\u4e00-\u9fff]/;

function bucket(p) {
  const seg = p.split("/");
  if (seg.some((s) => EXCLUDED.has(s))) return null;
  if (EXEMPT.some((e) => p.startsWith(e))) return null;
  if (seg.length === 1) return "(root)";
  const hit = SCOPE.find((d) => d !== "(root)" && p.startsWith(d + "/"));
  return hit ?? null;
}

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n").filter(Boolean)
  .map((p) => {
    const ext = extname(p);
    let fam = FAMILY[ext];
    if (!fam && !ext && (p.startsWith(".githooks/") || p.startsWith("scripts/hooks/"))) fam = "shell";
    const dir = bucket(p);
    return fam && dir ? { p, fam, dir } : null;
  })
  .filter(Boolean);

const stats = new Map(SCOPE.map((d) => [d, { files: 0, lines: 0, comments: 0, zh: 0, todo: 0 }]));
const top = [];
for (const { p, fam, dir } of files) {
  const text = readFileSync(p, "utf8");
  const rows = text.split("\n");
  let inBlock = false;
  let comments = 0, zh = 0, todo = 0;
  for (const line of rows) {
    let isComment = false;
    let firstMarker = -1;
    if (inBlock) {
      isComment = true;
    } else {
      for (const m of MARKERS[fam]) {
        const i = line.indexOf(m);
        if (i >= 0 && (firstMarker < 0 || i < firstMarker)) firstMarker = i;
      }
      isComment = firstMarker >= 0;
      if (isComment && line.indexOf("/*") >= 0 && line.indexOf("*/") < 0) inBlock = true;
    }
    if (inBlock && line.includes("*/")) inBlock = false;
    if (isComment) {
      comments++;
      if (CJK.test(line.slice(Math.max(firstMarker, 0)))) zh++;
      if (/TODO|FIXME|XXX|HACK/.test(line)) todo++;
    }
  }
  const s = stats.get(dir);
  s.files++; s.lines += rows.length; s.comments += comments; s.zh += zh; s.todo += todo;
  top.push({ file: p, lines: rows.length, comments, zh });
}

let total = { files: 0, lines: 0, comments: 0, zh: 0, todo: 0 };
for (const [dir, s] of stats) {
  if (!s.files) continue;
  console.log(`${dir.padEnd(12)} files=${String(s.files).padStart(4)} lines=${String(s.lines).padStart(6)} comments=${String(s.comments).padStart(5)} (${(s.comments / s.lines * 100).toFixed(1)}%) zh=${String(s.zh).padStart(4)} todo=${s.todo}`);
  for (const k of Object.keys(total)) total[k] += s[k];
}
console.log(`${"TOTAL".padEnd(12)} files=${total.files} lines=${total.lines} comments=${total.comments} (${(total.comments / total.lines * 100).toFixed(1)}%) zh=${total.zh} todo=${total.todo}`);
console.log("\ntop 15 by comment lines:");
for (const t of top.sort((a, b) => b.comments - a.comments).slice(0, 15)) {
  console.log(`${String(t.comments).padStart(4)} comments  ${String(t.zh).padStart(3)} zh  ${String(t.lines).padStart(6)} lines  ${t.file}`);
}
