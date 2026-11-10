# ADR-0009: ACP 接管底座压缩的总结，并把压缩边界作为 zone 根块

**Status**: Proposed(2026-11-09)
**Decider**: 待用户确认（agent 起草，用户提出方向并逐轮收敛）
**Informed by**: `docs/architecture/acp-compaction-spec.md`（§5.3 互斥契约）、BUG-129（pin → 会话级守卫）、底座 `@oh-my-pi/pi-coding-agent` 18.16.0 源码

## Context(背景)

现行 ACP 与底座自动压缩是**互斥**关系：journal 里出现 `type:"compaction"` 就 `degraded: true, zone: []`，本会话 ACP 永久退场。BUG-129 把互斥从 settings pin 下沉为会话级守卫（threshold/idle 取消，overflow/incomplete 先降级再放行），语义更干净，但「一次 overflow 之后永久失去 ACP」仍是硬结局。

互斥有两个独立问题，前期只讨论了第一个：

1. **状态失配**：底座压缩在 journal 追加边界（`firstKeptEntryId`），其覆盖的消息不再进入视图（`session-context.ts:358-364`）。ACP 的 id 空间与视图错位 → 重建判据失效、`annotateView` 越过边界整片伪 id → ACP 空转。
2. **重复总结**：底座压缩的输入是 **journal 原文**（`prepareCompaction` 取 `boundaryStart` 之后的原始 entries，`compaction.ts:1523-1531`），而不是 ACP 投影。ACP 已折叠的原文会被底座再 fold 一遍，成本随会话长度线性增长；超窗时还要切窗多次调用（`compaction.ts:936-961`）。

用户提出的方向（本轮收敛）：底座判断「该压了」时，**不要用原始上下文请求 LLM 压缩，而用 ACP 视角下的上下文**；同时底座生成的 summary 也应被 ACP 当作自己的压缩块，并允许在 L3 时被吞并（长期留一份基线没有意义）。

可行性核查：

- 底座留了接管口：`session_before_compact` 可返回 `compaction: CompactionResult`（`extensibility/shared-events.ts:474-483`），底座**原样采用并跳过自己的 LLM 总结**（`session-maintenance.ts:3853-3865`，`fromHook` 分支）；该路径落盘的 entry **没有 `method` 字段**（`session-maintenance.ts:1596`）。
- 边界可推导：`CompactionEntry` 带 `firstKeptEntryId` / `providerReplayThroughEntryId` / `summary` / `tokensBefore`（`session-entries.ts:160-183`），分支是纯数据结构。
- 摘要位置安全：底座摘要消息 `role = "compactionSummary"` 是 `messages[0]`（`session-context.ts:358-364`）；system prompt / tools / 记忆 / 仓库规则都不在 messages 数组。

## Decision(决策)

**ACP 成为唯一总结者；底座只负责边界落盘。读侧把边界当成 zone 根块，并允许 L3 吞并它。**

