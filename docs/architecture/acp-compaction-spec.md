# ACP 双区增量压缩 · 实施 Spec

> **Status**: Draft(2026-10-12) · 未实施
> **审阅结论**: READY(2026-10-12,Decider 终审)
> **决策 SSOT**: [ADR-0005](../../.agents/notes/0005-acp-incremental-compaction.md)
> **修订**: v2 首轮审阅 6 项阻断(清单全列+幻觉 ID 拒绝;supersedes 重建+降级;acpSummary 纯持久层+投影口径;exclusive 互斥;L2/L3 退出条件;验收 9 收窄)。v3 二轮审阅 4 项阻断(合并继承 compressedIds/index;清单消费语义;清单截断方向与 L2 校验口径;summary 预算基数)。v4 Decider 澄清:合并=主动 L3 全量、无独立摘要调用。v5 隐患发散修正。v6 搭便车语义。v7(Decider 拍板体系重构):**压缩方式三级化**(一级普通累加/二级强力重置/三级 tool_choice 强制);豁免=可配置压缩目标线 target;清单按块大小降序截断;recall 走底座统一截断管道;强制失败即降级,删除模板/拼接硬压路径;L3 通牒轮次归属明确;参考 OMP 链路(预处理剪枝/进度守卫/失败封顶)。v8(四轮审阅):L2 档改名「加压档」消除与二级强力压缩的命名撞车;新增唯一二维决策表,边界统一严格大于;三级终态=「强制 turn 无成功压缩即降级」(极端碎块场景不特化,Decider 裁量);ADR Decision/Consequences 回改同步。
> **超限说明**: 验收矩阵为结构性超限(见 ../documentation.md §5)。

## 1. 目标与非目标

**目标**:
1. 模型主动管理上下文构成:已完成任务的历史及时压缩离场,活跃区保持尽量小。
2. 增量压缩不破坏压缩区前缀缓存;压缩动作对持久历史零改写(投影层重组)。
3. 压缩后老历史保持可定位(索引清单)+ 可取回(recall)。
4. ACP 是 OMP 原生压缩之前的一层:总量上限不超过模型窗口;ACP 失效后降级,OMP 默认链路(remote/snapcompact/handoff/shake/soft)接管。

**非目标**:
- 不做跨会话/跨 branch 的压缩状态迁移;会话内 strategy 不变,切换仅影响新会话。
- 不做 recall 频控、不做压缩质量评分体系。
- 不替换 OMP 压缩链路(它是 ACP 的最终兜底)。

## 2. 术语表

| 术语 | 定义 |
|---|---|
| 块(block) | 压缩协议的最小选择单位,全局唯一 ID |
| 活跃区 / 压缩区 | 上下文两段;组成 [tools][system][压缩区][活跃区] |
| 候选集 | 本次压缩可被选中的块 = 活跃区 − 尾部保护区 |
| 当轮清单 | 最近一次 ephemeral 提示展示的候选块 ID 列表(**按块大小降序**,超限截断);压缩范围以当轮清单为准;一次成功提交即被消费 |
| 保留清单(keep) | AI 在 compress_context 中列出的要留下的块 ID(⊆ 当轮清单) |
| 被压集 | (当轮清单 − keep) ∩ 当前活跃块 |
| 豁免块 | 因清单截断未展示的候选块:本轮不可被压,下轮重新进入清单 |
| 尾部保护区 | 活跃区尾部强制保留段,不进候选集(可配置,可为 0;见 Open Questions) |
| **压缩目标线 target** | 压缩后允许的活跃区大小(keep + 保护区 ≤ target);可配置,默认 = L1,可调更低(更极端压缩);普通/强力压缩统一生效 |
| 普通压缩(一级) | 活跃区 ≤L3 且压缩区未超限时的压缩:压缩块**累加**到压缩区末尾 |
| 强力压缩(二级) | 活跃区 >L3 **或**压缩区达限额时的压缩:全量选保留,被压块与全部旧压缩块融合为一个纯摘要初始压缩块,**重置压缩区**(supersedes 全部,depth+1) |
| 强制压缩(三级) | L3 通牒送达后下一轮仍无成功压缩,或总量保险线触发:宿主以 tool_choice 强制 compress_context(强力语义);失败即降级 |
| 待强力状态 | 压缩区 > 窗口×35% 期间;ephemeral 统一加注"下次压缩为强力压缩";无持久标记,按压缩区大小实时判定;无轮次上限 |
| 降级 | ACP 失效后退出本会话:工具停注、提示停发、投影关闭,OMP 默认压缩链接管(§5) |
| tool 对 | tool_use + 其 tool_result 的不可分整体,ID 挂 result |
| ephemeral 提示 | 发送时拼在请求末尾、不落历史的状态注入 |

