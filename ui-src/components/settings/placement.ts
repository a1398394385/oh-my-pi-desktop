// Final placement (verbatim transcription of Appendix B): pageId → Section[].
// Section.from = "tab/group name" expands that group's keys in SETTINGS_SCHEMA declaration
// order (Object.keys order): includePrefix first (keep only prefix hits), then strip
// excludePrefix/excludeKeys.
// keys (explicit key list) is for advanced-page groups without UI metadata (generated at
// runtime) and a few explicit sections.
// Group titles are resolved in SchemaRows: titleZh ?? GROUPS_ZH[group] ?? group.

// Settings section shape: from/keys (either one) drives expansion; the rest are optional
// filter/display fields.
// titleZh/titleEn and hint/hintEn are paired bilingual fields (en falls back to the zh
// value when absent); SchemaRows picks one per the active language.
export interface Section {
  from?: string;
  includePrefix?: string[];
  excludePrefix?: string[];
  excludeKeys?: string[];
  keys?: string[];
  titleZh?: string;
  titleEn?: string;
  hint?: string;
  hintEn?: string;
}

// Shape of a single schema key definition (aligned with SETTINGS_SCHEMA; ui metadata optional).
// Both ui and def allow unlisted extra fields so new base keys don't error here.
export interface SchemaUi {
  tab?: string;
  group?: string;
  label?: string;
  description?: string;
  warning?: string;
  options?: Array<{ value: string | number; label?: string }> | "runtime";
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
  // ── Absorbed into existing pages (appended after existing content, except where replacement is noted) ──
  "pg-appearance": [
    { from: "appearance/Theme", titleZh: "主题名", titleEn: "Theme name" },
    { from: "appearance/Composer", titleZh: "合成器", titleEn: "Composer" },
    { from: "appearance/Status Line", titleZh: "状态栏", titleEn: "Status line" },
    { from: "appearance/Display", titleZh: "显示", titleEn: "Display" },
    { from: "appearance/Images", titleZh: "图像", titleEn: "Images" },
  ],
  "pg-general": [
    { from: "interaction/Startup & Updates" },
    { from: "interaction/Git" },
    { from: "interaction/Power" },
  ],
  "pg-memory": [
    { from: "memory/General", titleZh: "记忆引擎", titleEn: "Memory engine" },
    { from: "memory/Auto-Learn" },
    { from: "memory/Mnemopi" },
    { from: "memory/Hindsight" },
    { from: "memory/Sharpshooter" },
  ],
  "pg-browser": [{ from: "tools/Grep & Browser", includePrefix: ["browser."], titleZh: "浏览器环境", titleEn: "Browser environment" }],
  "pg-computer": [{ from: "tools/Computer", titleZh: "电脑控制", titleEn: "Computer control" }],
  "pg-mcp": [{ from: "tools/Discovery & MCP" }],
  "pg-plugins": [
    { from: "tools/Extensions", titleZh: "扩展运行", titleEn: "Extension runtime" },
    { titleZh: "市场与更新", titleEn: "Marketplace & updates", keys: ["marketplace.autoUpdate"] },
    { titleZh: "外部扩展与禁用名单", titleEn: "External extensions & disabled list", keys: ["extensions", "disabledExtensions"], hint: "手动指定额外加载的扩展路径，或指定禁用的插件/扩展模块 ID（逗号分隔）", hintEn: "Manually specify extra extension paths to load, or extension module IDs to disable (comma-separated)" },
  ],
  "pg-skills": [{ from: "tasks/Commands & Skills", includePrefix: ["skills."], titleZh: "技能命令", titleEn: "Skill commands" }],
  "pg-hooks": [
    {
      titleZh: "钩子运行配置",
      titleEn: "Hook runtime config",
      keys: ["statusLine.showHookStatus", "extensionHandlers.toolCallTimeoutMs"],
    },
  ],

