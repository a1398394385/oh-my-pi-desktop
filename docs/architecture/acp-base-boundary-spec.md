# ACP × 底座压缩：写侧接管 + 读侧认边界 Spec

**Status**: 待独立全量复审（v3.5，2026-11-10）· 未实施
**审阅记录**: v2 一轮独立审阅 NOT READY（7 项已闭环）→ v3 一轮 NOT READY（8 项阻断已按反例修订）→ v3.1 一轮独立审阅 NOT READY（5 项阻断已按反例修订）→ v3.2 设计问答发现保留尾部重复风险（已修订）→ v3.3 一轮独立审阅 NOT READY（4 项合同缺口已按反例修订）→ v3.4 一轮独立审阅 NOT READY（3 项阻断已按反例修订）→ **待独立全量复审**
**决策 SSOT**: `.agents/notes/0009-acp-base-compaction-baseline.md`
**取代**: 本文件 v1/v2（只做读侧建模，底座仍自己总结）；同时取代 BUG-129 的「cancel 守卫」行为

## 0. 一句话

底座判断「该压了」时，**由 ACP 用自己的投影生成摘要并交回底座落盘**；ACP 读侧把这条压缩边界当成 zone 的根块。**ACP 是唯一总结者，底座只做边界账本。**

## 1. 术语

| 词 | 含义 |
|---|---|
| 接管 | ACP 通过 `session_before_compact` 返回 `compaction`，使底座跳过自己的 LLM 总结 |
| 边界条目 | 分支上最新 `compaction` entry 的 `firstKeptEntryId` 所指条目；保留尾部从它开始，故它在 journal 中位于 compaction entry 之前 |
| 基线块 | 由该 compaction entry 合成的 ACP zone 根块（不落盘，纯推导） |
| 活跃区 | ACP 投影中未被任何块覆盖、可能被压缩的部分 |
| 让路 | ACP 不返回 `compaction`，底座按原路径自己总结 |

### 1.1 状态模型与硬不变量

持久状态只由当前 `getBranch()` 推导；请求投影快照是易失缓存，不是第二事实源。统一状态为：`R` = 最新 reset id（或无）、`C` = R 后最新 compaction（或无）、`Z` = live zone、`X` = Z 的覆盖并集、`T` = 各 live 块的前缀重写时间、`V` = 请求视图及其 branch entry id 快照。

| 事件 | 必须发生的状态转移 |
|---|---|
| 同分支普通追加 | R/C/Z/X/T 不变；V 只在完整 id 前缀匹配时增量续接 |
| ACP normal | 追加 acpSummary；Z 追加、X 并入；R/C 不变 |
| ACP strong | Z 由存活 strong 替换、X 并入全部覆盖；吞基线时 `supersedesBase` 稳定继承，T 取该代 `createdAt` |
| base 接管或让路落盘 | 都追加 compaction；重同步后 C 更新，旧 Z/X/T 按 R1/R4 重建；V 因追加区含边界而失效 |
| reset | R 更新、C 清空、Z/X/T 清空；V 失效 |
| 切分支、回退、重启 | 从目标当前分支重算 R/C/Z/X/T；V 失效，不继承旧分支缓存 |

硬不变量：

1. **单事实源**：R/C/Z/X/T 必须能仅从当前分支重建；运行态、重启与回退不得依赖进程内残留。
2. **连续保留**：底座保留区是从 `firstKeptEntryId` 起的原始连续后缀；压缩模型只接收其前的活跃前缀，zone 只作 `previousSummary`。
3. **覆盖不丢**：原始块不得同时作为已折叠覆盖与活跃正文重复出现；块退出 Z 时，其覆盖必须由存活块继承，否则让路。
4. **身份与时间分离**：`supersedesBase` 是稳定基线身份；`historyRewriteAt` 是当前存活摘要最近一次改写前缀的时间，二者不得互相推导。
5. **不对齐就不写**：无法证明分支、真实 id、连续切点或完整覆盖时，不写部分接管结果；历史无法安全投影时才 degrade。

## 2. 写侧契约

### W1 接管点

`host/acp-assembly.ts` 的 `session_before_compact` handler（仅 owner 会话）：