## 3. 块模型与 ID 规则

存储层不动(底座 SessionEntry 原样,每 entry 一个 UUID)。逻辑块拆分:

| 原 entry | 拆成块 | 块 ID |
|---|---|---|
| user / bashExecution / hookMessage 等 | 各 1 块 | entry id |
| assistant | thinking 块(0/1) + text 块(0/1) + tool 对块 × N | thinking/text: `entryId#t` / `entryId#x`;tool 对: result 的 entry id |
| tool_use 本体 | 不单独成块,依附于 tool 对 | — |
| 压缩块(acpSummary) | 压缩区成员,不进候选;可被强力压缩 supersede | 自身 entry id |

**配对不变量**(投影输出必须满足,宿主断言):每个 tool_use 有对应 result;每个 result 有对应 tool_use。成对保留、成对消失均合法;单边留存非法。

**thinking 块规则**:默认独立可选;若探针 1 失败(签名不容忍 block 级过滤),降级为 thinking 强制与同消息全部 tool 对共进退(见 Open Questions)。

## 4. 上下文组成与投影算法

发送前经 transformContext 投影生成请求消息;持久历史不改写。**acpSummary 是纯持久层 role,不进底座消息转换**(底座对未知 role 丢弃且 Tokenizer 不计数——一轮审阅探针实证);投影层直接把压缩块渲染成 user 角色文本段进入输出。

1. **压缩区渲染**:只渲染未被 supersede 的压缩块,按原序各渲染为:元数据头(压缩时间/depth/被压块数/method) + 整体摘要 + 索引清单(每行 `id | tokens | intent或截断句`;全列,单块索引渲染超 4K token 时截断最老段 + `… N more, recall_block(本块id) 取完整索引`)。
2. **活跃区重组**(按保留集过滤):
   - assistant 消息 M 含 tool_use U1..Un:保留的 tool 对 → 其 tool_use block 留在 M';被压的 → 从 M' 摘除,其 result 同步摘除。
   - thinking/text 块按保留集同样过滤。
   - M' 无任何 content block → M 整条消失;result 消息过滤后为空 → 整条消失。
   - result 消息按 provider 形态重组(Anthropic: tool_result blocks 聚合进 user 消息;OpenAI: 多条 role=tool 消息)。
3. **配对断言**:对投影输出校验配对不变量,失败即抛错(实现期防御)。
4. **ephemeral 提示**:拼在请求消息序列末尾(见 §7)。

**时序与快照**:压缩范围 = 当轮清单(模型可见的集合),不是执行时刻候选集;清单注入后新到块不在清单内,天然豁免。快照一致性由此保证,不依赖执行时刻状态。

**与底座预处理管道的关系**:底座 pruneToolOutputs / supersedeReads / dropUseless 管道照常在压缩前运行(原地缩小或清空块内容);ACP 块 token 计数用 prune 后的值。prune 决定块内内容的多少,ACP 决定块的存亡,两者正交。

## 5. 档位、三级压缩与降级

判定量:**活跃区精确 token**(§8,prune 后)。每轮结束后判定档位。

### 5.1 提示档位(ephemeral 注入,见 §7)

| 档 | 触发(活跃区) | ephemeral 文案 |
|---|---|---|
| L1 激活档 | > 100K | 建议压缩 + 当轮清单 |
| L2 加压档 | > 200K | 加压提示 + target 约束 + 当轮清单 |
| L3 截断档 | > 300K | 最后通牒:「下一轮必须成功压缩,否则宿主将强制压缩」 |

(命名约定:档位用「激活/加压/截断」,压缩方式用「普通/强力/强制」,两者不同名以防混淆。)

档位数值运行时动态可调;配置约束:L3 < 0.5×窗口−20K,否则高档位不可达(总量线与压缩区线联合约束,见 §11)。

### 5.2 压缩方式三级