  // ── New topic pages (pg-* components + SchemaRows) ──
  "pg-model-behavior": [
    { from: "model/Thinking", excludeKeys: ["hideThinkingBlock"] },
    { titleZh: "思考预算", titleEn: "Thinking budgets", hint: "不同思考级别下用于推理的 token 预算", hintEn: "Token budget used for reasoning at each thinking level", keys: ["thinkingBudgets.minimal", "thinkingBudgets.low", "thinkingBudgets.medium", "thinkingBudgets.high", "thinkingBudgets.xhigh", "thinkingBudgets.max"] },
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
    { from: "tools/Grep & Browser", excludePrefix: ["browser."], titleZh: "Grep", titleEn: "Grep" },
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
  // pg-advanced: no static sections — grouped at runtime by the first path segment of keys lacking ui metadata (see AdvancedPage)
};

// Expand a section into a concrete key list (SETTINGS_SCHEMA declaration order). The schema
// is passed by the caller (SchemaRows passes S.settingsSchema, validation scripts pass the
// imported SETTINGS_SCHEMA).
export function expandSection(section: Section, schema: Record<string, SchemaDef>): string[] {
  let keys: string[];
  if (section.keys) {
    keys = section.keys.filter((k) => schema[k]);
  } else {
    const from = section.from!; // from/keys are mutually exclusive (guaranteed by placement data); dereference directly as the original did
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
  if (excludeKeys) keys = keys.filter((k) => !excludeKeys.includes(k)); // TS doesn't keep narrowing inside closures; hoist to a local const first
  return keys;
}

// Keys excluded from expansion, or hardcoded-rendered on a specific settings page
export const SPECIAL_KEY_PAGES: Record<string, string> = {
  "hideThinkingBlock": "pg-general",
  "ask.timeout": "pg-general",
  "computer.enabled": "pg-computer",
  "commands.enableClaudeUser": "pg-skills",
  "commands.enableClaudeProject": "pg-skills",
  "commands.enableOpencodeUser": "pg-skills",
  "commands.enableOpencodeProject": "pg-skills",
  "statusLine.showHookStatus": "pg-hooks",
  "extensionHandlers.toolCallTimeoutMs": "pg-hooks",
};

// Preset default static map (covers all settings keys of SETTINGS_ZH); fallback when schema is not yet loaded or for offline tests
const DEFAULT_PAGE_KEYS: Record<string, string[]> = {
  "pg-general": [
    "autoResume", "power.sleepPrevention", "git.enabled", "startup.quiet",
    "startup.showSplash", "startup.setupWizard", "startup.checkUpdate", "update.channel",
    "marketplace.autoUpdate", "startup.changelogMode", "ask.timeout", "hideThinkingBlock",
  ],
  "pg-interaction": [
    "steeringMode", "followUpMode", "interruptMode", "tui.vimMode",
    "tui.vimModeDisplay", "loop.mode", "loop.conditionTimeoutMs", "composer.recallClearedDrafts",
    "doubleEscapeAction", "treeFilterMode", "autocompleteMaxVisible", "spelling.typoDetection",
    "spelling.autocomplete", "spelling.autocorrect", "emojiAutocomplete", "paste.largeMenuThreshold",
    "magicKeywords.enabled", "magicKeywords.ultrathink", "magicKeywords.orchestrate", "magicKeywords.workflow",
    "completion.notify", "error.notify", "ask.notify", "recap.enabled",
    "recap.idleSeconds", "collab.relayUrl", "collab.webUrl", "collab.displayName",
    "collab.autoStart", "share.serverUrl", "share.store", "share.redactSecrets",
    "stream.serverUrl", "stream.redactPatterns", "stt.enabled", "stt.modelName",
    "stt.submitTrigger", "tools.approval", "tools.approvalMode", "features.unexpectedStopDetection",
  ],
  "pg-context": [
    "workspace.additionalDirectories", "contextPromotion.enabled", "extendedContext", "compaction.enabled",
    "compaction.experimentalContextManagement", "compaction.midTurnEnabled", "compaction.methodOrder", "compaction.thresholdPercent",
    "compaction.thresholdTokens", "compaction.handoffSaveToDisk", "compaction.remoteStreamingV2Enabled", "compaction.asyncEnabled",
    "compaction.idleEnabled", "compaction.idleThresholdTokens", "compaction.idleTimeoutSeconds", "compaction.supersedeReads",
    "compaction.dropUseless", "snapcompact.systemPrompt", "snapcompact.toolResults", "tools.format",
    "snapcompact.shape", "branchSummary.enabled", "ttsr.enabled", "ttsr.contextMode",
    "ttsr.interruptMode", "ttsr.repeatMode", "ttsr.repeatGap", "ttsr.builtinRules",
    "ttsr.disabledRules",
  ],
  "pg-tools": [
    "tools.artifactSpillThreshold", "tools.artifactTailBytes", "tools.artifactHeadBytes", "tools.outputMaxColumns",
    "tools.artifactTailLines", "todo.enabled", "todo.reminders", "todo.remindersMax",
    "todo.eager", "glob.enabled", "grep.enabled", "grep.contextBefore",
    "grep.contextAfter", "astGrep.enabled", "astEdit.enabled", "debug.enabled",
    "launch.enabled", "speechgen.enabled", "generate_image.enabled", "images.questionTimeoutMs",
    "checkpoint.enabled", "fetch.enabled", "vault.enabled", "github.enabled",
    "github.cache.enabled", "github.cache.softTtlSec", "github.cache.hardTtlSec", "web_search.enabled",
    "security.enabled", "ask.enabled", "browser.enabled", "tools.intentTracing",
    "tools.abortOnFabricatedResult", "tools.speculativeExecution.enabled", "tools.speculativeExecution.maxInFlight", "tools.maxTimeout",
    "async.enabled", "irc.timeoutMs", "tasks.todoClearDelay", "dev.autoqa",
    "dev.autoqaPush.endpoint",
  ],
  "pg-computer": [
    "computer.enabled", "computer.display", "computer.maxWidth", "computer.maxHeight",
  ],
  "pg-browser": [
    "browser.cdpUrl", "browser.relay", "browser.relayUrl", "browser.headless",
    "browser.cmux", "browser.freezeOnTurnEnd", "browser.idleCloseSec", "browser.screenshotDir",
  ],
  "pg-mcp": [
    "tools.xdev", "tools.xdevDocs", "tools.xdevInlineDevices", "mcp.enableProjectConfig",
    "mcp.renderMarkdownResults", "mcp.notifications", "mcp.notificationDebounceMs",
  ],
  "pg-plugins": [
    "extensionHandlers.toolCallTimeoutMs", "marketplace.autoUpdate", "extensions", "disabledExtensions",
  ],
  "pg-appearance": [
    "theme.dark", "theme.light", "symbolPreset", "colorBlindMode",
    "composer.shape", "composer.tokenRate", "statusLine.preset", "statusLine.separator",
    "statusLine.contextLine", "statusLine.sessionAccent", "statusLine.transparent", "statusLine.compactThinkingLevel",
    "statusLine.showHookStatus", "terminal.showImages", "images.autoResize", "images.blockImages",
    "tui.resizeScrollback", "terminal.showProgress", "tui.textSizing", "tui.renderMermaid",
    "tui.reactions", "tui.codexResetFireworks", "tui.titleState", "tui.titleSpinner",
    "tui.hyperlinks", "tui.mouse", "tui.tight", "display.shimmer",
    "display.pinnedAgents", "display.smoothStreaming", "display.hideToolActivity", "display.showTokenUsage",
    "display.showTurnTime", "display.cacheMissMarker", "display.collapseCompacted", "showHardwareCursor",
    "tui.imeSafeCursor", "task.showResolvedModelBadge",
  ],
  "pg-model-behavior": [
    "advisor.enabled", "prewalk.enabled", "advisor.syncBacklog", "advisor.immuneTurns",
    "advisor.maxNotesPerUpdate", "modelRoleStorage", "images.describeForTextModels", "images.urls.enabled",
    "images.urls.backends", "images.urls.command", "images.urls.publicBaseUrl", "images.urls.ttlHours",
    "images.urls.bindHost", "images.urls.sshTarget", "images.urls.sshRemotePort", "defaultThinkingLevel",
    "thinkingBudgets.minimal", "thinkingBudgets.low", "thinkingBudgets.medium", "thinkingBudgets.high",
    "thinkingBudgets.xhigh", "thinkingBudgets.max", "proseOnlyThinking", "omitThinking",
    "externalThinking", "model.loopGuard.enabled", "model.loopGuard.checkAssistantContent", "model.loopGuard.toolCallReminder",
    "model.toolCallLoopGuard.enabled", "model.toolCallLoopGuard.threshold", "model.toolCallLoopGuard.exemptTools", "inlineToolDescriptors",
    "includeModelInPrompt", "includeWorkspaceTree", "skillful", "personality",
    "temperature", "topP", "topK", "minP",
    "presencePenalty", "repetitionPenalty", "textVerbosity", "tier.openai",
    "tier.anthropic", "tier.google", "tier.subagent", "tier.advisor",
    "retry.maxRetries", "retry.maxDelayMs", "retry.waitForUsageReset", "retry.modelFallback",
    "retry.usageAwareFallback", "retry.usageReservePct", "retry.usageReservePolicy", "retry.fallbackChains",
    "retry.fallbackRevertPolicy", "providers.anthropic.serverSideFallback", "providers.autoThinkingModel", "providers.autoThinkingMaxEffort",
  ],
  "pg-memory": [
    "memory.backend", "sharpshooter.model", "autolearn.enabled", "autolearn.autoContinue",
    "mnemopi.dbPath", "mnemopi.bank", "mnemopi.scoping", "mnemopi.embeddingVariant",
    "mnemopi.autoRecall", "mnemopi.autoRetain", "mnemopi.polyphonicRecall", "mnemopi.enhancedRecall",
    "mnemopi.proactiveLinking", "mnemopi.noEmbeddings", "mnemopi.embeddingModel", "mnemopi.embeddingApiUrl",
    "mnemopi.embeddingApiKey", "mnemopi.llmMode", "mnemopi.llmBaseUrl", "mnemopi.llmApiKey",
    "mnemopi.llmModel", "hindsight.apiUrl", "hindsight.apiToken", "hindsight.bankId",
    "hindsight.scoping", "hindsight.autoRecall", "hindsight.autoRetain", "hindsight.retainMode",
    "hindsight.mentalModelsEnabled", "hindsight.mentalModelAutoSeed", "providers.memoryModel",
  ],
  "pg-files": [
    "edit.mode", "edit.fuzzyMatch", "edit.fuzzyThreshold", "edit.streamingAbort",
    "edit.recoverInlineEdits", "edit.blockAutoGenerated", "edit.enforceSeenLines", "edit.blackbox.enabled",
    "edit.autoRepair.enabled", "readLineNumbers", "read.defaultLimit", "read.renderMarkdown",
    "read.summarize.enabled", "read.summarize.prose", "read.summarize.minBodyLines", "read.summarize.minCommentLines",
    "read.summarize.minTotalLines", "read.summarize.unfoldUntil", "read.summarize.unfoldLimit", "read.toolResultPreview",
    "lsp.enabled", "lsp.lazy", "lsp.shared", "lsp.formatOnWrite",
    "lsp.diagnosticsOnWrite", "lsp.diagnosticsOnEdit", "lsp.diagnosticsDeduplicate",
  ],
  "pg-shell": [
    "bash.enabled", "bash.allowCompoundCommands", "bash.autoBackground.enabled", "bash.patterns",
    "bashInterceptor.enabled", "bash.direnv", "bash.direnvLoadTimeoutMs", "shellMinimizer.enabled",
    "shellMinimizer.sourceOutlineLevel", "eval.py", "eval.js", "eval.tools.enabled",
    "eval.workpool.freshAgents", "eval.autoBackground.enabled", "python.kernelMode", "python.interpreter",
  ],
  "pg-tasks": [
    "plan.enabled", "plan.defaultOnStartup", "plan.autosave", "plan.autosaveDir",
    "goal.enabled", "goal.statusInFooter", "goal.continuationModes", "title.refreshOnReplan",
    "task.eager", "task.batch", "task.enableEffort", "task.maxConcurrency",
    "task.enableLsp", "task.maxRecursionDepth", "task.maxRuntimeMs", "task.agentIdleTtlMs",
    "task.softRequestBudget", "task.softRequestBudgetNotice", "task.maxEffort", "task.prewalk",
    "task.isolation.enabled", "isolation.backend", "worktree.clone", "worktree.cleanSource",
    "task.isolation.apply", "task.isolation.merge", "task.isolation.commits", "worktree.base",
  ],
  "pg-skills": [
    "skills.enableSkillCommands", "commands.enableClaudeUser", "commands.enableClaudeProject", "commands.enableOpencodeUser",
    "commands.enableOpencodeProject",
  ],
  "pg-hooks": [
    "statusLine.showHookStatus", "extensionHandlers.toolCallTimeoutMs",
  ],
  "pg-providers": [
    "providers.maxInFlightRequests", "providers.openai-codex.codeMode", "providers.openai-codex.codeModeDirectTools", "providers.ollama-cloud.maxConcurrency",
    "providers.webSearchOrder", "providers.webSearchExclude", "providers.webSearchTimeoutSeconds", "providers.webSearchGeminiModel",
    "providers.antigravityEndpoint", "providers.imageOrder", "live.voice", "providers.tts",
    "tts.localModel", "tts.localVoice", "speech.enabled", "speech.mode",
    "speech.enhanced", "speech.voice", "providers.fetch", "codexResets.autoRedeem",
    "codexResets.minBlockedMinutes", "codexResets.keepCredits", "codexResets.salvageHorizonHours", "exa.enabled",
    "exa.searchDelayMs", "searxng.endpoint", "providers.fireworksTier", "providers.judgmentProvider",
    "providers.tinyModel", "providers.tinyModelDevice", "providers.tinyModelDtype", "providers.unexpectedStopModel",
    "providers.kimiApiFormat", "providers.openaiWebsockets", "providers.cacheRetention", "providers.openrouterVariant",
    "provider.appendOnlyContext", "providers.streamFirstEventTimeoutSeconds", "providers.streamIdleTimeoutSeconds", "secrets.enabled",
  ],
};

export const STATIC_KEY_PAGE_MAP: Record<string, string> = {};
for (const [p, keys] of Object.entries(DEFAULT_PAGE_KEYS)) {
  for (const k of keys) {
    STATIC_KEY_PAGE_MAP[k] = p;
  }
}

/**
 * Map every key to its settings page pageId per the placement rules
 */
export function buildKeyToPageMap(schema?: Record<string, SchemaDef> | null): Record<string, string> {
  const map: Record<string, string> = { ...STATIC_KEY_PAGE_MAP };
  if (schema) {
    for (const [pageId, sections] of Object.entries(PAGE_PLACEMENT)) {
      for (const section of sections) {
        const keys = expandSection(section, schema);
        for (const k of keys) {
          map[k] = pageId;
        }
      }
    }
    for (const [k, p] of Object.entries(SPECIAL_KEY_PAGES)) {
      map[k] = p;
    }
    for (const k of Object.keys(schema)) {
      if (!map[k]) map[k] = "pg-advanced";
    }
  }
  return map;
}

/**
 * Locate the pageId for a key per placement.ts
 */
export function getPageIdForKey(key: string, schema?: Record<string, SchemaDef> | null): string {
  if (SPECIAL_KEY_PAGES[key]) return SPECIAL_KEY_PAGES[key];
  if (schema) {
    for (const [pageId, sections] of Object.entries(PAGE_PLACEMENT)) {
      for (const section of sections) {
        if (section.keys?.includes(key)) return pageId;
        if (section.from) {
          const slash = section.from.indexOf("/");
          const tab = section.from.slice(0, slash);
          const group = section.from.slice(slash + 1);
          const ui = schema[key]?.ui;
          if (ui && ui.tab === tab && ui.group === group) {
            if (section.includePrefix && !section.includePrefix.some((p) => key.startsWith(p))) continue;
            if (section.excludePrefix && section.excludePrefix.some((p) => key.startsWith(p))) continue;
            if (section.excludeKeys && section.excludeKeys.includes(key)) continue;
            return pageId;
          }
        }
      }
    }
    if (schema[key]) return "pg-advanced";
  }
  return STATIC_KEY_PAGE_MAP[key] ?? "pg-advanced";
}