- 由「返回 `{cancel:true}`」改为「返回 `{ compaction }`」。
- `auto_compaction_start` / `auto_compaction_end` handler 保留为观测与状态同步，**不再 cancel**。
- 依据：钩子在底座 LLM 总结之前触发（`session-maintenance.ts:1370-1394`）；返回值 `compaction` 被原样采用（`shared-events.ts:474-483`、`session-maintenance.ts:3853-3865`）；此路径落盘的 entry **没有 `method` 字段**（`session-maintenance.ts:1596`）。
- **两层期限**：ACP 模型调用使用独立的 25s 取消期限，短于扩展 handler 的 30s 上限（`extensibility/extensions/runner.ts:136`，`EXTENSION_HANDLER_TIMEOUT_MS`）。将 `event.signal` 与该期限合成后显式传给 `completeSimple`；到期后等请求确认中止，再返回 `undefined` 让路，不重试。底座 30s 超时只通过 `Promise.race` 停止等待，不会中断 handler，也不会改写 `event.signal`，因此只能作为最后护栏，不能兼任模型请求的取消机制。
- **副作用**：只要 `session_before_compact` 有 handler，底座会关闭投机压缩与阈值延迟（`session-maintenance.ts:2261,2354,2589`）。接管上线后 base 的投机路径失效，需在 R9 记录。

### W2 输入构造

- 输入消息 = ACP 投影活跃区中的**压缩前缀**，不是整个活跃区：由 runtime 在 `projectView` 时缓存（`lastSource` / `lastBlocks` / `zone`），新增 runtime 方法 `activeZoneMessages(branchEntries)`、`zoneRenderText()` 供钩子取用，**钩子不另造投影算法**。当前 `AcpExtensionCtx` 只有 `{ sessionManager: { getSessionId() } }`（`host/acp-assembly.ts:113`），需扩到能拿到 state 句柄。
- **快照允许同分支追加，不要求 leaf 相等**：`projectView` 记录当时完整 branch entry id 序列与 leaf。`activeZoneMessages(branchEntries)` 取数时：当前 leaf 相同则直接复用；缓存的 entry id 序列是当前分支的严格前缀时，由 runtime 将缓存 leaf 之后的新增消息以真实 journal entry id 追加到 `lastSource` / `lastBlocks`，沿用 `annotateView` / `splitBlocks` 的同一 id、块拆分与计数规则，并把快照推进到当前 leaf。正常回复落盘、随后的 post-turn threshold 与手动 `/compact` 都走这条续接路径。
- **切分支或不可续接则失效**：缓存序列不是当前分支前缀、追加区含有 `compaction` / `reset_boundary`、或新增消息无法获得真实 journal id 时，直接让路；不得仅凭 leaf 不同就放行，也不得拿旧分支投影凑输入。`resyncToBranch()` 仍立即使快照失效。
- **保留尾部不得进入摘要正文**：快照续接后，按 `event.branchEntries` 中 `preparation.firstKeptEntryId` 的位置，把活跃区切成「切点之前的压缩前缀」与「从切点开始的连续保留尾部」；只有压缩前缀送进压缩模型。底座保留的是连续原始消息后缀，ACP 不得把这部分同时写进摘要，否则重建后摘要与原文重复。活跃区消息若不能用真实 journal entry id 与该切点对齐，直接让路。
- **旧摘要与保留尾部交叉覆盖时让路**：把待吞 zone 各块的 `compressedIds` 通过 `lastBlocks` 的 `sourceId` 映射回 journal entry id；若与 `firstKeptEntryId` 起的保留 entry id 集合相交，则不得把整个 zone 放进 `previousSummary`，也不裁剪部分摘要，直接让路。否则旧块退出 zone 后，其在保留尾部的覆盖集合会丢失，原文与摘要重复。
- **不使用** `preparation.messagesToSummarize`（journal 原文，正是要避免的）。
- `previousSummary` = 通过交叉覆盖检查后，zone 全部块按 journal 顺序渲染的文本 → 传给压缩模型作为「已有摘要」，使其只处理增量。
- 压缩模型：使用**当前对话模型**，经现有 `completeSimple` 通道（`host/auto-review.ts:187` 是最接近的现成用法），不新增配置（Q2 已确认）。

### W3 产出

```ts
{ compaction: { summary, firstKeptEntryId, tokensBefore } }
```