| 级 | 触发 | 行为 |
|---|---|---|
| 一级·普通压缩 | 活跃区 ≤L3 且压缩区未超限,模型主动 compress_context | keep 自选(校验 §6);压缩块**累加**到压缩区末尾;method="normal" |
| 二级·强力压缩 | 活跃区 >L3(与 L3 档同线),**或**待强力状态下模型主动 compress_context | 同一工具同一 schema;执行按强力语义:新压缩块 supersedes 全部未 supersede 压缩块、depth+1、method="strong",compressedIds/index 继承被取代块全集并并入本次新压部分;压缩区渲染只剩单块 |
| 三级·强制压缩 | L3 通牒送达后下一个 assistant turn 结束仍无成功压缩;或总量保险线触发 | 宿主构造 tool_choice=compress_context 的请求强制模型调用(强力语义,meta.forced=true);**强制 turn 结束仍无成功压缩(含校验屡败、输出不合法),或 API 错误 → 降级** |

**唯一二维决策表**(状态 → ephemeral 文案档位 → 本次 compress 执行方式;边界一律严格大于,活跃区恰好 = L3 值 → L2 档 + 普通压缩):

| 活跃区 | 压缩区 | 档位文案 | compress 方式 |
|---|---|---|---|
| ≤L1 | 未超线 | 无(或最简状态行) | 普通 |
| (L1, L2] | 未超线 | L1 建议 | 普通 |
| (L2, L3] | 未超线 | L2 加压 + target | 普通 |
| >L3 | 任意 | L3 通牒 | 强力 |
| >L1 | 超线(待强力) | 加注「下次为强力压缩」 | 强力 |
| ≤L1 | 超线(待强力) | 同上 | 普通(不搭车) |
| 三级触发 | 任意 | — | 强力(forced) |

**轮次归属**(回应审阅):档位轮末判定,通牒随下一次请求注入(ephemeral);**通牒送达后的下一个 assistant turn 结束**才判"未响应";无自然下一请求(空闲)则等待,不主动唤醒(空闲时活跃区不增长,无风险;探针证实 assistant 结尾无法自动续请求)。

**待强力状态**:压缩区 > 窗口×35% → ephemeral 统一加注「下次压缩为强力压缩」;活跃区 >L1 时下一次 compress 按强力语义执行;活跃区 ≤L1 的主动 compress 保持普通压缩(不搭车);无轮次上限(压缩区不超线不增长,总量保险线兜底),不打断任务流。

**压缩量下限与成功判定**:成功压缩 = 被压集 ≥ minCompress(默认 20K,防模型每轮压一块偷懒)。L2 档未达 → 放行带 warning;L3 档未达 → 放行但视为「无成功压缩」,计入三级触发。**三级终态**:强制请求的 turn 结束仍无成功压缩(含校验屡败、输出不合法),或 API 错误 → 降级。(极端碎块导致清单可压总量 < minCompress 的场景不做特化:正常 coding 会话不会出现;真出现时结局 = 三级强制无进展 → 降级 OMP 兜底,而非死循环;后续可视需要再加块数量上限。)

### 5.3 保险线与降级

**总量保险线**:判定量 = **投影后总量**(ACP 投影是协议行为而非 on-wire 作弊,不使用底座 `compactionContextTokens` 的 stored 地板)。投影总量 > 窗口 − 15% reserve(复用底座 effectiveReserveTokens)→ 直接触发三级强制压缩;强制后仍超,或强制本身失败 → 降级。

**降级**:会话持久历史中出现底座 compaction 记录(firstKeptEntryId 边界)→ 本会话 ACP 永久退出:
- compress_context / recall_block 不再注册;ephemeral 停止注入;投影关闭(消息原样发送,走底座自己的 transform);
- 边界前的 acpSummary 随底座边界一并隐藏;底座摘要输入基于边界前原始消息全文(投影不改存储,原文均在);
- 此后由 OMP 默认链路按 methodOrder(remote/snapcompact/handoff/shake/soft)接管,含其溢出恢复/输出截断恢复/进度守卫/失败封顶;
- 判定无需额外标记:重建时检测到 compaction entry 即降级。

## 6. 工具契约

### compress_context

```json
{
  "name": "compress_context",
  "concurrency": "exclusive",
  "input": { "keep": ["blockId"], "summary": "被压块整体摘要(强力压缩时为压缩区总摘要)" }
}
```

**互斥与清单消费**:`concurrency: "exclusive"`(底座原生调度:批内串行,自动豁免投机执行)。**当轮清单被一次成功提交即消费**:同轮后续调用一律拒绝"清单已消费,等待下轮新清单";**校验失败的调用不消费清单**(可修正重试)。

