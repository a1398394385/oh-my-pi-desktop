# ACP 外部压缩准备：上游接口调研

> 调研日期：2026-11-17。对象：`can1357/oh-my-pi`。
> 代码基线：`main@1bdbf6d242d99ca62bdf2feeff4519ff992f647d`（2026-11-17T02:38:33Z）。
> 本仓安装版本：`@oh-my-pi/pi-*@18.20.0`；其 `CompactOptions` 与 `session_before_compact` 形状与上述 main 一致（已对照 `node_modules` 源码）。
> 本文是时点调研快照，不随上游更新；结论仅覆盖检索当日可见页面与默认分支源码。

## 1. 结论

**未找到**任何上游 issue、PR 或 discussion 提议：为 `CompactOptions` / `session.compact()` 增加外部或自定义 `CompactionPreparation`，或跳过 `prepareCompaction(raw journal)`、由扩展/客户端控制压缩输入视图与切点。

现有最接近的上游能力是 `session_before_compact` 返回 `{ compaction: CompactionResult }`：

- 可以自定义摘要正文、`firstKeptEntryId`（落盘切点）、`tokensBefore`、`details`、`preserveData`、`providerReplayThroughEntryId`；
- 但底座在发出该事件之前**已经**用当前分支的原始 entries 调用了 `prepareCompaction(...)`；
- 自动路径在 `prepareCompaction` 返回空时直接返回 `BLOCK_AUTOMATIC_CONTINUATION`，事件根本不会发出；
- `preparation.messagesToSummarize` / `turnPrefixMessages` / `recentMessages` / `tokensBefore` 仍来自原始 journal，钩子只能读取，不能替换；
- `CompactOptions` 没有任何接收 preparation / entries / messages 的字段。

因此：

1. 上游没有可直接复用的“外部 preparation”接口。
2. 只有“结果可替换、输入不可替换”的半个接口可复用，不足以满足本案“ACP 启用后任何压缩链路都不得使用原始 journal 消息视图”的约束。
3. 若要上游化，需要新增 API（最小形状见 §5）；在落地前只能通过绑定 18.20.0 的 `patches/` 实现。

## 2. 上游源码事实

| 事实 | 上游位置（`main@1bdbf6d`） |
|---|---|
| `CompactOptions` 仅有 `onComplete` / `onError` / `mode` / `internalGuidance` / `suppressContinuation` / `readerModel`，无 preparation 字段 | `packages/coding-agent/src/extensibility/extensions/types.ts:513-552` |
| 公开的压缩入口签名是 `compact(customInstructions?: string, options?: CompactOptions)` | `packages/coding-agent/src/session/agent-session.ts:8032` |
| 手动压缩先对分支跑 `prepareCompaction(pathEntries, settings, model, tokenizer)`，为空则抛 `ManualCompactionNoOpError`，之后才发钩子 | `packages/coding-agent/src/session/session-maintenance.ts:1424`、`:1440-1462` |
| 自动/context-full 路径同样先 `prepareCompaction`，为空直接阻断，不发钩子；主自动路径在 `:5470` 取准备、救援失败仍为空时阻断，钩子在 `:5615` 之后才发 | 同文件 `:1897-1898`、`:5470`、`:5615` |
| `session_before_compact` 事件携带 `preparation` 与 `branchEntries`，返回 `{ cancel?, compaction? }` | `packages/coding-agent/src/extensibility/shared-events.ts:82-101`、`:488-496` |
| 钩子结果被原样采纳：`summary`、`firstKeptEntryId`、`tokensBefore` 等直接来自 `hookCompaction` | `packages/coding-agent/src/session/session-maintenance.ts:3906-3930` |
| `session.compacting` 的输入仍是 `preparation.messagesToSummarize.concat(preparation.turnPrefixMessages)` | 同文件 `:3894` |
| `CompactionPreparation` 是公开类型，但只有 `prepareCompaction` 负责构造它 | `packages/agent/src/compaction/compaction.ts:1371-1396`、`:1482` |
| `CompactionResult` 含 `summary` / `shortSummary?` / `firstKeptEntryId` / `tokensBefore` / `details?` / `preserveData?` / `providerReplayThroughEntryId?` | 同文件 `:140-156` |
| 官方文档明确 `session_before_compact` 只能 cancel 或提供完整 `CompactionResult`，没有“提供 preparation”一项 | `docs/compaction.md:471-478` |

