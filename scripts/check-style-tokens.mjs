#!/usr/bin/env node
// 样式 token 门禁（借鉴 pi-desktop check-style-tokens，按本仓库技术栈裁剪）：
// 1. ui-src/**/*.tsx 禁止 Tailwind 任意值 utility（text-/rounded-/leading-/tracking-/font-[...]），
//    字号/行高/圆角/字重必须走 @theme 映射出的 token utility（text-ui-sm/rounded-md 等）；
// 2. ui/style.css 与 ui/css/*.css 非 token 定义行禁止裸色值（#abc / #aabbcc / rgb( / rgba( / hsl(），
//    颜色必须走 :root 与 [data-theme] 区定义的 --token 变量。
// 豁免：
//   - CSS 行以 -- 开头（token 定义行，:root / @theme / 浅色主题覆盖全走这种行）；
//   - @keyframes 块内不查（动画里的透明度渐变常是 rgba）；
//   - 行内注释 /* style-token-ignore */ 显式豁免（存量遗留，新增代码不得使用）；
//   - ui-src/components/ui/ 是 shadcn 基件（vendor 移植物，同 check-host-boundaries
//     对 host/limits 的处理，不纳入本仓样式治理）。
// 用法：node scripts/check-style-tokens.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const uiSrcDir = join(root, "ui-src");
const styleCss = join(root, "ui", "style.css");

// 五类受检前缀：字号/圆角/行高/字距/字重的任意值写法（与 pi-desktop 同源）
const TSX_ARBITRARY = /\b(?:text|rounded|leading|tracking|font)-\[[^\]]+\]/g;
// 裸色值：3/6 位十六进制 + 颜色函数（CSS 不区分大小写）
const RAW_COLOR = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b|rgba?\(|hsla?\(/i;
// 显式豁免标记：行内以注释形态出现（JSX 属性行用 /* */，JS 表达式行用 // 亦可）
const EXEMPT_MARK = /(?:\/\/|\/\*)[^\n]*style-token-ignore/;
const VENDOR_TSX = "ui-src/components/ui"; // shadcn 基件目录（正斜杠相对路径）

function walkTsx(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walkTsx(p);
    return e.name.endsWith(".tsx") ? [p] : [];
  });
}

const problems = [];

// ---- 检查 1：TSX 任意值 utility ----
for (const file of walkTsx(uiSrcDir)) {
  const rel = relative(root, file);
  if (rel.startsWith(VENDOR_TSX + "/")) continue; // shadcn vendor，不检查
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (EXEMPT_MARK.test(line)) return;
    for (const hit of line.match(TSX_ARBITRARY) ?? []) {
      problems.push(`${rel}:${i + 1} 任意值 utility "${hit}" —— 改用 token utility（text-ui-sm/rounded-md 等），存量遗留可加 /* style-token-ignore */ 豁免`);
    }
  });
}

// ---- 检查 2：ui/style.css + ui/css/*.css 裸色值（@keyframes 块内与 -- 开头 token 定义行豁免）----
{
  const cssFiles = [styleCss, ...readdirSync(join(root, "ui", "css")).filter((f) => f.endsWith(".css")).map((f) => join(root, "ui", "css", f))];
  for (const file of cssFiles) {
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split("\n");
    let kfDepth = 0; // @keyframes 大括号深度，>0 表示处于动画块内
    lines.forEach((line, i) => {
      const startsKf = /@keyframes\b/.test(line);
      const inKf = startsKf || kfDepth > 0; // 判定用更新前的深度（单行完整 keyframes 也算块内）
      kfDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (inKf) return;
      if (/^\s*--/.test(line)) return; // token 定义行
      if (EXEMPT_MARK.test(line)) return; // 显式豁免
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