**校验**(按序;任一失败 → tool error 返回原因,零副作用、不消费清单):
1. 当轮清单已消费 → 拒绝。
2. keep 中存在幻觉 ID(不存在 / 非活跃 / 保护区块 / 已被压缩)→ **拒绝整个调用**,error 附当前完整有效候选 ID 集合。
3. keep + 保护区 > target(§11,默认 100K)→ 拒绝,报当前值与需再减的差额。普通/强力统一适用。
4. summary 为空 → 拒绝。
5. summary token > min((本次被压 + 参与重置旧摘要) token ÷ 3, 8K) → 拒绝,报上限。(纯重置时本次被压=0,基数仍含旧摘要,不死锁。)
6. 被压集 =(当轮清单 − keep)∩ 当前活跃块;为空 → 拒绝"无可压缩块"。**例外:强力压缩允许空被压集**(纯重置:仅融合旧摘要,预算基数 = 参与重置旧摘要总 token)。

(成功压缩的判定——被压集 ≥ minCompress——不影响校验通过与否,只影响三级触发计数,见 §5.2。)

**执行**(校验通过):
- 一级:压缩块 entry 追加压缩区末尾;
- 二级:新压缩块 supersedes 全部未 supersede 压缩块,compressedIds/index 继承其全集并并入本次新压部分,depth+1;压缩区渲染剩单块;
- 消费当轮清单;活跃区 = keep ∪ 保护区 ∪ 豁免块 ∪ 清单注入后新到块;
- tool_result 返回:被压块数/token、keep 块数/token、活跃区新大小、新档位。

**保留不继承**:每轮候选 = 全部活跃块 − 保护区;上轮 keep 无特权。

### recall_block

```json
{ "name": "recall_block", "input": { "id": "blockId" } }
```

- id 为普通块:从 session JSONL 读取原块(tool 对 = call+result 一起渲染),作为本工具 tool_result 返回,外包文本注记。召回产物 = 普通新块、无豁免、下一轮进候选。
- id 为压缩块:返回该块**完整索引**(强力压缩块经继承规则即全量;突破 §4 渲染截断的发现机制)。
- id 为已被 supersede 的压缩块 → 不报错,重定向返回最新强力压缩块的索引,并注明取代链(`S1 → M`)。
- id 不存在 → tool error(不静默)。不设频控(超档由档位机制自然回收)。
- **大结果截断**:recall 返回不做内置截断,统一走底座工具结果截断管道(超限截断 + 完整版落盘为文件,模型用 read 分段取回;触发限额跟随底座默认,可配置)——索引再大也可遍历(Decider 拍板,回应审阅 3)。

## 7. ephemeral 状态提示契约

- **位置**:请求消息序列末尾追加一条 user 角色消息,文本以 `[acp-status]` 开头;**不落历史**。
- **内容**:**当前档位 + 本次允许的压缩方式(普通/强力)** / 活跃区 tokens / 投影总量 tokens / 档位指令文案(L1 建议、L2 加压+target、L3 最后通牒;待强力状态统一加注「下次压缩为强力压缩」)/ **当轮清单**:候选块**按块大小降序**全列,每行 `id | tokens | intent或截断句`;清单渲染自身超 8K token 时截断尾部(较小块)+ `… N more(本轮豁免)`。每轮重新生成:已压大块离场后,次大块下轮进入清单,多轮收敛;清单外块天然豁免。
- **缓存安全**:提示只在末尾追加,持久前缀(tools/system/压缩区/活跃区)不变;提示自身每轮重算。档位不变时文案逐字节稳定,最大化末尾局部缓存复用。

## 8. token 计数

- 复用底座 Tokenizer(Rust native BPE;文本 LRU + 消息 memo 两级缓存,settled 消息只计一次):档位判定、块大小清单、keep 校验、保险线判定统一用同一实例。
- acpSummary 不参与底座消息计数;压缩块 token 数 = 投影层对其渲染文本做 countTokens。
- 块大小在块 settled(流式结束)且 prune 管道运行后计算并 memo;流式中的块不进候选。
- unknown encoding 兜底 byte 估算(三档判定同步降级,可接受)。
- 图片/加密 reasoning 按底座现有估算规则计入所属消息块。

## 9. 持久化与状态重建