- `summary` = 纯摘要正文（不带 header）。底座会把它放进 transcript；读侧渲染时再加 `[acp-base]` 前缀，两侧都可读。
- **`firstKeptEntryId` 直接沿用 `preparation.firstKeptEntryId`**，ACP 不自己选边界。理由：该 id 由底座基于 branch 算出（`session-maintenance.ts:1358` 的 `prepareCompaction`），必然存在、且与底座下一次切分完全同源；自选 id 会引入「id 不在分支上 → 底座不校验就落盘 → 视图保留区整段消失」的静默丢历史（`session-manager.ts:3684-3712` 无校验；`session-context.ts:600-608` 找不到即丢弃保留区）。`preparation.firstKeptEntryId` 为空（session 需迁移的路径）→ 让路。
- `tokensBefore` = ACP 的 `projectedTokens` 估值（**估算口径，不是 provider 上报**；宿主侧没有 provider 上报字段）。auto 路径上底座会用 `branchTokensBefore` 覆写该值（`session-maintenance.ts:5976-5980`、`:6035-6039`），下游只用于展示（`session-context.ts:550-551`），读侧不得依赖其精确值。
- `shortSummary` 不填；`details` / `preserveData` 不填（避免读侧误判为原生回放）。

### W4 压后复核（启发式，非硬保证）

返回前估算「新上下文」并与底座同一目标线比较：

- 目标线 = recovery band，即 `floor(resolveThresholdTokens(...) * COMPACTION_RECOVERY_BAND)`（`pi-agent-core/src/compaction/compaction.ts:214`，底座 `#compactionCreatedHeadroom` 同口径 `session-maintenance.ts:4326-4335`）。
- 估算量必须是**候选压缩结果**，不是压缩前的 `projectedTokens`：用同一消息计数器计算 `countMessages([候选基线的 [acp-base] 渲染消息, ...从 firstKeptEntryId 起实际保留的原始消息]) + 非消息开销`（system prompt + tool schema；能复用底座 `computeNonMessageTokens` 就复用，否则按现有估算）。候选基线承接旧 zone，因此旧 zone 不得再计一次；保留尾部必须按实际保留原文计数，不得使用压前活跃区总量代替。
- 阈值必须用 per-model 解析（`session/model-compaction-threshold.ts:26` 的 `resolveModelCompactionSettings`），不能直接用全局 `CompactionSettings`。
- 不达标 → **让路**。该复核是启发式：即使通过，底座下一轮仍可能再次触发，此时由 W5 让路兜底。

### W5 护栏：任一失败即让路

| 条件 | 原因 |
|---|---|
| `preparation.firstKeptEntryId` 为空或不在 `getBranch()` 的 id 集合内 | 底座不校验，落盘坏 id 会让保留区整段消失 |
| 活跃区缓存缺失；缓存 entry id 序列不是当前分支前缀；追加区含 compaction/reset；新增消息无真实 journal id | 只允许同前缀追加续接；切分支或无法安全更新快照时让路 |
| 待吞 zone 的 `compressedIds` 与保留尾部 entry id 集合相交 | 交叉覆盖无法由新基线完整继承；吞并让原文与摘要重复 |
| 活跃区消息无法按真实 journal entry id 与 `firstKeptEntryId` 对齐 | 无法区分压缩前缀与保留尾部；继续会把保留消息重复写进摘要 |
| 压缩前缀为空且 zone 没有可承接的既有摘要 | 没有可落盘的新基线内容 |
| `event.signal.aborted`，或 ACP 25s 期限触发 | 用户取消或接管超时；先确认模型请求已中止 |
| handler 30s 超时 | 外层只停止等待；不能替代 ACP 的主动取消 |
| W4 不达标 | 见上 |
| 模型调用失败 | 让底座自己试一次，比整轮失败好 |

让路 = handler 返回 `undefined`（不带 `compaction`、不带 `cancel`）。

### W6 与 ACP 日常压缩的关系

- ACP 自己的 normal / strong 压缩（写 `acp-summary` custom entry）**保持不变**，平时由 ACP 分层触发。
- 底座触发时由 ACP 出结果写 compaction entry，且**不再同时写 acpSummary**（避免一次压缩两条记录）。
- 后果：这次压缩不进入 `acp-stats` / `acp-gain`（记入 R9 已知偏差）。

### W7 guard 变更的影响面

BUG-129 落地的 guard 语义（threshold/idle 取消、overflow/incomplete 先 degrade 再放行）被本 Spec 取代：

- threshold / idle：**接管**（W1-W5），不再取消。
- overflow / incomplete：**接管**；接管失败则让路，底座原路径继续（仍是 overflow 恢复）。
- 手动 `/compact`：**接管**；接管失败则让路。
- `degrade()` 不再由 guard 触发；改由读侧兜底（R5）在遇到无法建模的历史时触发。

## 3. 读侧契约

### R1 基线块合成

`host/acp-persist.ts` 新增纯函数 `baselineBlock(branch)`：

