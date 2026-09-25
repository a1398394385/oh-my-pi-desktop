// 分布终稿（附录 B 逐字转写）：pageId → Section[]。
// Section.from = "tab/组名"，按 SETTINGS_SCHEMA 声明序（Object.keys 序）展开该组键，
// 先 includePrefix（前缀命中才收）再剔 excludePrefix/excludeKeys。
// keys（显式键列表）用于无 UI 的高级页分组（运行时生成）与极少数显式段。
// 组标题在 SchemaRows 内解析：titleZh ?? GROUPS_ZH[组名] ?? 组名。

// 设置段形状：from/keys 二选一驱动展开，其余均为可选过滤/展示字段
export interface Section {
  from?: string;
  includePrefix?: string[];
  excludePrefix?: string[];
  excludeKeys?: string[];
  keys?: string[];
  titleZh?: string;
  hint?: string;
}

// schema 单个键的定义形状（与 SETTINGS_SCHEMA 对齐；ui 元数据为可选）。
// ui 与 def 均允许未列出的附加字段，避免底座加键时此处报错。
export interface SchemaUi {
  tab?: string;
  group?: string;
  label?: string;
  description?: string;
  warning?: string;
  options?: Array<{ value: string; label?: string }>;
  condition?: string;
  [key: string]: unknown;
}

export interface SchemaDef {
  type: string;
  credential?: boolean;
  default?: unknown;
  values?: string[];
  ui?: SchemaUi;
  [key: string]: unknown;
}

export const PAGE_PLACEMENT: Record<string, Section[]> = {
  // ── 现有页吸收（追加于既有内容之后，除注明替换处） ──
  "pg-appearance": [
    { from: "appearance/Theme", titleZh: "主题名" },
    { from: "appearance/Composer", titleZh: "合成器" },
    { from: "appearance/Status Line", titleZh: "状态栏" },
    { from: "appearance/Display", titleZh: "显示" },
    { from: "appearance/Images", titleZh: "图像" },
  ],
  "pg-general": [
    { from: "interaction/Startup & Updates" },
    { from: "interaction/Git" },
    { from: "interaction/Power" },
  ],
  "pg-memory": [
    { from: "memory/General", titleZh: "记忆引擎" },
    { from: "memory/Auto-Learn" },
    { from: "memory/Mnemopi" },
    { from: "memory/Hindsight" },
    { from: "memory/Sharpshooter" },
  ],
  "pg-browser": [{ from: "tools/Grep & Browser", includePrefix: ["browser."], titleZh: "浏览器环境" }],
  "pg-computer": [{ from: "tools/Computer", titleZh: "电脑控制" }],
  "pg-mcp": [{ from: "tools/Discovery & MCP" }],
  "pg-plugins": [{ from: "tools/Extensions" }],
  "pg-skills": [{ from: "tasks/Commands & Skills", includePrefix: ["skills."], titleZh: "技能命令" }],

  // ── 新主题页（pg-* 组件 + SchemaRows） ──
  "pg-model-behavior": [
    { from: "model/Thinking", excludeKeys: ["hideThinkingBlock"] },
    { titleZh: "思考预算", hint: "不同思考级别下用于推理的 token 预算", keys: ["thinkingBudgets.minimal", "thinkingBudgets.low", "thinkingBudgets.medium", "thinkingBudgets.high", "thinkingBudgets.xhigh", "thinkingBudgets.max"] },
    { from: "model/Sampling" },
    { from: "model/Prompt" },
    { from: "model/Retry & Fallback" },
    { from: "model/Advisor" },
    { from: "model/Prewalk" },
    { from: "model/Vision" },
  ],
  "pg-providers": [
    { from: "providers/Services" },
    { from: "providers/Fireworks" },
    { from: "providers/Tiny Model" },
    { from: "providers/Protocol" },
    { from: "providers/Timeouts" },
    { from: "providers/Privacy" },
  ],
  "pg-interaction": [
    { from: "interaction/Input" },
    { from: "interaction/Approvals" },
    { from: "interaction/Notifications", excludeKeys: ["ask.timeout"] },
    { from: "interaction/Speech" },
    { from: "interaction/Collab" },
    { from: "interaction/Stream" },
    { from: "interaction/Magic Keywords" },
    { from: "interaction/Agent" },
  ],
  "pg-context": [
    { from: "context/General" },
    { from: "context/Compaction" },
    { from: "context/Rules (TTSR)" },
    { from: "context/Experimental" },
  ],
  "pg-files": [
    { from: "files/Editing" },
    { from: "files/Reading" },
    { from: "files/Read Summaries" },
    { from: "files/LSP" },
  ],
  "pg-shell": [
    { from: "shell/Bash" },
    { from: "shell/Eval & Runtimes" },
  ],
  "pg-tools": [
    { from: "tools/Available Tools", excludeKeys: ["computer.enabled"] },
    { from: "tools/Todos" },
    { from: "tools/Grep & Browser", excludePrefix: ["browser."], titleZh: "Grep" },
    { from: "tools/GitHub" },
    { from: "tools/Output Limits" },
    { from: "tools/Execution" },
    { from: "tools/Developer" },
  ],
  "pg-tasks": [
    { from: "tasks/Modes" },
    { from: "tasks/Subagents" },
    { from: "tasks/Isolation" },
  ],
  // pg-advanced：无静态 sections —— 运行时按「无 ui 元数据的键」首段前缀动态分组（见 AdvancedPage）
};

// 展开一个 section 为具体键序（SETTINGS_SCHEMA 声明序）。schema 由调用方传入
// （SchemaRows 传 S.settingsSchema，校验脚本传导入的 SETTINGS_SCHEMA）。
export function expandSection(section: Section, schema: Record<string, SchemaDef>): string[] {
  let keys: string[];
  if (section.keys) {
    keys = section.keys.filter((k) => schema[k]);
  } else {
    const from = section.from!; // from 与 keys 二选一(placement 数据保证),同原版直接解引用
    const slash = from.indexOf("/");
    const tab = from.slice(0, slash);
    const group = from.slice(slash + 1);
    keys = Object.keys(schema).filter((k) => {
      const ui = schema[k].ui;
      if (!ui || ui.tab !== tab || ui.group !== group) return false;
      if (section.includePrefix && !section.includePrefix.some((p) => k.startsWith(p))) return false;
      if (section.excludePrefix && section.excludePrefix.some((p) => k.startsWith(p))) return false;
      return true;
    });
  }
  const excludeKeys = section.excludeKeys;
  if (excludeKeys) keys = keys.filter((k) => !excludeKeys.includes(k)); // 闭包内 TS 不保持窄化,先取局部常量
  return keys;
}
