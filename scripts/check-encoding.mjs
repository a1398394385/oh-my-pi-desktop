#!/usr/bin/env node
// 源码编码门禁（BUG-026 的回归防线，RULE-009 的可执行部分）：
// 1. 非法 UTF-8 字节 —— 已跟踪文本文件必须是合法 UTF-8（`9b077bd` 那类整文件回写最容易破坏这条）；
// 2. 乱码特征字符 —— GBK/CP936 误解 UTF-8 字节后的产物（标点残片、外来字母、PUA、U+20AC），
//    这些字符在本仓正常文本中从不出现，命中即报错；
// 3. 双重编码指纹 —— 把整行按 CP936 解回字节再按 UTF-8 解，失败位极少且结果仍是中文，
//    说明这行大概率是「UTF-8 文本被当成 GBK 读过一遍」。
// 阈值来自实测校准：全仓 67455 行干净语料 0 误报，对 HEAD 的坏版本命中 493/507 行。
// 用法：
//   node scripts/check-encoding.mjs              # 扫描全部已跟踪文本文件（bun run check 用）
//   node scripts/check-encoding.mjs --staged      # 只扫暂存区（.githooks/pre-commit 用）
//   node scripts/check-encoding.mjs <file...>     # 只扫指定文件（临时核对用，可给未跟踪文件）
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXT = /\.(css|ts|tsx|js|jsx|mjs|cjs|json|jsonc|html|svg|md|mdc|yml|yaml|toml|py|sh|txt|rs|go|java|kt|swift|c|cc|cpp|h|hpp)$/i;
// 无扩展名的文本文件（编辑器/git 配置、钩子）也要纳入扫描
const TEXT_NAME = /(^|\/)(\.editorconfig|\.gitattributes|\.gitignore|Dockerfile|Makefile|pre-commit|pre-push|commit-msg)$/i;
// 允许引用乱码做证据的文档（事故账本 / 规则全集）：只豁免乱码指纹，编码合法性仍查
const EVIDENCE_DOCS = new Set([".agents/BUGS.md", ".agents/rules.md"]);

// 乱码特征字符：GBK 误解 UTF-8 的标点残片 + 本仓从不使用的外来字母/符号 + PUA + 欧元符号
// （写成码点转义：本文件自身必须不含这些字面量，否则扫描自己会误报）
const HINT_CHARS = new Set([
  "\u9239", "\u951b", "\u9286", "\u9225", "\u951f", // U+9239/951B/9286/9225/951F：U+2500/U+FF1A/U+3002/U+2014/U+FFFD 的残片
  "\u20ac",                                        // U+20AC：CP936 单字节 0x80 解出的欧元符号
  ...Array.from({ length: 0x100 }, (_, i) => String.fromCodePoint(0xe000 + i)),      // PUA 起始段
  ...Array.from({ length: 0xf8ff - 0xf800 + 1 }, (_, i) => String.fromCodePoint(0xf800 + i)),
]);
for (const [lo, hi] of [[0x0400, 0x0500], [0x0530, 0x0590], [0x0590, 0x0600]]) {
  for (let c = lo; c < hi; c++) HINT_CHARS.add(String.fromCodePoint(c)); // 西里尔 / 亚美尼亚 / 希伯来
}

// CP936 反查表（字符 → 双字节），用于双重编码指纹；0x80 → U+20AC 与 Windows CP936 对齐
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
      if (pair === undefined) out.push(0x3f); // 对不上就按 '?' 兜底（与原乱码工具一致）
      else out.push(pair >> 8, pair & 0xff);
    }
  }
  return Uint8Array.from(out);
}
const utf8Loose = new TextDecoder("utf-8");
const cjkCount = (s) => [...s].filter((c) => c >= "\u4e00" && c <= "\u9fff").length;
// 双重编码指纹：解回来失败位 ≤3、结果含 ≥4 个汉字、失败位密度低（阈值见文件头校准说明）
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
    : ["ls-files"];
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
    continue; // 已删除/不可读
  }
  const evidence = EVIDENCE_DOCS.has(rel.replace(/\\/g, "/"));
  if (buf.includes(0x00)) { // 文本扩展名但含 NUL：按二进制跳过（图片误命名等）
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