- 压缩块 = 新 message role `acpSummary`,session JSONL 持久化(**纯持久层 role;运行时经投影渲染,不进底座 convertMessageToLlm**),字段:
  - `summary: string`、`shortSummary?: string`
  - `index: [{ id, tokens, intent }]`(完整索引;强力压缩块继承全集,不受渲染截断影响)
  - `meta: { createdAt, depth, method: "normal" | "strong", forced?: boolean, keepIds, compressedIds, supersedes: string[], tokensBefore, tokensAfter }`
- **重建**:
  1. 检测到任何底座 compaction entry → 降级模式(§5.3),ACP 状态不推进;
  2. 否则:压缩区 = 未被任何 acpSummary.meta.supersedes 覆盖的 acpSummary,按序;
  3. 消息块:出现在任一未 supersede 压缩块的 compressedIds 中 → 已压缩;其余 → 活跃。(强力压缩块经 §6 继承规则持有全量 compressedIds,重建无需递归展开 supersedes 链。)
- strategy=acp 会话自身不产生底座 compaction 记录;唯一来源是降级路径(§5.3)。

## 10. 与底座集成点

| 点 | 位置 | 改动 |
|---|---|---|
| strategy 枚举 | CompactionSettings | 新增 "acp" |
| 档位判定 | acp 专用判定函数 | 活跃区三档;**不**复用 `compactionContextTokens` 的 stored 地板 |
| 保险线 | 同上 | 投影后总量 vs 窗口 − 15% reserve |
| 投影 | transformContext 钩子 | acp transformer:块过滤重组 + 压缩块渲染为 user 文本段(§4) |
| 预处理 | 底座 prune 管道 | 不动,照常在压缩前运行;ACP 计数用 prune 后值(§4) |
| 工具注册 | 工具集构建 | acp 策略注入 compress_context(`concurrency:"exclusive"`)/ recall_block;降级后不再注入 |
| 强制调用 | 三级触发 | 宿主构造 tool_choice=compress_context 请求(底座支持 tool 强制选择) |
| 持久 role | session entry 类型 | 新增 acpSummary 消息类型(存储/重建用,不注册 LLM 转换) |
| 兜底 | 降级路径 | OMP 默认链路 methodOrder 接管(§5.3) |

## 11. 参数表(SSOT,实现以本表为准)

| 参数 | 值 | 备注 |
|---|---|---|
| L1 / L2 / L3 | 100K / 200K / 300K(活跃区 token) | 默认值,运行时动态调整;配置约束:L3 < 0.5×窗口−20K,否则高档位不可达 |
| **target(压缩目标线)** | 默认 = L1(100K),可配置,可调更低 | 压缩后允许的活跃区大小:keep + 保护区 ≤ target;普通/强力统一生效(v7 Decider 拍板) |
| minCompress | 20K | 成功压缩的被压集下限(v7);清单可压总量低于它的极端碎块场景不特化,三级无进展即降级(v8) |
| summary 预算 | ≤ min((本次被压 + 参与重置旧摘要) ÷ 3, 8K) | v3 修正基数 |
| 压缩区限额线 | 窗口 × 35% | 进入待强力状态;活跃区>L1 时下一次 compress 搭车为强力压缩 |
| 总量保险线 | 投影总量 > 窗口 − 15% reserve | 触发三级强制;失败即降级 |
| 尾部保护区 | 默认 max(最近 2 turn, 最近 20K token),可配置,可为 0 | **待探针 3 回填** |
| 当轮清单截断 | 按块大小降序;渲染超 8K token 截尾部(小块豁免) | v7 改降序 |
| 索引清单截断 | 单压缩块渲染超 4K token 截最老段;完整索引走 recall_block(底座截断管道可遍历) | |

## 12. 验收矩阵

