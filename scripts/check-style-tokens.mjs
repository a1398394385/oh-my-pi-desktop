#!/usr/bin/env node
// Style token gate (borrowed from pi-desktop check-style-tokens, trimmed to this repo's stack):
// 1. Tailwind arbitrary-value utilities are banned in ui-src/**/*.tsx (text-/rounded-/leading-/tracking-/font-[...]);
//    font size/line height/radius/weight must go through @theme-mapped token utilities (text-ui-sm/rounded-md etc.);
// 2. Raw color values are banned on non-token-definition lines of ui/style.css and ui/css/*.css (#abc / #aabbcc / rgb( / rgba( / hsl();
//    colors must go through the --token variables defined in :root and [data-theme] blocks.
// Exemptions:
//   - CSS lines starting with -- (token definition lines; :root / @theme / light-theme overrides all use them);
//   - Inside @keyframes blocks (opacity fades in animations are often rgba);
//   - Inline comment /* style-token-ignore */ grants an explicit exemption (legacy leftovers; new code must not use it);
//   - ui-src/components/ui/ holds shadcn primitives (a vendor transplant, treated like check-host-boundaries
//     treats host/limits; excluded from this repo's style governance).
// Usage: node scripts/check-style-tokens.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const uiSrcDir = join(root, "ui-src");
const styleCss = join(root, "ui", "style.css");

// Five checked prefixes: arbitrary-value forms of font size/radius/line height/letter spacing/weight (same origin as pi-desktop)
const TSX_ARBITRARY = /\b(?:text|rounded|leading|tracking|font)-\[[^\]]+\]/g;
// Raw colors: 3/6-digit hex + color functions (CSS is case-insensitive)
const RAW_COLOR = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b|rgba?\(|hsla?\(/i;
// Explicit exemption marker: appears inline as a comment (/* */ on JSX attribute lines; // also works on JS expression lines)
const EXEMPT_MARK = /(?:\/\/|\/\*)[^\n]*style-token-ignore/;
const VENDOR_TSX = "ui-src/components/ui"; // shadcn primitives directory (forward-slash relative path)

function walkTsx(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walkTsx(p);
    return e.name.endsWith(".tsx") ? [p] : [];
  });
}

const problems = [];

// ---- Check 1: TSX arbitrary-value utilities ----
for (const file of walkTsx(uiSrcDir)) {
  const rel = relative(root, file);
  if (rel.startsWith(VENDOR_TSX + "/")) continue; // shadcn vendor, unchecked
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (EXEMPT_MARK.test(line)) return;
    for (const hit of line.match(TSX_ARBITRARY) ?? []) {
      problems.push(`${rel}:${i + 1} 任意值 utility "${hit}" —— 改用 token utility（text-ui-sm/rounded-md 等），存量遗留可加 /* style-token-ignore */ 豁免`);
    }
  });
}

// ---- Check 2: raw colors in ui/style.css + ui/css/*.css (inside @keyframes and -- token-definition lines exempt) ----
{
  const cssFiles = [styleCss, ...readdirSync(join(root, "ui", "css")).filter((f) => f.endsWith(".css")).map((f) => join(root, "ui", "css", f))];
  for (const file of cssFiles) {
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split("\n");
    let kfDepth = 0; // @keyframes brace depth; >0 means inside an animation block
    lines.forEach((line, i) => {
      const startsKf = /@keyframes\b/.test(line);
      const inKf = startsKf || kfDepth > 0; // Judge with the pre-update depth (a single-line full keyframes also counts as inside)
      kfDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (inKf) return;
      if (/^\s*--/.test(line)) return; // token definition line
      if (EXEMPT_MARK.test(line)) return; // explicit exemption
      if (RAW_COLOR.test(line)) {
        problems.push(`${rel}:${i + 1} 裸色值 —— ${line.trim().slice(0, 90)}（颜色须走 --token 变量；动画/存量遗留可加 /* style-token-ignore */ 豁免）`);
      }
    });
  }
}

if (problems.length > 0) {
  console.error(`✗ 样式 token 门禁失败（${problems.length} 处）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("✓ 样式 token 门禁通过：TSX 无任意值 utility，style.css/ui/css 无未豁免裸色值");
