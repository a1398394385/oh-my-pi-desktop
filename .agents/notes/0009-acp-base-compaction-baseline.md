# ADR-0009: ACP 以投影驱动底座压缩，并把压缩边界作为 zone 根块

**Status**: Accepted(2026-11-10；v4.0 修订 Accepted 2026-11-17)
**Decider**: 用户（确认方向、Q1/Q2 并授权实施）
**Informed by**: `docs/architecture/acp-compaction-spec.md`、`docs/acp-base-preparation-research.md`、BUG-129、BUG-173、底座 `@oh-my-pi/pi-coding-agent` 18.20.0 源码

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

1. **写侧由 ACP preparation 驱动（v4.0，2026-11-17）**：ACP owner 关闭底座原始 journal 自动压缩；L3 连续三次强制失败后进入持续后备状态，ACP 投影达到 `resolveThresholdTokens` 或真实溢出时主动调用 `session.compact({ preparation })`。preparation 的压缩输入、`firstKeptEntryId`、连续保留尾部、zone `previousSummary` 和有效 token 数均由 ACP 投影构造；原始 journal 仅提供真实 entry ID 与持久化。投影快照仍只允许同分支真实 ID 前缀续接，非前缀、伪 ID、追加区含边界或 zone 与保留尾部交叉覆盖时拒绝本次压缩，不让路底座。
2. **压后复核是同量纲的启发式**：目标线取 recovery band（`floor(threshold × 0.8)`），估算量 = 候选基线渲染 + `firstKeptEntryId` 起实际保留的原始消息 + 非消息开销，使用同一消息计数器且旧 zone 不重复计数；**不得使用压前 `projectedTokens`**。阈值走 per-model 解析（`resolveModelCompactionSettings`）。不达标即拒绝候选并保持后备，避免「压完仍超阈值 → 下一轮立刻再触发」的抖动；即使通过，后续也只能基于新的 ACP preparation 再压缩。
3. **边界由 ACP 定（v4.0）**：`firstKeptEntryId` 由 ACP 从自身投影选择，底座只落盘。底座不校验该 id，因此 ACP 必须验证其非空、属于当前分支且保留区为连续后缀；投影缓存失效、追加区含边界、活跃消息无法对齐、zone 与保留尾部交叉、压缩前缀与可承接 zone 均为空、取消/超时、W4 不达标、模型失败或空摘要时，均不落盘并显式报错。18.20.0 精确 patch 让手动 compact 接收该 preparation 并跳过 raw `prepareCompaction`；未传时默认 CLI 行为不变。
4. **一次压缩一条记录**：后备路径只写 compaction entry，**不同时写 `acpSummary`**（否则同一压缩两条记录）。
5. **读侧基线块**：`baselineBlock(branch)` 取**最新 `reset_boundary` 之后**的最新 compaction entry → 合成 `method:"base"` 的 zone 根块。最新 reset 同时是 zone 时代边界：reset 前的 acpSummary 一律退出 zone，`compressedBlockIds` 只从 reset 后最终 live zone 重建。`compressedIds` = 边界条目之前（边界来自 `firstKeptEntryId`）或含它（来自 `providerReplayThroughEntryId`）；`index = []`（header 只显示 `[acp-base]`，不显示块数）。entry 的 ISO `timestamp` 先经 `Date.parse` 转成毫秒 `rewriteAt`，再用于 `meta.createdAt`、渲染体 `timestamp` 和 `historyRewriteAt`。
6. **基线可被 L3 吞并**：strong 压缩写新字段 `meta.supersedesBase = 基线块 id`（不能用 `supersedes` 数组：它的三个消费点只匹配 acpSummary 内部 id，compaction entry id 会被静默忽略）、并入其 `compressedIds`、摘要正文拼接基线 summary（拼接部分不参与 `÷divisor` 折算，摘要上限至少扩到拼接下限，否则 `summary-over-budget` 会让吞并永远无法落地）。后续 strong 吞掉携带该字段的旧摘要时，`supersedesBase` 作为稳定基线身份逐代原样继承；`historyRewriteAt` 则表示当前存活 strong 最近一次改写前缀的时间，直接吞或间接吞基线时都取新 `written.meta.createdAt`，运行、重启与回退均从该代持久化记录重建，不继承基线或上一代时间。重建侧靠 `supersedesBase` 判定「该边界已被吞」→ 不再合成基线。运行时 `zone = [written]` 不变，因此运行时与重启同构；只有回退到首个携带该字段的 strong 之前，基线才复活。
7. **投影**：非 degraded 时丢弃 `role:"compactionSummary"` 消息，改由基线块渲染成 `[acp-base]\n<summary>`，并带数值型 `historyRewriteAt = Date.parse(entry.timestamp)`（漏掉它或混入 ISO 字符串都会让保留尾部的 bound-thinking 失效签名被重放）。所有 acpSummary（normal 与 strong）渲染体都携带 `historyRewriteAt = meta.createdAt`；`supersedesBase` 只负责定位基线身份，不负责提供重写时间。
8. **对齐起点由当前分支状态决定**，扫描源 = `getBranch()`：当前 reset 时代有 compaction（包括从未 reset）时从该 compaction 的 `boundaryEntryId` 起扫（基线被吞也一样）；只有 reset 时从最新 reset id 起扫；两者都无则从分支开头起扫。保留尾部在视图里、但在 journal 中位于 compaction entry 之前，起错点会让整段退化成伪 id；reset 后从全分支起扫会让 64 条窗口外的新消息无法匹配。每请求以 `(最新 reset id, 最新 compaction id)` 为重建指纹，任一变化都重建 zone 与覆盖集合；只扫当前分支尾部，不能用包含兄弟分支的 `getEntries()`。
9. **原生回放与归档例外**：判定只看 `CompactionEntry` —— `getAnthropicCompactionPayload(preserveData)`、`preserveData.openaiRemoteCompaction`、`method === "snapcompact"` 且 `preserveData.snapcompact` 任一命中即 `degraded`。接管产生的新 entry 无 `method`/`preserveData`，不会误判。degraded 是当前分支时代的派生状态；reset 或回退离开该边界后，重同步必须清除，不得与重启结果分叉。
10. **guard 改为 ACP 全程拥有（v4.0）**：threshold/idle 不在 ACP owner 中运行；overflow/incomplete 只作为 ACP 后备触发信号；程序手动 compact 必须携带 ACP preparation。任何失败都不得让路原始 journal，`degrade()` 不得恢复底座压缩或原始视图透传。
11. **单事实源与已确认选项**：R/C/Z/X/T 仅由当前分支重建，请求快照 V 只是可失效缓存；普通追加、ACP normal/strong、base 落盘、reset、切分支/回退/重启统一按 Spec §1.1 转移。用户于 2026-11-17 确认：ACP 在三次强制失败后的后备阶段主动调用 `session.compact({ preparation })`，摘要使用当前对话模型、不新增配置；有效上下文与后备阈值始终使用 ACP 投影，不再使用底座 storedConversationEstimate。