| 情形 | 结果 |
|---|---|
| 最新 `reset_boundary` 之后无 compaction | `{ kind:"none" }` |
| compaction 携带 provider 原生回放或图像归档（R5） | `{ kind:"native" }` → degraded |
| `firstKeptEntryId`（`""` 时 `providerReplayThroughEntryId`）定位失败 | `{ kind:"unlocatable" }` → degraded |
| 某条未被更强摘要取代的 acpSummary 的 `meta.supersedesBase` 等于该 compaction entry id | `{ kind:"none" }`（L3 已吞，见 R4） |
| 其余 | `{ kind:"block", block, boundaryEntryId }` |

先计算 `rewriteAt = Date.parse(entry.timestamp)`：journal entry 时间是 ISO 字符串，ACP `createdAt`、消息时间和 `historyRewriteAt` 都是毫秒数，禁止混用。

块字段：

- `id` = compaction entry id；`summary` = `entry.summary`；`meta.method = "base"`；`meta.depth = 0`；`meta.createdAt = rewriteAt`；`meta.supersedes = []`；`meta.keepIds = []`；`meta.forced` 不设。
- `meta.index = []`：**不做逐块清单**（header 不显示块数，只显示 `[acp-base]`）。
- `meta.compressedIds`：边界来自 `firstKeptEntryId` → 严格在其之前；来自 `providerReplayThroughEntryId` → 含它本身。依据 `session-context.ts:601-638`。
- `meta.tokensBefore` = `entry.tokensBefore`；`tokensAfter` = `entry.tokensAfter ?? 0`。

`rebuildAcpState(branch)` 先把最新 `reset_boundary` 作为 **zone 时代边界**：reset 之前的 acpSummary 一律不进 zone，即使未被 supersede；其数据仍保留供统计。reset 后无 compaction 时，`zone = reset 后未被 supersede 的 acpSummary`；有 compaction 时，`zone = [未被吞的基线（若有）, ...compaction 后未被 supersede 的 acpSummary]`，compaction 之前的 acpSummary 不进 zone。`compressedBlockIds` 只取最终 live zone 的 `compressedIds` 并集，不得从 reset 前或已退出 zone 的旧摘要继承。

### R2 对齐起点

`annotateView(view, entries, from?)` 的起点由当前分支状态决定，而不是由 `zone[0]` 是否存在决定：

| 当前分支状态 | `from` |
|---|---|
| 最新 reset 后有 compaction | 该 compaction 的 `boundaryEntryId`（`firstKeptEntryId`；原生回放例外仍先走 R5）；即使基线已被 strong 吞并，也仍从这里对齐 |
| 有 reset、之后无 compaction | 最新 reset entry id |
| 既无 reset 也无 compaction | 分支开头（省略 `from`） |

保留尾部在视图里、但在 journal 中位于 compaction entry 之前，从 compaction 起扫会把整段误判为伪 id；reset 后从全分支起扫则会让 64 条窗口外的新消息无法匹配（窗口 `ACP_ALIGN_WINDOW=64`）。扫描源改为 `getBranch()`；`AcpRuntimeState` deps 增加 `getBranch`。

### R3 投影

- 非 degraded 时丢弃 source 中 `role === "compactionSummary"` 的消息（改由基线块渲染）。
- 基线块渲染体：`{ role:"user", content: "[acp-base]\n<summary>", synthetic:true, timestamp: rewriteAt }`，并带 `historyRewriteAt = rewriteAt`。
  - `historyRewriteAt` 是崩溃保护必需项：底座靠被丢弃的那条 summary 消息上的同名字段让保留尾部的 bound-thinking 签名失效（`transform-messages.ts` 按 `latestRewriteAt` 剥离）；漏掉会让失效签名被重放。
- 顺序：zone 按 journal 顺序（基线最前）→ 其后按 source 顺序。

### R4 L3 可吞基线

strong 压缩时：

- 新 acpSummary 的 `meta` 新增显式字段 `supersedesBase?: string`。直接吞基线时，值为被吞基线块的 id（= compaction entry id）；吞掉已经携带该字段的旧摘要时，必须原样继承。该字段沿 strong 链逐代传递，不能只在第一代写。
  - **不能用现有的 `supersedes: string[]`**：它的三个消费点（`acp-persist.ts:134-135`、`acp-projection.ts:326-329`、`acp-refs.ts:120-127`）都只在 acpSummary 集合内部匹配，compaction entry id 不在其中，会被静默忽略；且 `AcpRefBook` 不给 compaction entry 编 `bN`。
  - 实现时须确认 `parseSummary`（`acp-persist.ts:82`）对该新字段放行（落盘数据会带它）。