1. **写侧接管**：`session_before_compact`（仅 owner 会话）由「返回 `{cancel:true}`」改为「返回 `{compaction: {summary, firstKeptEntryId, tokensBefore}}`」。输入 = ACP 投影活跃区中位于 `preparation.firstKeptEntryId` **之前的压缩前缀**，zone 摘要渲染后作 `previousSummary`；从切点开始的连续保留尾部不得进入摘要正文。**不使用** `preparation.messagesToSummarize`。投影快照记录完整 branch entry id 序列：当前分支以缓存序列为前缀时，由 runtime 用真实 journal id 和既有拆分/计数规则增量续接新增消息，正常回复推进 leaf 不构成失效；非前缀、追加区含 compaction/reset 或新增消息无法对齐时让路。待吞 zone 的 `compressedIds` 经 `sourceId` 映射后若与保留尾部相交，也整体让路，不裁剪旧摘要。
2. **压后复核是同量纲的启发式**：目标线取 recovery band（`floor(threshold × 0.8)`），估算量 = 候选基线渲染 + `firstKeptEntryId` 起实际保留的原始消息 + 非消息开销，使用同一消息计数器且旧 zone 不重复计数；**不得使用压前 `projectedTokens`**。阈值走 per-model 解析（`resolveModelCompactionSettings`）。不达标即**让路**（不返回 compaction），避免「压完仍超阈值 → 下一轮立刻再触发」的抖动；即使通过，底座下一轮仍可能再触发，由护栏兜底。
3. **边界由底座定，ACP 不自报**：`firstKeptEntryId` 直接沿用 `preparation.firstKeptEntryId`（底座基于 branch 算出，必然存在且与下次切分同源）。底座落盘时不校验该 id，自报错 id 会让视图保留区整段消失（`session-manager.ts:3684-3712` 无校验）。护栏即让路：该 id 为空或不在 `getBranch()` 内、投影缓存缺失或不是当前分支前缀、追加区含边界、活跃消息无法对齐切点、待吞 zone 与保留尾部交叉覆盖、压缩前缀与可承接 zone 均为空、`event.signal.aborted`、ACP 25s 期限、W4 不达标、模型失败——任一命中都不返回 `compaction`。模型调用把 `event.signal` 与 25s 期限合成后传给 `completeSimple`，到期先确认请求中止再让路；外层 handler 30s 超时只停止等待，不承担取消。落盘坏边界比不压缩更糟。
4. **一次压缩一条记录**：接管路径只写 compaction entry，**不再同时写 `acpSummary`**（否则同一压缩两条记录）。
5. **读侧基线块**：`baselineBlock(branch)` 取**最新 `reset_boundary` 之后**的最新 compaction entry → 合成 `method:"base"` 的 zone 根块。最新 reset 同时是 zone 时代边界：reset 前的 acpSummary 一律退出 zone，`compressedBlockIds` 只从 reset 后最终 live zone 重建。`compressedIds` = 边界条目之前（边界来自 `firstKeptEntryId`）或含它（来自 `providerReplayThroughEntryId`）；`index = []`（header 只显示 `[acp-base]`，不显示块数）。entry 的 ISO `timestamp` 先经 `Date.parse` 转成毫秒 `rewriteAt`，再用于 `meta.createdAt`、渲染体 `timestamp` 和 `historyRewriteAt`。
6. **基线可被 L3 吞并**：strong 压缩写新字段 `meta.supersedesBase = 基线块 id`（不能用 `supersedes` 数组：它的三个消费点只匹配 acpSummary 内部 id，compaction entry id 会被静默忽略）、并入其 `compressedIds`、摘要正文拼接基线 summary（拼接部分不参与 `÷divisor` 折算，摘要上限至少扩到拼接下限，否则 `summary-over-budget` 会让吞并永远无法落地）。后续 strong 吞掉携带该字段的旧摘要时，`supersedesBase` 作为稳定基线身份逐代原样继承；`historyRewriteAt` 则表示当前存活 strong 最近一次改写前缀的时间，直接吞或间接吞基线时都取新 `written.meta.createdAt`，运行、重启与回退均从该代持久化记录重建，不继承基线或上一代时间。重建侧靠 `supersedesBase` 判定「该边界已被吞」→ 不再合成基线。运行时 `zone = [written]` 不变，因此运行时与重启同构；只有回退到首个携带该字段的 strong 之前，基线才复活。
7. **投影**：非 degraded 时丢弃 `role:"compactionSummary"` 消息，改由基线块渲染成 `[acp-base]\n<summary>`，并带数值型 `historyRewriteAt = Date.parse(entry.timestamp)`（漏掉它或混入 ISO 字符串都会让保留尾部的 bound-thinking 失效签名被重放）。基线被直接或间接吞并后，新 acpSummary 渲染体的 `historyRewriteAt` 改为该代 `meta.createdAt`；`supersedesBase` 只负责定位基线身份，不负责提供重写时间。
8. **对齐起点由当前分支状态决定**，扫描源 = `getBranch()`：reset 后有 compaction 时从该 compaction 的 `boundaryEntryId` 起扫（基线被吞也一样）；只有 reset 时从最新 reset id 起扫；两者都无则从分支开头起扫。保留尾部在视图里、但在 journal 中位于 compaction entry 之前，起错点会让整段退化成伪 id；reset 后从全分支起扫会让 64 条窗口外的新消息无法匹配。每请求以 `(最新 reset id, 最新 compaction id)` 为重建指纹，任一变化都重建 zone 与覆盖集合；只扫当前分支尾部，不能用包含兄弟分支的 `getEntries()`。
9. **原生回放与归档例外**：判定只看 `CompactionEntry` —— `getAnthropicCompactionPayload(preserveData)`、`preserveData.openaiRemoteCompaction`、`method === "snapcompact"` 且 `preserveData.snapcompact` 任一命中即 `degraded`。接管产生的新 entry 无 `method`/`preserveData`，不会误判。
10. **guard 由「取消」改为「接管」**：threshold/idle/overflow/incomplete/手动 `/compact` 都走接管；接管失败才让路。`degrade()` 不再由 guard 触发，改由读侧兜底（原生回放、边界定位失败）。
11. **单事实源与已确认选项**：R/C/Z/X/T 仅由当前分支重建，请求快照 V 只是可失效缓存；普通追加、ACP normal/strong、base 落盘、reset、切分支/回退/重启统一按 Spec §1.1 转移。用户已于 2026-11-10 确认：ACP 不主动调用 `session.compact()`，接管摘要使用当前对话模型、不新增配置。底座 threshold 同时使用存储上下文估值与 provider 用量，ACP 投影小并不代表 base 永不触发。