## Consequences(后果)

**正面**：
- 消除重复总结：底座不再把 journal 原文喂给第二个总结器；输入是 ACP 投影（通常几十 k），替代「原文 + 切窗 fold N 次」。
- 只有一套摘要作者，模型每轮看到的摘要在 ACP 压缩与底座压缩之间格式一致。
- overflow 之后 ACP 不再永久退场；长会话保留细粒度压缩与 manifest。
- L3 可以吞并基线，摘要不会「永久留一份」；吞并通过显式 `supersedesBase` 字段落盘，仍是 `f(branch)` 的纯函数。
- 渲染/计数/重建/分支回退收敛到一条路径（基线块与 acpSummary 共用 `renderCompactionBlock`）。

**负面**：
- 底座 transcript、collab 房间、远程只读端看到的压缩摘要变成 ACP 产出的正文（不再是底座的 PR 式摘要）。
- 后备路径不写 `acpSummary` → `acp-stats` / `acp-gain` 看不到这次压缩；边界前旧行的 `savedTokens` 仍会虚高。
- 后备压缩同步调用 LLM，期间 UI 依赖既有「压缩中」态；手动 compact 中断与续跑必须复用底座生命周期。
- `degrade` 仍覆盖原生回放 / snapcompact 旧历史，但仅限包含该边界的当前分支时代；期间请求显式失败，reset 或回退后才恢复。
- 新增 18.20.0 preparation patch，后续底座升级必须重新生成并验证。

**风险/不确定性**：
- 后备压缩持续失败时上下文仍可能真实溢出；方案选择显式报错和后续 ACP preparation 重试，不以原始 journal 摘要换取表面成功。
- 后备阈值与真实 overflow 入口需要真机对账；W5 只能拒绝坏 id，不能替代端到端验证。
- 底座 methodOrder 各方法对外部 preparation 的支持必须逐一验证；不支持时明确拒绝，不能隐式回退 raw。
- 基线块把边界前历史计入 `zoneTokens`，长会话的 zone 占比上升，可能更早触发 ACP 的保险线/强制压缩。
- ACP 接管超时时必须确认模型请求实际 abort 且无迟到写入；外层 30s 超时只停止等待，不能替代取消。
- 后备不写 `acpSummary`：该次压缩在 ACP 统计与收益中完全不可见，且此前各行的 `savedTokens` 继续按旧口径高估。

