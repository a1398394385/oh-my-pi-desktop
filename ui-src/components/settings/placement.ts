// Final placement (verbatim transcription of Appendix B): pageId → Section[].
// Section.from = "tab/group name" expands that group's keys in SETTINGS_SCHEMA declaration
// order (Object.keys order): includePrefix first (keep only prefix hits), then strip
// excludePrefix/excludeKeys.
// keys (explicit key list) is for advanced-page groups without UI metadata (generated at
// runtime) and a few explicit sections. from + keys combine: the expanded group first,
// then the explicit keys appended (ui-less keys adopted into a ui-carrying group's card).
// Group titles are resolved in SchemaRows: titleZh ?? GROUPS_ZH[group] ?? group.

// Settings section shape: from and/or keys drive expansion; the rest are optional
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
  // Visibility gate: the section renders only while the live settings value at
  // `key` strictly equals `equals` (checked in SchemaRows against
  // hostSettings.values; used by the memory page's backend-specific groups)
  when?: { key: string; equals: string };
  // Stable id so a page can own the layout of its own sections (pg-computer
  // renders each section as heading + one rounded card instead of SchemaRows'
  // default heading + card pair)
  id?: string;
}

import type { SchemaDef } from "../../types/settings";
export type { SchemaDef, SchemaUi } from "../../types/settings";