## Consequences(后果)

**正面**：
- 消除重复总结：底座不再把 journal 原文喂给第二个总结器；输入是 ACP 投影（通常几十 k），替代「原文 + 切窗 fold N 次」。
- 只有一套摘要作者，模型每轮看到的摘要在 ACP 压缩与底座压缩之间格式一致。
- overflow 之后 ACP 不再永久退场；长会话保留细粒度压缩与 manifest。
- L3 可以吞并基线，摘要不会「永久留一份」；吞并通过显式 `supersedesBase` 字段落盘，仍是 `f(branch)` 的纯函数。
- 渲染/计数/重建/分支回退收敛到一条路径（基线块与 acpSummary 共用 `renderCompactionBlock`）。

**负面**：
- 底座 transcript、collab 房间、远程只读端看到的压缩摘要变成 ACP 产出的正文（不再是底座的 PR 式摘要）。
- 接管路径不写 `acpSummary` → `acp-stats` / `acp-gain` 看不到这次压缩；边界前旧行的 `savedTokens` 仍会虚高。
- 钩子内同步调 LLM（可能数十秒），期间 UI 依赖既有「压缩中」态；取消由 `event.signal` 与 ACP 25s 期限合成，外层 30s 只作最后护栏。
- 双路径常驻：接管失败必须能干净让路，底座原总结路径不能删。
- `degrade` 仍覆盖原生回放 / snapcompact 旧历史，那些会话保持互斥态。

**风险/不确定性**：
- 沿用底座 `preparation.firstKeptEntryId` 后，接管结果在 threshold 自动、overflow/incomplete 与手动入口是否都被一致采用，以及下一次 `prepareCompaction` 能否按该边界正确切分，未实测（[INFERENCE]）。W5 只能拒绝坏 id，不能替代真机对账。
- W4 的阈值复核与底座实际触发条件若不一致（例如 reserve 口径差异），仍可能出现「压完立刻再触发」。需要真机对账一次。
- 接管让底座的 `preparation`（原文、保留尾部预算）白白算了一遍——成本是常数级，但存在。
- 基线块把边界前历史计入 `zoneTokens`，长会话的 zone 占比上升，可能更早触发 ACP 的保险线/强制压缩。
- 用户已确认 ACP 不主动调用 `session.compact()`；但底座 threshold 同时使用存储上下文估值与 provider 用量，原始 journal 仍可能在 ACP 投影较小时触发接管，不能假设边界只在 overflow / 手动压缩时产生。
- ACP 接管的 25s 主动取消期限让慢模型频繁让路，退化回 base 自己总结；外层 30s 超时只停止等待，不能防止遗留请求，因此验收必须观察请求实际 abort 且无迟到写入。
- 只要 `session_before_compact` 有 handler，底座的投机压缩与阈值延迟就被关闭——接管上线即改变 base 链的既有行为。
- 接管不写 `acpSummary`：该次压缩在 ACP 统计与收益中完全不可见，且此前各行的 `savedTokens` 继续按旧口径高估。
- 沿用底座切点意味着保留区可能覆盖 ACP 已折叠的区间：视图里两者重叠，ACP 投影会过滤掉已折叠块，实际上下文以 ACP 为准，但底座的 `tokensAfter` 预期会偏保守。

