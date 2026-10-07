// English counterpart of settings-zh-CN.ts (same export names for the
// dictionaries). Mostly empty by design: the fallback chain in SchemaRows is
// `dict[key]?.label ?? def.ui.label ?? key`, and the base schema's own
// ui.label / ui.description are already English. Same for option labels
// (`dict[key]?.[value] ?? option.label ?? value`) and group titles.
// Exceptions that NEED real entries here:
// - composer.shape: the schema declares ui.options = "runtime" and SchemaRows
//   hardcodes the option list, so the English labels must live here.
// - Keys whose registry entry carries no ui metadata (skills.*/memories.*/
//   mnemopi.*/hindsight.*/sharpshooter.* …): without an entry the raw key
//   would render as the label. Listed below, grouped by settings page.
// DARK_THEMES / LIGHT_THEMES are language-neutral id lists and are therefore
// exported only from settings-zh-CN.ts.
export const SETTINGS_EN: Record<string, { label: string; description?: string; warning?: string }> = {
  // ---- pg-plugins ----
  "extensions": { "label": "External extension paths", "description": "List of external extension packages or file directory paths to register manually (comma-separated)" },
  "disabledExtensions": { "label": "Disabled extensions", "description": "Extension or plugin module names/IDs not to load (comma-separated)" },

  // ---- pg-skills ----
  "skills.enablePiUser": { "label": "omp user skills directory", "description": "Load skills from omp's own user-level skills directory (on by default)" },
  "skills.enablePiProject": { "label": "omp project skills directory", "description": "Load skills from the project's .omp skills directory (on by default)" },
  "skills.enableAgentsUser": { "label": "Agents user skills directory", "description": "Load skills from the user-level skills directory in ~/.agents (on by default)" },
  "skills.enableAgentsProject": { "label": "Agents project skills directory", "description": "Load skills from the project's .agents skills directory (on by default)" },
  "skills.enableClaudeUser": { "label": "Claude user skills directory", "description": "Load skills from the user-level skills directory in ~/.claude" },
  "skills.enableClaudeProject": { "label": "Claude project skills directory", "description": "Load skills from the project's .claude skills directory" },
  "skills.enableCodexUser": { "label": "Codex user skills directory", "description": "Load skills from the user-level skills directory in ~/.codex" },
  "skills.customDirectories": { "label": "Custom skills directories", "description": "Extra skills directories to load (~ prefix supported), comma-separated" },
  "skills.includeSkills": { "label": "Skills allowlist", "description": "Glob pattern list (comma-separated); when non-empty, only skills with matching names are loaded" },

  // ---- pg-model-behavior: thinking budget tokens ----
  "thinkingBudgets.minimal": { "label": "Minimal" },
  "thinkingBudgets.low": { "label": "Low" },
  "thinkingBudgets.medium": { "label": "Medium" },
  "thinkingBudgets.high": { "label": "High" },
  "thinkingBudgets.xhigh": { "label": "Extra high" },
  "thinkingBudgets.max": { "label": "Max" },

  // ---- pg-capabilities / pg-interaction ----
  "images.urls.options": { "label": "Image publishing options", "description": "JSON object keyed by backend name configuring each image URL publishing backend (gist, s3, …); the backend chain is chosen in the Vision group on the Model behavior page" },
  "images.urls.credentials": { "label": "Image publishing credentials", "description": "JSON object keyed by backend name holding access credentials for each image URL publishing backend" },
  "stt.language": { "label": "Recognition language", "description": "Recognition language code for voice dictation (e.g. zh, en)" },
  "composer.recallClearedDrafts": { "label": "Recall Cleared Drafts", "description": "Keep drafts cleared with Ctrl+C or double-Escape in local history until exit (recall with Ctrl+↑/Ctrl+↓); disabling affects future clears only" },

  // ---- pg-memory: local pipeline tuning ----
  "autolearn.minToolCalls": { "label": "Minimum tool calls", "description": "A session must accumulate at least this many tool calls before lesson extraction is considered at the end" },
  "memories.maxRolloutsPerStartup": { "label": "Scan limit per startup", "description": "Maximum number of rollout sessions processed per startup" },
  "memories.maxRolloutAgeDays": { "label": "Rollout retention days", "description": "Rollout sessions older than this no longer enter the summarization pipeline" },
  "memories.minRolloutIdleHours": { "label": "Minimum rollout idle hours", "description": "A session must be idle for at least this many hours before it is scanned and summarized" },
  "memories.threadScanLimit": { "label": "Thread scan limit", "description": "Maximum number of message threads scanned within a single rollout" },
  "memories.maxRawMemoriesForGlobal": { "label": "Global raw memory cap", "description": "Maximum number of raw memories aggregated into the global memory_summary.md" },
  "memories.stage1Concurrency": { "label": "Stage 1 concurrency", "description": "Parallelism of stage 1 (rollout summarization)" },
  "memories.stage1LeaseSeconds": { "label": "Stage 1 lease (seconds)", "description": "Lock lease duration for stage 1 tasks" },
  "memories.stage1RetryDelaySeconds": { "label": "Stage 1 retry delay (seconds)", "description": "Retry interval after a stage 1 task failure" },
  "memories.phase2LeaseSeconds": { "label": "Phase 2 lease (seconds)", "description": "Lock lease duration for stage 2 (global aggregation) tasks" },
  "memories.phase2RetryDelaySeconds": { "label": "Phase 2 retry delay (seconds)", "description": "Retry interval after a stage 2 task failure" },
  "memories.phase2HeartbeatSeconds": { "label": "Phase 2 heartbeat (seconds)", "description": "Heartbeat interval for stage 2 tasks, used to renew the lease" },
  "memories.rolloutPayloadPercent": { "label": "Rollout payload ratio", "description": "Fraction of rollout content read during summarization (0-1)" },
  "memories.phase1InputTokenLimit": { "label": "Stage 1 input budget", "description": "Input token cap per stage 1 summarization call" },
  "memories.fallbackTokenLimit": { "label": "Fallback token cap", "description": "Fallback token budget when the summarization model is unsupported" },
  "memories.summaryInjectionTokenLimit": { "label": "Summary injection budget", "description": "Token cap for memory summaries injected into session context" },

  // ---- pg-memory: Mnemopi tuning ----
  "mnemopi.retainEveryNTurns": { "label": "Retain frequency (turns)", "description": "Run an automatic retain every N conversation turns" },
  "mnemopi.recallLimit": { "label": "Recall result cap", "description": "Maximum number of memories returned per recall" },
  "mnemopi.recallContextTurns": { "label": "Recall context turns", "description": "Conversation turns looked back at when building recall queries" },
  "mnemopi.recallMaxQueryChars": { "label": "Recall query length cap", "description": "Maximum characters of recall query text" },
  "mnemopi.injectionTokenLimit": { "label": "Injection token cap", "description": "Token budget for injecting recall results into context" },
  "mnemopi.debug": { "label": "Debug mode", "description": "Emit debug logs for the Mnemopi backend" },

  // ---- pg-memory: Hindsight tuning ----
  "hindsight.bankIdPrefix": { "label": "Bank ID prefix", "description": "Prefix of the Hindsight memory bank ID" },
  "hindsight.bankMission": { "label": "Bank mission", "description": "Descriptive text written to the memory bank's mission field" },
  "hindsight.retainMission": { "label": "Retain mission", "description": "Mission text carried by retain requests" },
  "hindsight.retainEveryNTurns": { "label": "Retain frequency (turns)", "description": "Run an automatic retain every N conversation turns" },
  "hindsight.retainOverlapTurns": { "label": "Retain overlap turns", "description": "Conversation turns overlapped between adjacent retains" },
  "hindsight.retainContext": { "label": "Retain context", "description": "Environmental context attached to retains (JSON object)" },
  "hindsight.recallBudget": { "label": "Recall budget", "description": "Request budget per recall" },
  "hindsight.recallMaxTokens": { "label": "Recall token cap", "description": "Maximum tokens of a single recall result" },
  "hindsight.recallContextTurns": { "label": "Recall context turns", "description": "Conversation turns looked back at when building recall queries" },
  "hindsight.recallMaxQueryChars": { "label": "Recall query length cap", "description": "Maximum characters of recall query text" },
  "hindsight.recallTypes": { "label": "Recall types", "description": "Memory types restricted to on recall (array)" },
  "hindsight.debug": { "label": "Debug mode", "description": "Emit debug logs for the Hindsight backend" },
  "hindsight.requestTimeoutMs": { "label": "Request timeout (ms)", "description": "General request timeout for the Hindsight API" },
  "hindsight.reflectTimeoutMs": { "label": "Reflect timeout (ms)", "description": "Timeout of reflect calls" },
  "hindsight.recallTimeoutMs": { "label": "Recall timeout (ms)", "description": "Timeout of recall calls" },
  "hindsight.retainTimeoutMs": { "label": "Retain timeout (ms)", "description": "Timeout of retain calls" },
  "hindsight.mentalModelMaxRenderChars": { "label": "Mental model render cap", "description": "Maximum characters of mental model text injected into prompts" },

  // ---- pg-memory: Sharpshooter tuning ----
  "sharpshooter.intervalMinutes": { "label": "Consolidation interval (minutes)", "description": "Run interval of background decision-file consolidation" },
  "sharpshooter.injectionTokenLimit": { "label": "Injection token cap", "description": "Token budget for injecting decision files into context" },
};

export const OPTS_EN: Record<string, Record<string, string>> = {
  "hindsight.recallBudget": { "low": "Low", "mid": "Mid", "high": "High" },
  "composer.shape": { "band": "Status bar (default)", "box": "Rounded box", "claude": "Claude Code style", "pi": "Pi style", "borderless": "Borderless", "rule": "Top separator", "field": "Compact field", "rail": "Accent rail" },
};

export const GROUPS_EN: Record<string, string> = {};

// The "" prefix (keys without a dot) needs a real entry: the fallback for it
// would otherwise be an empty string rather than a readable group name.
// Every other prefix is already English in the schema.
export const ADV_PREFIX_EN: Record<string, string> = {
  "": "Misc",
};
