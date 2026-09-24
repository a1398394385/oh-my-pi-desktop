// 输入框 sigil 触发计算（@ 文件补全 / 行首 / 命令补全 / ! bash 模式）：
// 纯函数、无 React 依赖。语义对齐底座 TUI autocomplete.ts 的 extractAtPrefix /
// findLeadingSlashCommandStart 与 input-controller.ts 的 isBashMode。

// 词边界分隔符：触发 token 内遇到这些字符即截断（对齐 TUI）
const DELIM = new Set([" ", "\t", "\n", '"', "'", "="]);

/** 词边界 token 起点：从 caret 往回扫到分隔符之后 */
function tokenStart(text: string, caret: number): number {
  let i = caret;
  while (i > 0 && !DELIM.has(text[i - 1])) i--;
  return i;
}

/** caret 之前存在未闭合双引号时返回其下标（扫描配对，对齐 TUI findUnclosedQuoteStart） */
function findUnclosedQuote(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  return inQuotes ? quoteStart : null;
}

/** @ 文件提及补全触发区间 */
export type FileTrigger = { kind: "file"; start: number; end: number; query: string; quoted: boolean };
/** 行首 / 斜杠命令补全触发区间 */
export type CommandTrigger = { kind: "command"; start: number; end: number; query: string };
export type Trigger = FileTrigger | CommandTrigger;

/**
 * 触发检测。返回：
 *   null                                  —— 无触发
 *   { kind:"file", start, end, query, quoted }    —— @ 文件提及补全
 *   { kind:"command", start, end, query }         —— 行首 / 斜杠命令补全
 * start/end 为 token 在 text 中的区间（替换时用），query 为去掉 sigil 的检索词。
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  // 引号优先：未闭合 @"..." 内的空白不打断 token（含空格路径补全，对齐 TUI extractQuotedPrefix）
  const qs = findUnclosedQuote(before);
  if (qs !== null && qs > 0 && before[qs - 1] === "@" && (qs - 1 === 0 || DELIM.has(before[qs - 2]))) {
    return { kind: "file", start: qs - 1, end: caret, query: text.slice(qs + 1, caret), quoted: true };
  }
  const start = tokenStart(text, caret);
  const ch = text[start];
  if (ch === "@") {
    let query = text.slice(start + 1, caret);
    let quoted = false;
    if (query.startsWith('"')) {
      quoted = true;
      query = query.slice(1);
    }
    // 未加引号的 query 含空白说明 token 已结束（如 "@foo bar" 光标在 bar 上）；
    // 引号内允许空白（含空格路径，如 @"a b.txt"）
    if (!quoted && /\s/.test(query)) return null;
    return { kind: "file", start, end: caret, query, quoted };
  }
  if (ch === "/" && text.slice(0, start).trim() === "") {
    // 行首（允许前导空白）的 / 才触发命令补全；行内 / 不触发
    const query = text.slice(start + 1, caret);
    if (/\s/.test(query)) return null; // 已输完命令名进入参数段：关闭弹层
    return { kind: "command", start, end: caret, query };
  }
  return null;
}

/** 输入框处于 bash 模式：trimStart 后以 ! 开头（对齐 TUI input-controller isBashMode） */
export function isBashMode(text: string): boolean {
  return text.trimStart().startsWith("!");
}

/** 接受文件候选后的插入文本：含空格路径加引号；目录不补尾随空格（便于链式展开） */
export function insertFile(value: string, dir: boolean, quoted: boolean): string {
  const needsQuote = quoted || value.includes(" ");
  const body = needsQuote ? `"${value}"` : value;
  return "@" + body + (dir ? "" : " ");
}

/** 接受命令候选后的插入文本：命令名 + 空格直接进入参数段 */
export function insertCommand(name: string): string {
  return "/" + name + " ";
}