## Alternatives Considered

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| A 维持互斥（现状守卫） | 零新增状态，语义最简单，已实施验证 | 一次 overflow 后 ACP 永久失效 | 不满足诉求；overflow 不该连后续能力一起取消 |
| B 溢出后清空 zone、继续 ACP | 改动最小 | 两套渲染路径、两套计数口径，边界前历史不进 `zoneTokens` | 半成品 |
| C 只做读侧建模（v1/v2）：底座自己总结，ACP 事后认领为基线块 | 不动写路径；风险低 | 底座仍用 journal 原文总结 → 重复总结、切窗多次调用，正是用户要消除的成本 | 成本问题未解决；v2 已完成并作为本方案读侧基础 |
| D ACP 全面禁止 base 压缩（overflow 也拦） | ACP 完全主导 | 无视强制 tool_choice 的 provider 面会死锁在 413 | 把可靠性押在 provider 支持上，已否证 |
| **E 写侧接管 + 读侧认边界（本方案）** | 单一总结者、成本最低、L3 可吞 | 摘要格式外溢；双路径常驻；钩子内同步 LLM | — |

**演进说明**：v1（读侧建模）经独立审阅判 NOT READY（7 项阻断，均已吸收）；v2 修完阻断后，用户指出真正的诉求不是「读侧认领」，而是「写侧不要让底座再拿原文压一遍」；v3 因此加入接管，并把「根块永久不可吞」改为「L3 可吞并」（v3.1 改用显式 `supersedesBase` 字段，因为 `supersedes` 数组不认 compaction entry id）。D 与 E 的关键区别：E 仍在底座触发时让路兜底，不依赖 provider 支持强制工具调用。

v3.1：v3 经一轮独立审阅判 NOT READY（8 项阻断，含「边界自报不可靠」「阈值不同量纲」「`supersedes` 不认 compaction id」「拼接撞预算」「30s 超时」），已按反例逐条修订；用户要求不再复审，直接以 v3.1 交付。

v3.2：v3.1 独立审阅再发现 5 项阻断；本版补上分支 leaf 缓存护栏、strong 跨代继承、ISO→毫秒转换、保留尾部计数/候选分离，以及 25s 主动取消模型请求。仍待独立复审，未实施。

v3.3：设计问答发现「总结整个活跃区 + 底座保留连续后缀」会让保留消息同时出现在摘要与原文中；本版把模型输入收紧为 `firstKeptEntryId` 之前的活跃前缀，保留尾部只传原文，并补充连续后缀切分与去重验收。仍待独立复审，未实施。

v3.4：v3.3 独立审阅再发现 4 项合同缺口；本版以 branch 前缀校验和增量续接支持正常 leaf 推进，旧 zone 与保留尾部交叉覆盖时整体让路，W4 改算候选基线与实际保留结果，并以 reset+compaction 双 id 触发重建、清除 reset 前 zone 和覆盖集合。仍待独立复审，未实施。

v3.5：新增单一状态模型、事件转移与五条硬不变量；修复 reset 后无 compaction 的对齐起点，将 strong 的稳定基线身份与最近重写时间分离，并由用户确认 Q1 不主动 compact、Q2 使用当前对话模型。待独立全量复审，未实施。

## Related(关联)

- `docs/architecture/acp-base-boundary-spec.md`（v3 实施合同 + 验收矩阵）
- `docs/architecture/acp-compaction-spec.md`（§5.3 互斥契约将被改写；§4 投影顺序、§9 重建规则同步修订）
- `.agents/BUGS.md` BUG-129（守卫取代 settings pin；本 ADR 的 W7 取代其 cancel 行为）
- 底座源码：`session/session-context.ts`、`session/session-entries.ts`、`session/session-maintenance.ts:1370-1394,1596`、`compaction/compaction.ts:936-961,1523-1531`、`extensibility/shared-events.ts:474`