补充：`firstKeptEntryId` 落盘时上游 `SessionManager` 不校验其是否属于当前分支（`packages/coding-agent/src/session/session-manager.ts:3741`、`:3757` 仅写入），与本仓已知风险一致；这不是本调研要解决的问题，但决定了外部切点必须自校验。

## 3. Issue / PR / Discussion 清单

### 3.1 开放（open）

| 编号 | 标题 | 与本案相同点 | 差异 |
|---|---|---|---|
| [#12465](https://github.com/can1357/oh-my-pi/issues/12465) | Extensions cannot prune history: expose the session's shake on `ExtensionContext` | 明确指出 `session_before_compact` 只能给“summary + 一个保留边界”，不能表达“保留这些、丢弃那些”，且 `context` 事件只在 provider 边界生效、压缩仍按未过滤状态触发 | 诉求是暴露机械 `shake`，不是外部 preparation；不涉及 ACP |
| [#5661](https://github.com/can1357/oh-my-pi/issues/5661) | Feature request: expose shake (or a shake-equivalent compact mode) to `ExtensionContext` | 同属“扩展缺少压缩路径控制面” | 只要求调用既有 shake，不替换压缩输入 |
| [#12043](https://github.com/can1357/oh-my-pi/issues/12043) | Extensions cannot read effective settings (e.g. `compaction.keepRecentTokens`) | 压缩感知扩展拿不到底座的有效设置，说明扩展侧无法自行复算底座切点 | 是读取设置，不是提供 preparation |
| [#19018](https://github.com/can1357/oh-my-pi/issues/19018) | Feature request: a compaction-"harshness" control — per-invocation retention for `/compact`, and surface `keepRecentTokens` in `/settings` | 提出把一次性保留量经 `CompactOptions` 传给 `AgentSession.compact`，与“扩展参数化压缩”方向一致 | 仍由 `prepareCompaction` 在原始 journal 上算切点，只调保留量 |
| [#18979](https://github.com/can1357/oh-my-pi/issues/18979) | Extension primitives for capturing session learnings before context loss | 依赖压缩前事件与 committed transcript cursor；指出注册 `session_before_compact` 会关闭 speculative compaction | 是“压缩前捕获”，不是替换压缩视图 |
| [#9786](https://github.com/can1357/oh-my-pi/issues/9786) | ACP: /compact outcome ... only observable by matching agent-message prose | ACP 侧压缩集成缺口 | 只要求结果可观测，不涉及输入与切点 |
| [#19221](https://github.com/can1357/oh-my-pi/issues/19221) | ACP agents as a model provider ... with ... omp-owned compaction | ACP 与压缩所有权讨论；明确“omp 自有压缩” | 驱动外部 ACP agent 时由 omp 压缩自己的 transcript，仍需 omp 的 journal/prepare |
| [#14923](https://github.com/can1357/oh-my-pi/issues/14923) | `openai-responses` V2 compaction skips normal tool and context preparation | 同样讨论“压缩准备”语义 | 是 provider-native 路径漏做常规准备，方向相反（要求补上准备），不是允许外部替换 |
| [#17199](https://github.com/can1357/oh-my-pi/issues/17199) | feat(extensions): expose request preparation provenance and cancellation outcomes | 名称含 preparation | 指 provider request 的 preparation，与压缩准备无关，列为排除项 |

### 3.2 已合并（merged PR）

| 编号 | 标题 | 与本案关系 |
|---|---|---|
| [#8720](https://github.com/can1357/oh-my-pi/pull/8720) | fix(compaction): honor /clear reset boundary in `prepareCompaction` | 修复 `prepareCompaction` 忽略 `/clear`，方向是让原始 journal 准备更正确，而非允许外部准备 |
| [#11515](https://github.com/can1357/oh-my-pi/pull/11515) | fix(compaction): preserve retained history across soft compactions | 维持底座保留尾语义 |
| [#17384](https://github.com/can1357/oh-my-pi/pull/17384) | fix(acp): forward automatic compaction lifecycle notifications | 关闭 #16969，只补 ACP 观测通知，不改压缩输入 |

### 3.3 已关闭（closed issue，非 PR）

| 编号 | 标题 | 关闭日期 | 与本案关系 |
|---|---|---|---|
| [#1565](https://github.com/can1357/oh-my-pi/issues/1565) | Evaluate pi-blackhole (algorithmic compaction + observational memory) for omp | 2026-06-10 | 讨论把算法压缩作为 `CompactionResult` provider；未产出外部 preparation API |
| [#8718](https://github.com/can1357/oh-my-pi/issues/8718) | bug: manual /compact is sending over the entire transcript/log of the model after /clear | 2026-08-19 | 由 #8720 修复；证明维护方向是修正 `prepareCompaction` 的 raw journal 选取，而非绕开它 |
| [#16969](https://github.com/can1357/oh-my-pi/issues/16969) | ACP: forward `auto_compaction_start/end` so clients can see automatic compaction | 2026-11-01 | 由 #17384 实现；只是观测面 |

### 3.4 Discussion 与关闭未合并 PR

GitHub GraphQL `search(type: DISCUSSION)` 对 `repo:can1357/oh-my-pi compaction preparation` 返回 `discussionCount: 0`。按 `compaction preparation`、`session_before_compact`、`prepareCompaction` 等词检索 PR，未发现与本提案相关的关闭未合并（closed-unmerged）PR；命中的相关 PR 只有 §3.2 的已合并项。

## 4. 检索范围与限制

- 工具：`gh search issues`、`gh search prs`、`gh api search/code`、GraphQL Discussion search；仓库仅 `can1357/oh-my-pi`；默认分支 `main`；检索日期 2026-11-17。
- Issue/PR 检索词：`prepareCompaction`、`CompactionPreparation`、`CompactOptions`、`CompactionResult`、`preparation`、`compaction preparation`、`session_before_compact`、`firstKeptEntryId`、`custom compaction`、`compaction boundary`、`compaction view`、`external compaction`、`extension compaction`、`compaction input`、`compaction source`、`compact options`、`custom context compaction`、`seed compaction`、`import compaction`、`precomputed compaction`、`messagesToSummarize`、`journal compaction`、`compaction projection`、`transformContext compaction`、`ACP compaction`、`compaction takeover`、`active context compaction`、`ACP context`、`desktop compaction`、`external summarizer`、`custom cut point`、`compaction boundary control`、`extension supplied summary`、`compaction override summary`、`skip prepareCompaction`、`raw journal`、`compaction input view`、`provide messages to compact`、`extension controlled compaction`、`precomputed summary`、`commit compaction entry`、`compaction from summary`、`client-side compaction`、`ACP-owned compaction`。
- 代码检索：`"CompactionPreparation"`、`"compactionPreparation"`、`"externalPreparation"`、`"overridePreparation"`、`"compactSource"`、`"compactionSource"`、`"preparation?:"`。前两者命中现有类型/调用与测试；其余自定义准备字段均为 0 命中；`preparation?:` 仅出现在测试文件。
- 已完整读取正文的候选：#12465、#5661、#12043、#19018、#18979、#9786、#19221、#16969、#1565、#8718；其余命中按标题与摘要排除。
- 限制：GitHub 搜索引擎存在索引延迟与结果上限；本次未逐条读取所有历史 issue 的评论。**“未找到”仅代表上述检索范围与用词下未发现，不等同于上游不存在相关讨论。**
- 未在上游创建或评论任何 issue/PR。

## 5. 对本仓方案的影响

- 现行 ACP 接管（[acp-base-boundary-spec.md](architecture/acp-base-boundary-spec.md) W2/W3）已经刻意不使用 `preparation.messagesToSummarize`，但 `firstKeptEntryId` 仍沿用 `preparation.firstKeptEntryId`；也就是说输入视图已部分绕开 raw journal，**切点与“是否可压缩”的判断仍依赖 raw journal**。
- 本案要求的“任何触发、有效上下文计算、准备、摘要输入和回退都不使用原始 journal 消息视图”，上游没有对应接口，无法通过配置或现有钩子达成。
- 可复用的仅有两块：
  1. `CompactionPreparation` 类型形状（`compaction.ts:1371`）可作为新增 `CompactOptions.preparation` 的类型蓝本；
  2. `session_before_compact` 的“结果替换”语义可继续保留，用于取消或显式覆盖结果。
- 上游化最小提案（供后续 upstream issue/PR 使用，本调研不提交）：`CompactOptions` 增加可选 `preparation?: CompactionPreparation`；传入时 `compact()` 跳过 `prepareCompaction(raw journal)`，所有允许的回退方法只消费该 preparation；未传时保持现有 CLI 行为完全不变。命名可按上游习惯调整，但语义必须保持“外部准备优先、不得回退到 raw journal”。
- 在上游接受前，本仓只能走 `patches/`（绑定 18.20.0），不得直接改 `node_modules`。

## 6. 来源链接

- 上游源码（按提交）：[`extensions/types.ts`](https://github.com/can1357/oh-my-pi/blob/1bdbf6d242d99ca62bdf2feeff4519ff992f647d/packages/coding-agent/src/extensibility/extensions/types.ts#L513)、[`agent-session.ts`](https://github.com/can1357/oh-my-pi/blob/1bdbf6d242d99ca62bdf2feeff4519ff992f647d/packages/coding-agent/src/session/agent-session.ts#L8032)、[`session-maintenance.ts`](https://github.com/can1357/oh-my-pi/blob/1bdbf6d242d99ca62bdf2feeff4519ff992f647d/packages/coding-agent/src/session/session-maintenance.ts#L1424)、[`shared-events.ts`](https://github.com/can1357/oh-my-pi/blob/1bdbf6d242d99ca62bdf2feeff4519ff992f647d/packages/coding-agent/src/extensibility/shared-events.ts#L82)、[`compaction.ts`](https://github.com/can1357/oh-my-pi/blob/1bdbf6d242d99ca62bdf2feeff4519ff992f647d/packages/agent/src/compaction/compaction.ts#L1371)
- 上游文档：[`docs/compaction.md`](https://github.com/can1357/oh-my-pi/blob/1bdbf6d242d99ca62bdf2feeff4519ff992f647d/docs/compaction.md#L471)
- 上游 issue：[#12465](https://github.com/can1357/oh-my-pi/issues/12465)、[#5661](https://github.com/can1357/oh-my-pi/issues/5661)、[#12043](https://github.com/can1357/oh-my-pi/issues/12043)、[#19018](https://github.com/can1357/oh-my-pi/issues/19018)、[#18979](https://github.com/can1357/oh-my-pi/issues/18979)、[#9786](https://github.com/can1357/oh-my-pi/issues/9786)、[#19221](https://github.com/can1357/oh-my-pi/issues/19221)、[#1565](https://github.com/can1357/oh-my-pi/issues/1565)、[#8718](https://github.com/can1357/oh-my-pi/issues/8718)、[#16969](https://github.com/can1357/oh-my-pi/issues/16969)
- 上游 PR：[#8720](https://github.com/can1357/oh-my-pi/pull/8720)、[#11515](https://github.com/can1357/oh-my-pi/pull/11515)、[#17384](https://github.com/can1357/oh-my-pi/pull/17384)