- `compressedIds` 并入基线块的 `compressedIds`（边界前历史仍算已折叠）。
- 摘要正文**必须拼接**基线 summary（内容不丢），再附本次强压结果。
  - 预算条款：拼接部分不参与 `÷divisor` 折算；`summaryBudgetMax` 至少扩到「基线渲染 token + 最小新摘要」，否则 `summary-over-budget` 会让 L3 吞并永远无法落地（`acp-compress.ts:224-236`、`acp-plan.ts:115-121`）。
- 运行时 `zone = [written]` 保持不变；重建侧看 `supersedesBase` 命中（R1 表第 4 行）得到同一结果 → 运行时与重启同构。
- `supersedesBase` 与 `historyRewriteAt` 必须分开处理：前者是稳定基线身份，沿 strong 链原样继承；后者是**当前存活 strong 最近一次改写前缀的时间**，直接吞或间接吞基线时都取新 `written.meta.createdAt`，不得继承基线或上一代 strong 的时间。运行时直接使用 `written.meta.createdAt`；重启与回退从当前分支存活 strong 的持久化 `createdAt` 重建。基线未被吞时才使用基线自身的 `rewriteAt`。
- normal 压缩不动基线（不写 `supersedesBase`）。
- 回退只撤销落在回退点之后的 strong：回退到 S2 前但 S1 后时，S1 仍吞基线；一直回退到首个携带该 `supersedesBase` 的 strong 之前，基线块才复活。

### R5 兜底

下列情形 `degraded: true`、`zone: []`、投影原样透传：

- `getAnthropicCompactionPayload(entry.preserveData)` 命中（`pi-agent-core/compaction/anthropic.ts`）。
- `entry.preserveData?.openaiRemoteCompaction` 存在（保留条目只存在于 payload 中）。
- `entry.method === "snapcompact"` 且 `preserveData.snapcompact` 存在（归档历史是图像块，`CompactionEntry` 无 `blocks` 字段，重新渲染会丢内容）。

本 Spec 接管后新产生的 entry 无 `method`、无 `preserveData` → 不会误判。

### R6 事件与重建

- `session_compact` → `resyncToBranch`（下一请求生效）。
- `projectView` 每请求比对当前分支的 `(最新 reset_boundary id, 最新 compaction entry id)` 与重建时指纹；任一不一致就调用 `resyncToBranch` 重建 zone 与 `compressedBlockIds`（mid-turn 阈值路径是 detached emit，不能只靠事件）。前后都没有基线但新增 reset 时，reset id 的变化仍必须触发重建。
- 比对只扫 `getBranch()` 返回的**当前分支**尾部找 `compaction` / `reset_boundary`，不扫描整份条目。不得改用 `getEntries()`：它包含已放弃的兄弟分支，会把其他分支的边界误认成当前基线。

### R7 计数

`zoneTokens` / `status()` / 保险线沿用现有口径（对 `this.zone` 求和），基线块自动计入。`#ratio` 校准不改。

### R8 纯推导

不新增 journal entry 类型；基线块与 zone 组成全部由分支推导，重启结果一致。

### R9 已知偏差

- **接管产生的压缩在 ACP 统计中完全不可见**（不写 acpSummary）；且它之前的 acpSummary 行仍按 `compressedTokens × requestsAfter` 计 `savedTokens`（`acp-stats.ts:198-202`、`acp-gain.ts`），收益持续高估。UI 的 ACP 统计页（`ui-src/components/settings/stats/routes/AcpRoute.tsx`）沿用同一口径。
- **base 的投机压缩失效**：`session_before_compact` 存在 handler 后，底座的投机压缩与阈值延迟被关闭（`session-maintenance.ts:2261,2354,2589`）。
- 跨重启 `bN` 编号可能与压缩当轮不同（只影响跨重启的 `keep` 引用）。
- 原生回放 / 旧 snapcompact 会话永久停在 degraded（互斥态）。

## 4. 验收矩阵