export const PAGE_PLACEMENT: Record<string, Section[]> = {
  // ── Absorbed into existing pages (appended after existing content, except where replacement is noted) ──
  "pg-appearance": [
    { from: "appearance/Theme", titleZh: "主题名", titleEn: "Theme name" },
    { from: "appearance/Display", titleZh: "显示", titleEn: "Display" },
    { from: "appearance/Images", titleZh: "图像", titleEn: "Images" },
  ],
  "pg-general": [
    { from: "interaction/Startup & Updates" },
    { from: "interaction/Git" },
    { from: "interaction/Power" },
  ],
  "pg-memory": [
    // Auto-Learn comes first: its controller + managed-skill output are
    // backend-independent (even with memory off), only the learn-tool write
    // path needs local/mnemopi/hindsight — see autolearn.enabled's label
    { titleZh: "自动学习", titleEn: "Auto-Learn", keys: ["autolearn.enabled", "autolearn.autoContinue", "autolearn.minToolCalls"] },
    { from: "memory/General", titleZh: "记忆引擎", titleEn: "Memory engine" },
    // Backend-specific groups (ui-less keys adopted from the advanced page;
    // memories.enabled stays hidden — the base marks it "use memory.backend
    // instead"). Each group is gated on the live memory.backend value, so the
    // page shows exactly the active provider's settings.
    {
      when: { key: "memory.backend", equals: "local" },
      titleZh: "本地记忆管线", titleEn: "Local memory pipeline",
      keys: [
        "memories.maxRolloutsPerStartup", "memories.maxRolloutAgeDays", "memories.minRolloutIdleHours",
        "memories.threadScanLimit", "memories.maxRawMemoriesForGlobal", "memories.stage1Concurrency",
        "memories.stage1LeaseSeconds", "memories.stage1RetryDelaySeconds", "memories.phase2LeaseSeconds",
        "memories.phase2RetryDelaySeconds", "memories.phase2HeartbeatSeconds", "memories.rolloutPayloadPercent",
        "memories.phase1InputTokenLimit", "memories.fallbackTokenLimit", "memories.summaryInjectionTokenLimit",
      ],
    },
    { when: { key: "memory.backend", equals: "mnemopi" }, from: "memory/Mnemopi" },
    {
      when: { key: "memory.backend", equals: "mnemopi" },
      titleZh: "Mnemopi 底层", titleEn: "Mnemopi internals",
      keys: ["mnemopi.retainEveryNTurns", "mnemopi.recallLimit", "mnemopi.recallContextTurns", "mnemopi.recallMaxQueryChars", "mnemopi.injectionTokenLimit", "mnemopi.debug"],
    },
    { when: { key: "memory.backend", equals: "hindsight" }, from: "memory/Hindsight" },
    {
      when: { key: "memory.backend", equals: "hindsight" },
      titleZh: "Hindsight 底层", titleEn: "Hindsight internals",
      keys: [
        "hindsight.bankIdPrefix", "hindsight.bankMission", "hindsight.retainMission", "hindsight.retainEveryNTurns",
        "hindsight.retainOverlapTurns", "hindsight.retainContext", "hindsight.recallBudget", "hindsight.recallMaxTokens",
        "hindsight.recallContextTurns", "hindsight.recallMaxQueryChars", "hindsight.recallTypes", "hindsight.debug",
        "hindsight.requestTimeoutMs", "hindsight.reflectTimeoutMs", "hindsight.recallTimeoutMs", "hindsight.retainTimeoutMs",
        "hindsight.mentalModelMaxRenderChars",
      ],
    },
    { when: { key: "memory.backend", equals: "sharpshooter" }, from: "memory/Sharpshooter" },
    {
      when: { key: "memory.backend", equals: "sharpshooter" },
      titleZh: "Sharpshooter 底层", titleEn: "Sharpshooter internals",
      keys: ["sharpshooter.intervalMinutes", "sharpshooter.injectionTokenLimit"],
    },
  ],
  "pg-computer": [
    { id: "computer", from: "tools/Computer", excludeKeys: ["computer.enabled", "computer.display"], titleZh: "电脑控制", titleEn: "Computer control" },
    { id: "browser", from: "tools/Grep & Browser", includePrefix: ["browser."], excludeKeys: ["browser.enabled", "browser.relay", "browser.relayUrl", "browser.cdpUrl"], titleZh: "浏览器使用", titleEn: "Browser use" },
  ],
  "pg-mcp": [{ from: "tools/Discovery & MCP" }],
  "pg-plugins": [
    { from: "tools/Extensions", titleZh: "扩展运行", titleEn: "Extension runtime" },
    { titleZh: "市场与更新", titleEn: "Marketplace & updates", keys: ["marketplace.autoUpdate"] },
    { titleZh: "外部扩展与禁用名单", titleEn: "External extensions & disabled list", keys: ["extensions", "disabledExtensions"], hint: "手动指定额外加载的扩展路径，或指定禁用的插件/扩展模块 ID（逗号分隔）", hintEn: "Manually specify extra extension paths to load, or extension module IDs to disable (comma-separated)" },
  ],
  "pg-skills": [
    {
      // Merged section (was two cards): the skill-command registration toggle
      // plus directory-level loading switches + custom roots + glob allowlist.
      titleZh: "技能设置",
      titleEn: "Skill settings",
      keys: [
        "skills.enableSkillCommands",
        "skills.enablePiUser", "skills.enablePiProject",
        "skills.enableAgentsUser", "skills.enableAgentsProject",
        "skills.enableClaudeUser", "skills.enableClaudeProject", "skills.enableCodexUser",
        "skills.customDirectories", "skills.includeSkills",
        "skills.registryUrl",
      ],
    },
  ],
  "pg-hooks": [
    {
      titleZh: "钩子运行配置",
      titleEn: "Hook runtime config",
      keys: ["extensionHandlers.toolCallTimeoutMs"],
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
    // Web-search-specific rows (timeout, SearXNG endpoint, Exa toggles) moved to the capability
    // backends page; excluded here so they render in exactly one place
    { from: "providers/Services", excludeKeys: ["providers.webSearchTimeoutSeconds", "searxng.endpoint", "exa.enabled", "exa.searchDelayMs"] },
    { from: "providers/Fireworks" },
    { from: "providers/Tiny Model" },
    { from: "providers/Protocol" },
    { from: "providers/Timeouts" },
    { from: "providers/Privacy" },
  ],
  "pg-capabilities": [
    { titleZh: "搜索相关设置", titleEn: "Search settings", keys: ["providers.webSearchTimeoutSeconds", "searxng.endpoint", "exa.enabled", "exa.searchDelayMs"] },
    // ui-less keys adopted from the advanced page: per-destination options and
    // credentials for the image URL publishing chain (backends/enabled/command
    // live in the model-behavior Vision group)
    { titleZh: "图像发布后端", titleEn: "Image publishing backends", keys: ["images.urls.options", "images.urls.credentials"] },
  ],
  "pg-interaction": [
    { from: "interaction/Input" },
    { from: "interaction/Approvals" },
    { from: "interaction/Notifications", excludeKeys: ["ask.timeout"] },
    { from: "interaction/Speech" },
    // ui-less key adopted from the advanced page: transcription language for
    // the dictation switches in the Speech group above (stt.enabled/modelName/
    // submitTrigger); the capabilities page's dictation section points here too
    { titleZh: "语音转文字语言", titleEn: "Speech-to-text language", keys: ["stt.language"] },
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
    // Interceptor/minimizer rows move out of the Bash group into their own cards
    // below it, so each feature renders in exactly one place. The ui-less
    // auto-background threshold key joins the Bash group's card via keys-append.
    { from: "shell/Bash", keys: ["bash.autoBackground.thresholdMs"], excludeKeys: ["bashInterceptor.enabled", "shellMinimizer.enabled", "shellMinimizer.sourceOutlineLevel"] },
    // id'd section: ShellPage owns the layout — the enabled toggle (SchemaRowsBare)
    // and the graphical rules editor (bashInterceptor.patterns, see
    // SPECIAL_KEY_PAGES) share one card
    { id: "bashInterceptor", titleZh: "Shell 拦截器", titleEn: "Shell Interceptor", keys: ["bashInterceptor.enabled"] },
    // ui-less minimizer keys adopted from the advanced page (settingsPath/only/
    // except/maxCaptureBytes/legacyFilters) join their ui-carrying siblings here
    {
      titleZh: "Shell 精简器", titleEn: "Shell Minimizer",
      keys: [
        "shellMinimizer.enabled", "shellMinimizer.sourceOutlineLevel", "shellMinimizer.settingsPath",
        "shellMinimizer.only", "shellMinimizer.except", "shellMinimizer.maxCaptureBytes",
        "shellMinimizer.legacyFilters",
      ],
    },
    { from: "shell/Eval & Runtimes", keys: ["eval.autoBackground.thresholdMs"] },
  ],
  "pg-tools": [
    { from: "tools/Available Tools", excludeKeys: ["computer.enabled", "browser.enabled"] },
    { from: "tools/Todos" },
    { from: "tools/Grep & Browser", excludePrefix: ["browser."], titleZh: "Grep", titleEn: "Grep" },
    { from: "tools/GitHub" },
    { from: "tools/IDA Pro" },
    { from: "tools/Output Limits" },
    { from: "tools/Execution" },
    { from: "tools/Developer", excludeKeys: ["dev.autoqa", "dev.autoqaPush.endpoint"] },
  ],
  "pg-tasks": [
    { from: "tasks/Modes" },
    { from: "tasks/Subagents" },
    { from: "tasks/Isolation" },
  ],
  // Developer page: low-level runtime knobs aggregated from the advanced page (gc,
  // compaction, dev-prefix autoqa keys) plus the autoqa rows moved out of the tools
  // page's Developer group; user-facing compaction switches stay on pg-context
  "pg-developer": [
    { titleZh: "自动 QA", titleEn: "Auto QA", keys: ["dev.autoqa", "dev.autoqaPush.endpoint", "dev.autoqaPush.token", "dev.autoqaConsent"] },
    { titleZh: "垃圾回收（GC）", titleEn: "Garbage collection", keys: ["gc.blobs", "gc.archive", "gc.wal", "gc.coldArchiveAfterDays", "gc.retainNewestGlobal", "gc.retainNewestPerCwd", "gc.stale", "gc.staleRetainNewest", "gc.staleRetainDays"] },
    { titleZh: "压缩（底层）", titleEn: "Compaction (low-level)", keys: ["compaction.reserveTokens", "compaction.keepRecentTokens", "compaction.autoContinue", "compaction.remoteEndpoint", "compaction.v2RetainedMessageBudget"] },
  ],
  // pg-advanced: no static sections — grouped at runtime by the first path segment of keys lacking ui metadata (see AdvancedPage)
};

// Expand a section into a concrete key list (SETTINGS_SCHEMA declaration order). The schema
// is passed by the caller (SchemaRows passes S.settingsSchema, validation scripts pass the
// imported SETTINGS_SCHEMA). from and keys combine: the from-group expands first, then the
// explicit keys append (adopting ui-less keys into a ui-carrying group's card).
export function expandSection(section: Section, schema: Record<string, SchemaDef>): string[] {
  let keys: string[];
  if (section.from) {
    const slash = section.from.indexOf("/");
    const tab = section.from.slice(0, slash);
    const group = section.from.slice(slash + 1);
    keys = Object.keys(schema).filter((k) => {
      const ui = schema[k].ui;
      if (!ui || ui.tab !== tab || ui.group !== group) return false;
      if (section.includePrefix && !section.includePrefix.some((p) => k.startsWith(p))) return false;
      if (section.excludePrefix && section.excludePrefix.some((p) => k.startsWith(p))) return false;
      return true;
    });
    if (section.keys) keys = keys.concat(section.keys.filter((k) => schema[k] && !keys.includes(k)));
  } else {
    keys = (section.keys ?? []).filter((k) => schema[k]);
  }
  const excludeKeys = section.excludeKeys;
  if (excludeKeys) keys = keys.filter((k) => !excludeKeys.includes(k)); // TS doesn't keep narrowing inside closures; hoist to a local const first
  return keys.filter((k) => !HIDDEN_KEYS[k]);
}

// Keys excluded from expansion, or hardcoded-rendered on a specific settings page
export const SPECIAL_KEY_PAGES: Record<string, string> = {
  "hideThinkingBlock": "pg-general",
  "ask.timeout": "pg-general",
  "computer.enabled": "pg-computer",
  "computer.display": "pg-computer",
  "browser.enabled": "pg-computer",
  // External browser routes: gated behind the pg-computer "use an external
  // browser" switch, rendered from ComputerPage's own section
  "browser.relay": "pg-computer",
  "browser.relayUrl": "pg-computer",
  "browser.cdpUrl": "pg-computer",
  "commands.enableClaudeUser": "pg-skills",
  "commands.enableClaudeProject": "pg-skills",
  "commands.enableOpencodeUser": "pg-skills",
  "commands.enableOpencodeProject": "pg-skills",
  "extensionHandlers.toolCallTimeoutMs": "pg-hooks",
  // Fully managed by dedicated graphical controls (model page eye-toggle /
  // role cards / ctrl+p cycle editor, skills page master switch / row toggles,
  // extensions page source master switch / foreign-tool-dir opt-in), written
  // through dedicated RPCs — no raw SchemaRows editor anywhere
  "enabledModels": "pg-model",
  "modelRoles": "pg-model",
  "cycleOrder": "pg-model",
  "skills.enabled": "pg-skills",
  "skills.ignoredSkills": "pg-skills",
  "enabledProviders": "pg-extensions",
  "disabledProviders": "pg-extensions",
  // The base marks this "Hidden from UI — users should use memory.backend
  // instead" (memories/settings.ts); the memory page's local-pipeline group
  // keys off memory.backend directly, so this legacy switch stays invisible
  "memories.enabled": "pg-memory",
  // Graphical rules editor on the Shell page (fixed-structure JSON array:
  // pattern/flags/tool/message per rule, ordered first-match); no raw
  // SchemaRows editor anywhere
  "bashInterceptor.patterns": "pg-shell",
};

// Keys hidden from every settings surface (page rendering AND search). Consumers
// live only in the base's CLI/TUI startup path (main.ts entry, setup wizard,
// splash, startup changelog banner, startup update check) or its TUI layer,
// none of which the desktop host loads — editing them here has no effect on the
// desktop app. (browser.tern/browser.cmux: Tern-pane / cmux-WKWebView browser
// surfaces never exist under the desktop host, which drives its own browser
// mirror.) startup.quiet stays visible: it also gates the SDK-side xd:// mount
// notices, which desktop sessions do emit.
export const HIDDEN_KEYS: Record<string, true> = {
  doubleEscapeAction: true,
  "browser.tern": true,
  "browser.cmux": true,
  // TUI interactive-mode only (consumers in src/modes/interactive-mode.ts):
  // composer/status-line chrome that the desktop host never loads — the
  // desktop renders its own Lexical composer and React status widgets
  "composer.shape": true,
  "composer.tokenRate": true,
  "statusLine.preset": true,
  "statusLine.separator": true,
  "statusLine.contextLine": true,
  "statusLine.sessionAccent": true,
  "statusLine.transparent": true,
  "statusLine.compactThinkingLevel": true,
  "statusLine.showHookStatus": true,
  "startup.showSplash": true,
  "startup.setupWizard": true,
  "startup.changelogMode": true,
  "startup.checkUpdate": true,
  // CLI entry path only (main.ts): desktop has its own session list, its own
  // update story, and no marketplace auto-update scheduler. git.enabled gates
  // nothing but the TUI status bar's git segment (verified: no tool consumer).
  "autoResume": true,
  "update.channel": true,
  "marketplace.autoUpdate": true,
  "git.enabled": true,
  // pi-tui rendering switches + theme name maps (setAutoThemeMapping /
  // setSymbolPreset effects feed the TUI theme engine only; the desktop has
  // its own CSS token themes, shiki dark-plus/light-plus, and diff colors).
  // display.hideToolActivity / showTokenUsage / colorBlindMode are NOT here:
  // the desktop implements its own consumers for those. display.showTurnTime
  // IS here: the desktop shows the turn time unconditionally.
  "display.showTurnTime": true,
  "theme.dark": true,
  "theme.light": true,
  "symbolPreset": true,
  "terminal.showImages": true,
  "terminal.showProgress": true,
  "tui.resizeScrollback": true,
  "tui.textSizing": true,
  "tui.renderMermaid": true,
  "tui.reactions": true,
  "tui.codexResetFireworks": true,
  "tui.titleState": true,
  "tui.titleSpinner": true,
  "tui.hyperlinks": true,
  "tui.mouse": true,
  "tui.tight": true,
  "tui.imeSafeCursor": true,
  "display.shimmer": true,
  "display.pinnedAgents": true,
  "display.subagentLivePreview": true,
  "display.smoothStreaming": true,
  "display.cacheMissMarker": true,
  "display.collapseCompacted": true,
  "showHardwareCursor": true,
  "task.showResolvedModelBadge": true,
};

// Preset default static map (covers all settings keys of SETTINGS_ZH); fallback when schema is not yet loaded or for offline tests
const DEFAULT_PAGE_KEYS: Record<string, string[]> = {
  "pg-general": [
    "power.sleepPrevention", "startup.quiet", "ask.timeout", "hideThinkingBlock",
  ],
  "pg-interaction": [
    "steeringMode", "followUpMode", "interruptMode", "tui.vimMode",
    "tui.vimModeDisplay", "loop.mode", "loop.conditionTimeoutMs", "composer.recallClearedDrafts",
    "treeFilterMode", "autocompleteMaxVisible", "spelling.typoDetection",
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
    "security.enabled", "ask.enabled", "tools.intentTracing",
    "tools.abortOnFabricatedResult", "tools.speculativeExecution.enabled", "tools.speculativeExecution.maxInFlight", "tools.maxTimeout",
    "async.enabled", "irc.timeoutMs", "tasks.todoClearDelay",
    "ida.python", "ida.installDir", "ida.maxOpen", "ida.idleCloseSec",
  ],
  "pg-computer": [
    "computer.maxWidth", "computer.maxHeight",
    "browser.headless", "browser.freezeOnTurnEnd", "browser.idleCloseSec", "browser.screenshotDir",
  ],
  "pg-mcp": [
    "tools.xdev", "tools.xdevDocs", "tools.xdevInlineDevices", "mcp.enableProjectConfig",
    "mcp.renderMarkdownResults", "mcp.notifications", "mcp.notificationDebounceMs",
  ],
  "pg-plugins": [
    "extensionHandlers.toolCallTimeoutMs", "marketplace.autoUpdate", "extensions", "disabledExtensions",
  ],
  "pg-appearance": [
    "colorBlindMode",
    "images.autoResize", "images.blockImages",
    "display.hideToolActivity", "display.showTokenUsage",
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
    "bashInterceptor.enabled", "bashInterceptor.patterns", "bash.direnv", "bash.direnvLoadTimeoutMs",
    "shellMinimizer.enabled", "shellMinimizer.sourceOutlineLevel", "shellMinimizer.settingsPath",
    "shellMinimizer.only", "shellMinimizer.except", "shellMinimizer.maxCaptureBytes", "shellMinimizer.legacyFilters",
    "eval.py", "eval.js", "eval.tools.enabled",
    "eval.workpool.freshAgents", "eval.autoBackground.enabled", "eval.autoBackground.thresholdMs", "python.kernelMode",
    "python.interpreter", "bash.autoBackground.thresholdMs",
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
  "pg-developer": [
    "dev.autoqa", "dev.autoqaPush.endpoint", "dev.autoqaPush.token", "dev.autoqaConsent",
    "gc.blobs", "gc.archive", "gc.wal", "gc.coldArchiveAfterDays", "gc.retainNewestGlobal",
    "gc.retainNewestPerCwd", "gc.stale", "gc.staleRetainNewest", "gc.staleRetainDays",
    "compaction.reserveTokens", "compaction.keepRecentTokens", "compaction.autoContinue",
    "compaction.remoteEndpoint", "compaction.v2RetainedMessageBudget",
  ],
  "pg-skills": [
    "skills.enableSkillCommands", "commands.enableClaudeUser", "commands.enableClaudeProject", "commands.enableOpencodeUser",
    "commands.enableOpencodeProject", "skills.registryUrl",
  ],
  "pg-hooks": [
    "extensionHandlers.toolCallTimeoutMs",
  ],
  "pg-providers": [
    "providers.maxInFlightRequests", "providers.openai-codex.codeMode", "providers.openai-codex.codeModeDirectTools", "providers.ollama-cloud.maxConcurrency",
    "providers.antigravityEndpoint", "live.voice",
    "tts.localVoice", "speech.enabled", "speech.mode",
    "speech.enhanced", "speech.voice", "providers.fetch", "codexResets.autoRedeem",
    "codexResets.minBlockedMinutes", "codexResets.keepCredits", "codexResets.salvageHorizonHours",
    "providers.fireworksTier",
    "providers.tinyModelDevice", "providers.tinyModelDtype",
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