| # | 行为契约 | 验证方式 |
|---|---|---|
| 1 | 一轮 3 tool 保留 1:投影 assistant 只含该 call;配对断言通过 | 投影单元测试 |
| 2 | 全块被压的 assistant 整条消失;无 orphan use/result | 投影单元测试 |
| 3 | keep 含幻觉 ID(不存在/已压/保护区):整个调用拒绝,error 附完整有效候选集,零副作用、不消费清单 | 工具校验测试 |
| 4 | keep+保护区 > target:拒绝并报差额(普通/强力同一校验) | 工具校验测试 |
| 5 | L3 轮次归属:通牒送达轮不算;送达后下一轮有成功压缩(被压 ≥minCompress)免强制;无 → 三级 tool_choice 强制;**强制 turn 结束仍无成功压缩(含校验屡败)或 API 失败 → 降级**(工具停注/提示停发/投影关闭);空闲不主动唤醒 | 集成测试 |
| 6 | 强力压缩:压缩区超 35% 进待强力,ephemeral 加注;活跃区>L1 时下一次 compress 按强力语义(S1{a}+S2{b}→M 新压 c → M.compressedIds/index 含 a,b,c;重建后 a,b,c 已压缩、压缩区单块、depth+1;recall(M) 完整索引;多层强力同样成立;纯重置空被压集可提交);活跃区≤L1 时 compress 不搭车;活跃区>L3 时的 compress 直接按强力语义 | 集成 + 重建测试 |
| 7 | 投影总量>保险线:三级强制;仍超或失败→降级,OMP methodOrder 接管 | 集成测试 |
| 8 | recall 普通块:call+result 完整返回,召回块下轮进候选 | 集成测试 |
| 9 | 压缩动作前后,tools/system/未被 supersede 压缩块的渲染前缀逐字节一致;活跃区缓存失效为预期 | 前缀字节对比 + usage 断言 |
| 10 | 重启后重建:压缩区(未 supersede)/活跃集正确;含底座 compaction 记录的会话重建即降级 | 持久化测试 |
| 11 | keep 不继承:上轮 keep 块本轮未列即被压 | 集成测试 |
| 12 | 清单注入后新到块不进当轮清单、不被压 | 时序测试 |
| 13 | 同批两个 compress_context:exclusive 串行;第一个成功 → 清单已消费 → 第二个拒绝(含 keep=[] 场景);第一个校验失败 → 清单未消费,修正重试可成功 | 并发测试 |
| 14 | summary 超预算拒绝;纯重置(本次被压=0)以旧摘要为基数可正常提交 | 工具校验测试 |
| 15 | 清单按块大小降序,截断尾部小块豁免;极端块数(4000×100 token)下逐轮收敛无死锁;模型全保留致被压集空 → 拒绝促其修正 | 集成测试 |
| 16 | L3 档被压集 <minCompress:放行但不计入成功压缩(三级照常触发);L2 档放行带 warning;校验通过与否不受 minCompress 影响 | 工具校验测试 |
| 17 | recall 大结果:走底座截断管道,截断后完整版落盘、read 分段可取全;supersede 块 recall 重定向到最新强力压缩块并注明取代链 | 集成测试 |
| 18 | prune 管道运行后块变小,档位判定用 prune 后值;prune 不破坏配对不变量 | 集成测试 |
| 19 | 边界一致:活跃区恰好 = L3 值 → L2 档文案 + 普通压缩(无通牒不强力);ephemeral 同时输出当前档位与本次允许的压缩方式 | 单元测试 |

## 13. 实现期探针(先于主实施,按序)

1. **Anthropic thinking 签名**:留 call、压同消息 thinking 的 block 级过滤后,下一轮请求签名校验是否通过。→ 决定 §3 thinking 块规则。
2. **OpenAI / Kimi 面**:过滤后 assistant(tool_calls 子集)与 result 重组的请求合法性;tool_choice 强制 compress_context 在各面的行为。
3. **保护区 A/B**:0 vs 默认(max 2 turn / 20K),观察断片率与压缩意愿。→ 回填参数表。
4. **ephemeral 注入缓存实测**:各家 cacheRead 命中率对比(注入 vs 不注入)。

## 14. 已接受权衡

- 强力压缩下远端历史逐层稀薄(depth 记录 + 强力专用提示要求保留决策/结论/未决事项,缓解不阻止;索引清单全程保真)。
- 已完成任务的上下文被压掉是特性:长期目标/进度由外部文件承载。
- 每次压缩 = 活跃区缓存一次性失效(固有成本,压缩区前缀不受影响)。
- 极端块数下压缩需多轮分批收敛,期间档位提示持续存在。
- 三级强制失败即降级:放弃 ACP 粒度换取可靠性;OMP 摘要基于原文全文,信息保留反而更好。
- 任务进行中达到 L3 会被通牒/强制压缩打断(原始压缩方案顶到界限同样如此,固有代价)。

## 15. Open Questions

1. **尾部保护区参数** — 状态:待实测;决策人:xys;门禁:探针 3 完成后回填 §11 参数表并关闭本条。
2. **thinking 块独立性** — 状态:待探针 1;决策人:探针结果;门禁:探针 1 通过则维持"独立可选",不通过则修订 §3 为"与 tool 对共进退"并关闭本条。