| # | 场景 | 判据 | 承载 |
|---|---|---|---|
| 1 | 底座发 `session_before_compact`（mock 模型） | ACP 返回 `compaction`；底座不调用自己的总结（无 fold 请求）；落盘 entry 的 `method === undefined`、`firstKeptEntryId === preparation.firstKeptEntryId`；送进压缩模型的输入来自 ACP 投影（尺寸显著小于同分支 journal 原文） | 新 smoke |
| 2 | 接管输入的构造 | 送进压缩模型的消息 = ACP 投影活跃区中位于 `firstKeptEntryId` 之前的压缩前缀（不含 journal 原文、不含 zone 块正文、不含保留尾部）；`previousSummary` 含 zone 渲染 | 新单测 |
| 3 | 保留尾部为伪 id | handler 让路（不返回 compaction），底座走原路径 | 新单测 |
| 4 | W4 不达标 | 让路，不返回 compaction | 新单测 |
| 5 | signal 中止 | 让路；无部分写入 | 新单测 |
| 6 | 分支 `[m1…m70, compaction(firstKept=m65), m71]` | `zone=[base]`；`compressedIds` 含 m1…m64、**不含 m65**；`annotateView` 从 m65 起扫 | 新单测 |
| 7 | 同 #6 投影 | 分别验收：① m65…m71 都保留真 journal id，不退化成 `view:`；② `activeTokens` 包含全部未压缩的 m65…m71，而非只算 m71；③ manifest 只列扣除保护尾部、伪 id 和状态对之后的候选。另构造 m65…m70 受尾部保护的用例：它们仍计入 `activeTokens`，但不要求进入 manifest | 新单测 |
| 8 | 边界后有一条 acpSummary | `zone=[base, summary]`；边界前的 acpSummary 不出现 | 新单测 |
| 9 | 分支回退到边界之前 | 无基线；旧 acpSummary 恢复；不 degraded | 新单测 |
| 10 | 两次 base 压缩 | 只取最新一条 | 新单测 |
| 11 | `/clear`：分别构造 `[compaction, reset_boundary, m11]` 与 `[A(acpSummary), reset_boundary, m11…m80]` | 最新 reset 后无 compaction 时无基线；旧 A 不进 zone，`compressedBlockIds` 为空，投影只含 reset 后消息；`annotateView` 从 reset id 起扫，m11…m80 均保留真实 journal id，不退化成 `view:`。前后都无 compaction 时，reset id 变化仍触发重建；旧 A 不得复活 | 新单测 |
| 12 | 原生回放三形态（anthropic payload / openaiRemoteCompaction / snapcompact） | 各自 degraded，投影原样透传 | 新单测 |
| 13 | strong 吞基线 | `meta.supersedesBase === base id`；重建后 zone 无 base；新摘要正文含基线 summary；`historyRewriteAt === strong.meta.createdAt`，而非基线时间 | 新单测 + `smoke-acp-strong.ts` |
| 14 | 吞基线后回退 | 回退到该 strong 之前 → 基线复活 | 新单测 |
| 15 | 投影输出 | 无 `compactionSummary`；首块 `[acp-base]` 无数字；`timestamp` / `historyRewriteAt` 均为等于 `Date.parse(entry.timestamp)` 的有限毫秒数；用带 `thinking.prefixBinding` 的模型实际跑 `transformMessages`，确认边界前保留尾部的旧 bound-thinking 被剥离；`assertToolPairing` 通过 | 新单测 + `acp-projection-pairing.test.ts` |
| 16 | 保险线与 drift | 基线入 zone 后 projected 不误触 relief；`#ratio` 仍在 0.7–1.6 | `acp-drift.test.ts` 增例 |
| 17 | 回归 | `smoke-acp-tool` / `-strong` / `-persist` / `-synth` / `-forced` / `-projection` / `-tiermode` / `acp-drift` / `acp-projection-pairing` / `acp-branch-resync` / `acp-compaction-guard` 全绿；`bun run check`、`host:build` | 命令 |
| 18 | 真机 | overflow 触发 → ACP 接管 → 落盘 → 下一请求 `context_status` 可用 → 重启后 zone 一致 | 手工 |
| 19 | ACP 模型调用超过 25s | `completeSimple` 收到由 `event.signal` 与 ACP 期限合成的 signal，并实际观察到 abort；请求结束后 handler 才让路，底座随后走原路径；底座开始自己的总结时不存在仍未结束的 ACP 请求，也没有迟到写入。另验证外层 30s 超时只停止等待，不被当作请求取消证据 | 新单测 |
| 20 | W4 口径 | 目标线 = recovery band、阈值走 per-model 解析；估算量 = 候选基线渲染 + 实际保留消息 + 非消息开销，旧 zone 不重复计数。构造压前投影 110K、开销 10K、目标线 80K、候选摘要 8K、保留尾部 20K：必须按候选 38K 通过，不得按压前 120K 拒绝；另构造候选结果超过目标线的拒绝用例 | 新单测 |
| 21 | strong 拼接收费 | 拼接基线正文后不被 `summary-over-budget` 拒绝；新上限 = 基线渲染 token + 折算后的新摘要 | 新单测 |
| 22 | 分支 A 投影后切到 B，未再次 `projectView` 就 `/compact` | 缓存 entry id 序列不是 B 的前缀 → 让路；A 的活跃区不得送进压缩模型；`getEntries()` 尾部即使留有兄弟分支的 compaction，也不得改变 B 的基线判断 | 新单测 + `acp-branch-resync.test.ts` |
| 23 | 基线 B 时间 1000 → strong S1 时间 2000 吞 B → strong S2 时间 3000 吞 S1 → 重启与逐级回退 | S1/S2 的 `supersedesBase` 均为 B；`historyRewriteAt` 分别为 2000/3000，重启后仍为 3000 且 B 不复活；回退到 S2 前、S1 后恢复 2000；回退到 S1 前时 B 才复活并恢复 1000。用带 `thinking.prefixBinding` 的模型实际跑 `transformMessages`，确认各代按各自重写时间剥离失效签名 | 新单测 + `smoke-acp-strong.ts` |
| 24 | 文件 `[m1,m2,m3,m4,A(acpSummary 覆盖 m1,m2),m5]` 上接管 | ① `firstKept=m4` 时，模型新增输入只有 m3，`previousSummary` 承接 A，m4/m5 不得进入摘要；C 追加在 m5 后，投影为 `[C,m4,m5]`，A 不单独渲染且 m4/m5 各只出现一次。② `firstKept=m3` 时，新增压缩前缀为空，C 只承接 A，投影为 `[C,m3,m4,m5]`；不得要求跳过 m4 来构造非连续保留区 | 新单测 + 新 smoke |
| 25 | 请求前 `projectView` 后，同分支追加正常 assistant 回复，再触发 post-turn threshold；另在追加后手动 `/compact` | leaf 已推进但缓存 entry id 序列仍是当前分支前缀：runtime 续接追加消息并推进快照，不得仅因 leaf 不同让路；新增回复必须按 `firstKeptEntryId` 进入压缩前缀或连续保留尾部（最新回复通常属于保留尾部），不得丢失或重复，并计入 W4 的对应部分。追加区含 compaction/reset 或缓存不是前缀时仍让路 | 新单测 + 新 smoke |
| 26 | A 的 `compressedIds` 覆盖 `{m1,m4}`，底座 `firstKept=m3` | A 与保留尾部 `{m3,m4,m5}` 在 m4 交叉：handler 让路，不返回 compaction，不调用 ACP 摘要写入；不得吞并 A 后让 m4 原文与摘要同时出现 | 新单测 |