## Alternatives Considered

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| A 维持互斥（现状守卫） | 零新增状态，语义最简单，已实施验证 | 一次 overflow 后 ACP 永久失效 | 不满足诉求；overflow 不该连后续能力一起取消 |
| B 溢出后清空 zone、继续 ACP | 改动最小 | 两套渲染路径、两套计数口径，边界前历史不进 `zoneTokens` | 半成品 |
| C 只做读侧建模（v1/v2）：底座自己总结，ACP 事后认领为基线块 | 不动写路径；风险低 | 底座仍用 journal 原文总结 → 重复总结、切窗多次调用，正是用户要消除的成本 | 成本问题未解决；v2 已完成并作为本方案读侧基础 |
| D ACP 全面禁止 base 且无后备 | 实现最简单 | 强制工具失败或估算偏差后只能死锁在 413 | 缺少达线与溢出后的可执行恢复，未选 |
| E v3 写侧接管 + 失败让路 | 复用现有 hook，无需 patch | 触发与准备仍依赖原始 journal，失败后会重复总结全文 | 不符合 ACP 视角与成本约束，被 v4.0 取代 |
| **F ACP preparation 后备压缩（本方案）** | 触发、切点、摘要与回退统一 ACP 视角；保留底座执行生命周期 | 需要精确版本 patch；后备失败仍可能溢出 | — |

**演进说明**：v1（读侧建模）经独立审阅判 NOT READY（7 项阻断，均已吸收）；v2 修完阻断后，用户指出真正的诉求不是「读侧认领」，而是「写侧不要让底座再拿原文压一遍」；v3 因此加入接管，并把「根块永久不可吞」改为「L3 可吞并」（v3.1 改用显式 `supersedesBase` 字段，因为 `supersedes` 数组不认 compaction entry id）。D 与 E 的关键区别：E 仍在底座触发时让路兜底，不依赖 provider 支持强制工具调用。

v3.1：v3 经一轮独立审阅判 NOT READY（8 项阻断，含「边界自报不可靠」「阈值不同量纲」「`supersedes` 不认 compaction id」「拼接撞预算」「30s 超时」），已按反例逐条修订；用户要求不再复审，直接以 v3.1 交付。

v3.2：v3.1 独立审阅再发现 5 项阻断；本版补上分支 leaf 缓存护栏、strong 跨代继承、ISO→毫秒转换、保留尾部计数/候选分离，以及 25s 主动取消模型请求。仍待独立复审，未实施。

v3.3：设计问答发现「总结整个活跃区 + 底座保留连续后缀」会让保留消息同时出现在摘要与原文中；本版把模型输入收紧为 `firstKeptEntryId` 之前的活跃前缀，保留尾部只传原文，并补充连续后缀切分与去重验收。仍待独立复审，未实施。

v3.4：v3.3 独立审阅再发现 4 项合同缺口；本版以 branch 前缀校验和增量续接支持正常 leaf 推进，旧 zone 与保留尾部交叉覆盖时整体让路，W4 改算候选基线与实际保留结果，并以 reset+compaction 双 id 触发重建、清除 reset 前 zone 和覆盖集合。仍待独立复审，未实施。

v3.5：新增单一状态模型、事件转移与五条硬不变量；修复 reset 后无 compaction 的对齐起点，将 strong 的稳定基线身份与最近重写时间分离，并由用户确认 Q1 不主动 compact、Q2 使用当前对话模型。待独立全量复审，未实施。

v3.6：全量复审发现 4 项组合缺口；本版拒绝空白摘要，闭合无 reset 的 compaction 对齐，给 normal/strong 摘要统一写入自身重写时间，并把 degraded 改为可随 reset/回退恢复的分支派生状态。同一独立 reviewer 复审结论 READY。2026-11-10 经用户授权实施；相关单测与 manual takeover、strong 跨代、重启/回退 smoke 已验证，真实模型及自动/overflow/incomplete 入口仍待对账。

v4.0（2026-11-17）：BUG-173 证明原始 journal 地板会在 ACP 实际请求很小时触发底座；用户拍板取消「底座启动、ACP 接管、失败让路」，改为 ACP 三次强制失败后的 preparation 后备压缩。上游接口调研（`docs/acp-base-preparation-research.md`）未发现可复用的外部 preparation API，因此以 18.20.0 精确 patch 落地。

## Related(关联)

- `docs/architecture/acp-base-boundary-spec.md`（v4 实施合同 + 验收矩阵）
- `docs/architecture/acp-compaction-spec.md`（v16 档位、三次失败与后备策略）
- `docs/acp-base-preparation-research.md`（上游接口与 issue/PR 调研）
- `.agents/BUGS.md` BUG-129、BUG-173
- 底座源码：`session/session-context.ts`、`session/session-entries.ts`、`session/session-maintenance.ts:1370-1394,1596`、`compaction/compaction.ts:936-961,1523-1531`、`extensibility/shared-events.ts:474`