## 5. 不做的事

- 不改 `@oh-my-pi/pi-coding-agent`，不加 patch。
- 不新增 RPC / 能力 / 远程规则项。
- 不新增 journal entry 类型。
- 不实现原生回放与 snapcompact 归档的基线化（一律 degrade）。
- 不做基线的逐块 index（header 不带数字）。
- 不改 UI，不修 `acp-stats` 口径（R9 记录）。

## 6. Open Questions

| # | 问题 | 当前状态 | Decider | 门禁 |
|---|---|---|---|---|
| Q1 | ACP 是否主动调用 `session.compact()` 制造边界 | **已确认：不主动调用（2026-11-10）**。触发权仍归底座；底座 threshold 同时使用存储上下文估值与 provider 用量，因此即使 ACP 投影很小，原始 journal 仍可能触发 base 压缩。边界不局限于 overflow / 手动场景 | 用户 | 已关闭 |
| Q2 | 接管时用哪个模型出摘要 | **已确认：使用当前对话模型（2026-11-10）**，经 `completeSimple`，不新增配置 | 用户 | 已关闭 |
| Q3 | `acp-stats` 是否要读 compaction entry 补统计 | 本 Spec 不做（R9） | 用户（后续任务） | 不阻塞本 Spec |

## 7. 与既有工作的关系

- 保留 v2 的读侧结论（边界条目对齐、`getBranch` 扫描、`historyRewriteAt`、`/clear`、原生回放兜底）；strong 对基线的吞并及跨代继承以 R4 为准。
- 取代 BUG-129 的 cancel 守卫：guard 由「取消」改为「接管」，`degrade()` 不再由 guard 触发。
- `host/acp-runtime.ts` 的 strong 分支（`zone = [written]`）**不变**，因为基线此时已被吞并进新摘要（R4）。

## 8. 审阅反例闭环（v3.1–v3.5）

| # | 反例 | 修法落点 |
|---|---|---|
| 1 | 底座不校验 `firstKeptEntryId`，坏 id 会让保留区整段消失 | W3 改为沿用 `preparation.firstKeptEntryId`；W5 仍校验其存在 |
| 2 | 手动路径的切点由底座算出，ACP 自报边界不可靠 | 同上（不再自报） |
| 3 | `AcpExtensionCtx` 只有 sessionId，钩子拿不到投影 | W2 要求扩 ctx + runtime 暴露 `activeZoneMessages()` / `zoneRenderText()` |
| 4 | `tokensBefore` 没有 provider 上报口径，auto 路径还会被覆写 | W3 改为填 `projectedTokens` 估算并注明会被覆写 |
| 5 | ACP `projectedTokens` 与底座阈值不同量纲，抖动判断失效 | W4 改为 recovery band + 非消息开销 + per-model 阈值 |
| 6 | 接管不写 acpSummary → 统计完全不可见且旧行仍虚高 | R9 明写两条偏差 |
| 7 | `supersedes` 的三个消费点都不认 compaction entry id | R4 改为新增 `meta.supersedesBase`，并注明 `parseSummary` 需放行 |
| 8 | strong 拼接基线正文会撞 `summary-over-budget` | R4 加预算条款（拼接部分不折算、上限至少扩到拼接下限） |
| 9 | 扩展 handler 有 30s 硬超时 | W1 写明超时即让路；新增验收 #19 |
| 10 | 有 handler 时底座关闭投机压缩与阈值延迟 | R9 记录；新增验收 #20 只测口径 |
| 11 | 切分支后活跃区缓存仍属于旧分支；全 journal 尾部含兄弟分支边界 | W2 绑定 leaf、失配让路；R6 只扫当前分支；验收 #22 |
| 12 | 第二代 strong 取代第一代后，基线因未继承 `supersedesBase` 而复活 | R4 规定基线 id 逐代继承；验收 #23 |
| 13 | ISO entry 时间直接流入毫秒比较，旧 bound-thinking 不失效 | R1/R3 统一 `Date.parse`；验收 #15 检查数值与签名结果 |
| 14 | 验收 #7 漏算保留尾部，并无条件要求受保护消息进 manifest | 验收 #7 拆成真 id、活跃区计数、候选资格三项 |
| 15 | 外层 30s `Promise.race` 不取消使用 `event.signal` 的模型请求 | W1 增加 25s 主动取消期限；验收 #19 检查无遗留请求 |
| 16 | ACP 总结整个活跃区，而底座又保留其中的连续后缀，导致摘要与原文重复 | W2 只压缩 `firstKeptEntryId` 之前的活跃前缀；W5 增加切点对齐护栏；验收 #24 覆盖保留 m4/m5 与纯承接 A 两种切点 |
| 17 | 正常回复推进 leaf 后，leaf 相等护栏误拒 post-turn 与手动接管 | W2 改为 branch entry id 前缀校验 + runtime 增量续接；非前缀、追加区含边界仍让路；验收 #25 |
| 18 | 旧 A 已压缩保留尾部中的 m4，吞并 A 后新基线未继承该覆盖，m4 原文复活 | W2/W5 规定 zone 覆盖与保留尾部相交即整体让路，不裁剪摘要；验收 #26 |
| 19 | W4 用压前 `projectedTokens` 评估候选结果，110K 压前误判 38K 候选 | W4 改为候选基线 + 实际保留消息 + 非消息开销；验收 #20 覆盖 38K 通过及超线拒绝 |
| 20 | reset 后无 compaction 时旧 acpSummary 仍进 zone，且 compaction id 不变导致不重建 | R1 以 reset 过滤 zone 与 compressedIds；R6 比较 reset+compaction 双 id；验收 #11 |
| 21 | reset 后无基线时从全分支对齐，64 窗口外新消息变伪 id | R2 增加 compaction / reset / 普通分支三类起点；验收 #11 扩展到 m80 |
| 22 | strong 永久继承基线 `historyRewriteAt`，新生成签名不会被后续强压失效 | §1.1 与 R4 分离稳定基线身份和最近重写时间；验收 #13/#23 检查运行、重启与回退 |
| 23 | 旧 Q1 假设 ACP 投影小就不会触发 base threshold | Q1 改为已确认不主动 compact，并记录存储估值与 provider 用量两种触发输入 |

未覆盖（本轮未验证，实施前需实测）：threshold 自动与 overflow/incomplete 三条入口对 `result.compaction` 的尊重是否一致；`parseSummary` 对新字段的容忍度；接管后半段与 BUGS.md / `acp-compaction-spec.md` §5.3 的措辞一致性。
