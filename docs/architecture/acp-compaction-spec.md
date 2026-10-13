# ACP 双区增量压缩 · 实施 Spec

> **Status**: Draft(2026-10-12) · 未实施
> **审阅结论**: READY(2026-10-12,Decider 终审)
> **决策 SSOT**: [ADR-0005](../../.agents/notes/0005-acp-incremental-compaction.md)
> **修订**: v2 首轮审阅 6 项阻断(清单全列+幻觉 ID 拒绝;supersedes 重建+降级;acpSummary 纯持久层+投影口径;exclusive 互斥;L2/L3 退出条件;验收 9 收窄)。v3 二轮审阅 4 项阻断(合并继承 compressedIds/index;清单消费语义;清单截断方向与 L2 校验口径;summary 预算基数)。v4 Decider 澄清:合并=主动 L3 全量、无独立摘要调用。v5 隐患发散修正。v6 搭便车语义。v7(Decider 拍板体系重构):**压缩方式三级化**(一级普通累加/二级强力重置/三级 tool_choice 强制);豁免=可配置压缩目标线 target;清单按块大小降序截断;recall 走底座统一截断管道;强制失败即降级,删除模板/拼接硬压路径;L3 通牒轮次归属明确;参考 OMP 链路(预处理剪枝/进度守卫/失败封顶)。v8(四轮审阅):L2 档改名「加压档」消除与二级强力压缩的命名撞车;新增唯一二维决策表,边界统一严格大于;三级终态=「强制 turn 无成功压缩即降级」(极端碎块场景不特化,Decider 裁量);ADR Decision/Consequences 回改同步。v9(Decider 拍板实施宿主):**全量实施于 omp-desktop host 层,底座源码零改动**——投影/ephemeral 走 context 事件 extension,双工具走 `createAgentSession({ customTools })`,压缩块持久化走 SDK `SessionManager.appendCustomEntry`(customType="acpSummary"),精确计数 import `@oh-my-pi/pi-agent-core` Tokenizer;接缝实证补遗(exclusive 不可用→host 互斥锁;prune 两层门控;三级强制 setForcedToolChoice);P1/P2 兼容面探针结论回填。v10(Decider 拍板 pull 模式):**清单从 ephemeral 注入移入新工具 context_status 返回**(模型按需拉取,ephemeral 降为一行精简状态行、无档零注入,通牒送达机制保留);**短号 bN 替代 UUID 面向模型渲染**(§3:全局单调派号、不回收、确定性重放、持久层仍 entryId);context_status tool 对不进候选且在下次成功压缩后从投影整对摘除(保护区例外)。v10.1(Decider 拍板通牒伴随合成对):**通牒请求在活跃区末尾注入合成 context_status tool 对**(新造 assistant 承接,禁向既有 assistant 插 tool_use——签名/缓存/投影纪律;不落 journal、快照冻结、成功压缩后退场)——三级强制也是有依据的挑选,消除「被逼调用手里没清单只能全压或失败」的残余粗糙点。v10.3:模型可见面工具全局更名 context_status(§2/§5.1/§5.2/§6/§7/§10/§11/§12 同步);尾部保护区参数 tailTurns/tailTokens 入实验设置页 UI(§11,未配置仍回退默认 2/20K)。
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
| 当轮清单 | 最近一次 context_status 返回展示的候选块短号列表(**按块大小降序**,超限截断);压缩范围以当轮清单为准;一次成功提交即被消费(v10:从 ephemeral 注入改为工具返回) |
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
| 压缩块(acpSummary) | 压缩区成员,不进候选;可被强力压缩 supersede | 自身 custom entry id |

**配对不变量**(投影输出必须满足,宿主断言):每个 tool_use 有对应 result;每个 result 有对应 tool_use。成对保留、成对消失均合法;单边留存非法。

**thinking 块规则**:默认独立可选;若探针 1 失败(签名不容忍 block 级过滤),降级为 thinking 强制与同消息全部 tool 对共进退(见 Open Questions)。

**短号规则(v10)**:面向模型的一切清单/索引/keep 校验反馈渲染使用短号 `bN`(N 全局单调递增);持久层(index/compressedIds/supersedes/JSONL)一律存 entryId,短号映射不落盘。派号:块首次进入活跃集时按序取号,被压/被 supersede **不回收不复用**(防悬空歧义);重启重建按 entries 顺序确定性重放同一编号。工具入口(compress_context 的 keep、recall_block 的 id)接受短号,在执行锁内解码为 entryId;幻觉短号(不存在/失效)按既有校验拒绝并附完整候选集。被压块的旧短号:keep 引用 → 已压缩拒绝;recall 引用 → 解析回 entryId 照常取原文。

## 4. 上下文组成与投影算法

发送前经 transformContext 投影生成请求消息;持久历史不改写。**acpSummary 是 SDK custom entry(customType="acpSummary",经 `SessionManager.appendCustomEntry` 写入),不进 LLM 上下文**(SDK 官方语义:`buildSessionContext` 忽略 custom entry;接口文档明确「persist extension state across reloads, scan entries for customType to reconstruct」);host 投影层直接把压缩块渲染成 user 角色文本段进入输出。

1. **压缩区渲染**:只渲染未被 supersede 的压缩块,按原序各渲染为:元数据头(压缩时间/depth/被压块数/method) + 整体摘要 + 索引清单(每行 `短号 | tokens | intent或截断句`,§3;全列,单块索引渲染超 4K token 时截断最老段 + `… N more, recall_block(本块短号) 取完整索引`)。
2. **活跃区重组**(按保留集过滤):
   - assistant 消息 M 含 tool_use U1..Un:保留的 tool 对 → 其 tool_use block 留在 M';被压的 → 从 M' 摘除,其 result 同步摘除。
   - thinking/text 块按保留集同样过滤。
   - M' 无任何 content block → M 整条消失;result 消息过滤后为空 → 整条消失。
   - result 消息按 provider 形态重组(Anthropic: tool_result blocks 聚合进 user 消息;OpenAI: 多条 role=tool 消息)。
3. **配对断言**:对投影输出校验配对不变量,失败即抛错(实现期防御)。
4. **ephemeral 提示**:拼在请求消息序列末尾(见 §7)。

**时序与快照**:压缩范围 = 当轮清单(模型可见的集合,即最近一次 context_status 返回),不是执行时刻候选集;清单返回后新到块不在清单内,天然豁免。快照一致性由此保证,不依赖执行时刻状态。

**与底座预处理管道的关系**(v9 补遗实证):prune 分两层——**stale prune**(supersedeReads / dropUseless,独立设置默认 true,每轮跑)在 compaction.enabled 门控**之前**执行,ACP 会话关闭 compaction.enabled 后**照常运行**;**overflow prune**(pruneToolOutputs)在门控**之后**,随 compaction.enabled=false 一并关闭,其溢出恢复职能由 ACP 保险线/降级路径接管。ACP 块 token 计数用 prune 后的值(stale prune 为常态路径)。prune 决定块内内容的多少,ACP 决定块的存亡,两者正交。

## 5. 档位、三级压缩与降级

判定量:**活跃区精确 token**(§8,prune 后)。每轮结束后判定档位。

### 5.1 提示档位(ephemeral 注入,见 §7)

| 档 | 触发(活跃区) | ephemeral 文案 |
|---|---|---|
| 无档 | ≤ 100K 且非待强力 | **零注入**(压缩时机完全归模型:工具描述引导,经 context_status 自取清单) |
| L1 激活档 | > 100K | 一行状态行:建议压缩 + 指向 context_status |
| L2 加压档 | > 200K | 一行状态行:加压提示 + target 约束 + 指向 context_status |
| L3 截断档 | > 300K | 一行状态行:最后通牒:「下一轮必须成功压缩,否则宿主将强制压缩」+ 指向 context_status |

(命名约定:档位用「激活/加压/截断」,压缩方式用「普通/强力/强制」,两者不同名以防混淆。)

档位数值运行时动态可调;配置约束:L3 < 0.5×窗口−20K,否则高档位不可达(总量线与压缩区线联合约束,见 §11)。

### 5.2 压缩方式三级

| 级 | 触发 | 行为 |
|---|---|---|
| 一级·普通压缩 | 活跃区 ≤L3 且压缩区未超限,模型主动 compress_context | keep 自选(校验 §6);压缩块**累加**到压缩区末尾;method="normal" |
| 二级·强力压缩 | 活跃区 >L3(与 L3 档同线),**或**待强力状态下模型主动 compress_context | 同一工具同一 schema;执行按强力语义:新压缩块 supersedes 全部未 supersede 压缩块、depth+1、method="strong",compressedIds/index 继承被取代块全集并并入本次新压部分;压缩区渲染只剩单块 |
| 三级·强制压缩 | L3 通牒送达后下一个 assistant turn 结束仍无成功压缩;或总量保险线触发 | 宿主强制模型调用 compress_context(强力语义,meta.forced=true);**强制形态按 provider 能力选**(P2 实证):①named tool_choice(`setForcedToolChoice`,官方 Anthropic/OpenAI 及多数面;注意兼容面可能无视——kimi/MiniMax-openai 实测无视 named)②`required` + 工具集收窄为仅 compress_context(kimi 实测可用;openai-completions 面内建)③两者均不可用 → 直接降级。**强制 turn 结束仍无成功压缩(含校验屡败、输出不合法),或 API 错误 → 降级** |

**唯一二维决策表**(状态 → ephemeral 文案档位 → 本次 compress 执行方式;边界一律严格大于,活跃区恰好 = L3 值 → L2 档 + 普通压缩):

| 活跃区 | 压缩区 | 档位文案 | compress 方式 |
|---|---|---|---|
| ≤L1 | 未超线 | 零注入(模型经 context_status 自决) | 普通 |
| (L1, L2] | 未超线 | L1 建议 | 普通 |
| (L2, L3] | 未超线 | L2 加压 + target | 普通 |
| >L3 | 任意 | L3 通牒 | 强力 |
| >L1 | 超线(待强力) | 加注「下次为强力压缩」 | 强力 |
| ≤L1 | 超线(待强力) | 同上 | 普通(不搭车) |
| 三级触发 | 任意 | — | 强力(forced) |

**轮次归属**(回应审阅):档位轮末判定,通牒随下一次请求注入(ephemeral);**通牒送达后的下一个 assistant turn 结束**才判"未响应";无自然下一请求(空闲)则等待,不主动唤醒(空闲时活跃区不增长,无风险;探针证实 assistant 结尾无法自动续请求)。**通牒伴随合成 status 对(v10.1)**:凡注入通牒文案的请求(L3 档,或三级强制已武装/保险线直接触发),同时在活跃区末尾、通牒行之前注入一对**合成** context_status tool 对(规则见 §6)——被强制调用时模型手里已有清单,强制也是有依据的挑选。

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


### context_status(v10:清单 pull 通道)

```json
{ "name": "context_status", "input": {} }
```

模型按需拉取压缩仪表盘。返回:当前档位 + 本次允许的压缩方式(普通/强力)/ 活跃区 tokens / 投影总量 tokens / 档位指令文案(L1 建议、L2 加压+target、L3 最后通牒;待强力加注)/ **当轮候选清单**:候选块按大小降序全列,每行 `bN | tokens | intent或截断句`(短号,§3);清单渲染超 8K token 截尾部(较小块豁免,下轮重进,多轮收敛);返回整体走底座工具结果截断管道(50KB 内联,全文落盘 read 分段)。工具描述引导模型:随时可用,建议完成阶段性任务后主动查询并压缩(动机来自工具描述,档位提示仅作仪表盘与通牒)。

**status tool 对的投影剔除**:context_status 的 tool_use/tool_result 对**不进压缩候选**(模型压不到它);并在**下一次成功 compress_context 执行后**从投影中整对摘除(旧清单已失效,留着是误导;即使落在保护区也摘——保护区例外)。存储不动,配对断言不变(成对摘除)。

**通牒伴随的合成 status 对(v10.1)**:注入通牒文案的请求(§5.2:L3 档,或三级强制已武装/保险线直接触发)在活跃区末尾、通牒行之前注入一对**合成**消息——assistant(tool_use: context_status)+ user(tool_result: [acp-report] 当轮清单)——使被强制调用的模型手里已有清单。约束:**只造新 assistant,不得向既有 assistant 插入 tool_use**(thinking 签名风险 = OQ2 同源、中段改动破坏前缀缓存、投影纪律禁改既有消息内容);合成对不落 journal(每轮由注入条件驱动重放);清单快照冻结(注入条件持续且无新块则逐字节稳定);成功压缩后停止注入旧快照(语义同剔除规则——旧清单失效),若仍处通牒态则以新快照继续注入(新一轮通牒)。合成对不进压缩候选。wire 形态为双面正常工具回合(P2 实证重组合法);官方面复测加形态确认。

### compress_context

```json
{
  "name": "compress_context",
  "mutex": "host per-session 互斥锁(锁内完整校验序)",
  "input": { "keep": ["blockId"], "summary": "被压块整体摘要(强力压缩时为压缩区总摘要)" }
}
```

**互斥与清单消费**(v9 补遗修正):customTools 通道拿不到 `concurrency:"exclusive"`(ExtensionToolWrapper 未实现该字段,默认 shared),**改由 host per-session 互斥锁串行化 compress 执行**——锁内跑完整校验序,并发第二个调用在锁内重校验时被拒。防投机无需处理:投机执行是 opt-in(工具须自带 `ToolSpeculationPolicy`),ACP 工具不声明即永不投机。**当轮清单被一次成功提交即消费**:同轮后续调用一律拒绝"清单已消费,等待下轮新清单";**校验失败的调用不消费清单**(可修正重试)。

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
- **分层注入(v10,pull 替代 push)**:无档(活跃区 ≤L1 且非待强力)**零注入**——历史前缀完全稳定,压缩时机归模型(工具描述引导);L1/L2/L3 与待强力注入**一行精简状态行**:档位 + 本次允许的压缩方式 + 活跃区/投影总量 tokens + 指令文案(L1 建议、L2 加压+target、L3 最后通牒;待强力统一加注「下次压缩为强力压缩」)+ 指向 context_status 取清单。**不含清单本身**——当轮候选清单(短号、降序、8K 截尾豁免、多轮收敛)移至 context_status 返回(§6)。
- **缓存安全**:零注入期持久前缀(tools/system/压缩区/活跃区)逐字节稳定;注入期档位不变时状态行逐字节稳定,最大化末尾局部缓存复用。

## 8. token 计数

- 复用底座 Tokenizer(Rust native BPE;文本 LRU 缓存):档位判定、块大小清单、keep 校验、保险线判定统一用同一实例。**注意**:底座消息级 memo 是 WeakMap(对象引用键),而 context 事件每轮交付 deep copy 新引用——host 侧该 memo 每轮 miss;host 自建 fingerprint → tokens 的 Map memo(复用 ACP 原型 messageFingerprint 机制),仅对新增/变更块计数。
- acpSummary 不参与底座消息计数;压缩块 token 数 = 投影层对其渲染文本做 countTokens。
- 块大小在块 settled(流式结束)且 stale prune 运行后计算并 memo;流式中的块不进候选。
- unknown encoding 兜底 byte 估算(三档判定同步降级,可接受)。
- 图片/加密 reasoning 按底座现有估算规则计入所属消息块。

## 9. 持久化与状态重建

- 压缩块 = SDK custom entry(customType="acpSummary"),session JSONL 持久化(**纯持久层:`appendCustomEntry` 官方通道,`buildSessionContext` 忽略之;运行时经 host 投影渲染,不进底座消息转换与计数**),`data` 字段:
  - `summary: string`、`shortSummary?: string`
  - `index: [{ id, tokens, intent }]`(完整索引;强力压缩块继承全集,不受渲染截断影响)
  - `meta: { createdAt, depth, method: "normal" | "strong", forced?: boolean, keepIds, compressedIds, supersedes: string[], tokensBefore, tokensAfter }`
- **重建**(host 启动会话时扫描 entries 按 customType 过滤):
  1. 检测到任何底座 compaction entry → 降级模式(§5.3),ACP 状态不推进;
  2. 否则:压缩区 = 未被任何 acpSummary.meta.supersedes 覆盖的 acpSummary,按序;
  3. 消息块:出现在任一未 supersede 压缩块的 compressedIds 中 → 已压缩;其余 → 活跃。(强力压缩块经 §6 继承规则持有全量 compressedIds,重建无需递归展开 supersedes 链。)
- strategy=acp 会话自身不产生底座 compaction 记录;唯一来源是降级路径(§5.3)。

## 10. 实施集成点(omp-desktop host 层)

| 点 | 位置(omp-desktop host 层) | 改动 |
|---|---|---|
| 会话装配 | `host/session-lifecycle.ts` ACP 注入段(acp.enabled 开关先例已存在)+ `createAgentSession({ settings: Settings.isolated({ "compaction.enabled": false }) })` | ACP 会话注册 extension + customTools,并 **per-session 关闭底座自动压缩**(底座 shouldCompact 判 stored journal 口径,ACP 投影不影响之——不关则 journal 增长必致底座压缩误触发、冲掉 ACP 结构;= v8「strategy off」语义的 host 实现);降级时恢复该会话压缩能力(Settings 为活对象,后续写入可达) |
| 档位判定 | host ACP 状态机 | 活跃区三档;**不**使用底座 `compactionContextTokens` 的 stored 地板 |
| 保险线 | 同上 | 投影后总量 vs 窗口 − 15% reserve |
| 投影 + ephemeral | context 事件 extension(`host/acp-context.ts` 现有 transformContext 同一接缝) | 块过滤重组 + 压缩块渲染为 user 文本段 + `[acp-status]` 末尾追加(§4/§7) |
| 预处理 | 底座 prune 管道(不动) | 照常运行;prune 重写 journal 后 context 视图自然反映,ACP 计数用 prune 后值 |
| 工具注册 | `createAgentSession({ customTools })`(`host/acp-tools.ts` 先例,ToolDefinition 形态) | context_status / compress_context / recall_block;compress 执行挂 host per-session 互斥锁(§6,exclusive 通道不可用);降级后不再注入 |
| 强制调用 | 三级触发:`AgentSession.setForcedToolChoice("compress_context")`(公开 API,已验证:强制下一次模型调用指定工具、[forced,"none"] 序列调完即止;工具须在 active 集——customTools 注入天然满足;模型不支持时抛错 = 降级出口) | meta.forced=true,按强力语义;失败即 §5.3 降级 |
| 持久 entry | `SessionManager.appendCustomEntry` | customType="acpSummary"(§9) |
| 计数 | `@oh-my-pi/pi-agent-core` 导出 `Tokenizer`(18.8.6 验证) | 档位判定/清单/校验/保险线统一实例(§8) |
| 兜底 | 降级路径 | ACP 注入物移除 + 恢复 compaction.enabled = 底座默认链路 methodOrder 接管(§5.3) |

## 11. 参数表(SSOT,实现以本表为准)

| 参数 | 值 | 备注 |
|---|---|---|
| L1 / L2 / L3 | 100K / 200K / 300K(活跃区 token) | 默认值,运行时动态调整;配置约束:L3 < 0.5×窗口−20K,否则高档位不可达 |
| tierMode(v10.2 实现层) | `acp.tierMode`:"absolute"(缺省,l1/l2/l3 存 token 数)或 "percent"(l1/l2/l3 存百分数,会话创建时按模型 contextWindow 换算为 token 线;窗口缺失/非正回退 absolute 语义) | 小窗口模型高档位不可达缺口的修复;UI 见实验设置页 ACP 区(absolute 输入单位 K,percent 单位 %) |
| **target(压缩目标线)** | 默认 = L1(100K),可配置,可调更低 | 压缩后允许的活跃区大小:keep + 保护区 ≤ target;普通/强力统一生效(v7 Decider 拍板) |
| minCompress | 20K | 成功压缩的被压集下限(v7);清单可压总量低于它的极端碎块场景不特化,三级无进展即降级(v8) |
| summary 预算 | ≤ min((本次被压 + 参与重置旧摘要) ÷ 3, 8K) | v3 修正基数 |
| 压缩区限额线 | 窗口 × 35% | 进入待强力状态;活跃区>L1 时下一次 compress 搭车为强力压缩 |
| 总量保险线 | 投影总量 > 窗口 − 15% reserve | 触发三级强制;失败即降级 |
| 尾部保护区 | 默认 max(最近 2 turn, 最近 20K token),可配置,可为 0 | **待探针 3 回填** |
| 当轮清单截断 | context_status 返回内:短号按块大小降序;渲染超 8K token 截尾部(小块豁免,下轮重进) | v10 清单从 ephemeral 移入 context_status 返回;短号见 §3 |
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
| 12 | 清单(context_status 返回)后新到块不进当轮清单、不被压 | 时序测试 |
| 13 | 同批两个 compress_context:host 互斥锁串行;第一个成功 → 清单已消费 → 第二个在锁内重校验被拒(含 keep=[] 场景);第一个校验失败 → 清单未消费,修正重试可成功;compress 永不被投机执行(未声明 ToolSpeculationPolicy) | 并发测试 |
| 14 | summary 超预算拒绝;纯重置(本次被压=0)以旧摘要为基数可正常提交 | 工具校验测试 |
| 15 | 清单按块大小降序,截断尾部小块豁免;极端块数(4000×100 token)下逐轮收敛无死锁;模型全保留致被压集空 → 拒绝促其修正 | 集成测试 |
| 16 | L3 档被压集 <minCompress:放行但不计入成功压缩(三级照常触发);L2 档放行带 warning;校验通过与否不受 minCompress 影响 | 工具校验测试 |
| 17 | recall 大结果:走底座截断管道,截断后完整版落盘、read 分段可取全;supersede 块 recall 重定向到最新强力压缩块并注明取代链 | 集成测试 |
| 18 | prune 管道运行后块变小,档位判定用 prune 后值;prune 不破坏配对不变量 | 集成测试 |
| 19 | 边界一致:活跃区恰好 = L3 值 → L2 档文案 + 普通压缩(无通牒不强力);ephemeral 同时输出当前档位与本次允许的压缩方式 | 单元测试 |

## 13. 实现期探针(先于主实施,按序)

**P1/P2 兼容面已跑**(2026-10-12,脚本 `omp-desktop-acp/.local-probe/p1-anthropic-block-filter.ts` / `p2-openai-completions.ts`,env 覆盖可复测官方面):

1. **P1 · Anthropic thinking 签名**(MiniMax-M2.5 兼容面,9 请求):V1 留 tool 对摘 thinking(ACP 核心场景)✅ 200;V2 留 thinking(带 64-hex 签名)摘 1 tool 对 ✅ 200(该面不重放校验签名);V3 对照 ✅;**V4 诊断:单边 tool_use 无 result → 400「tool call result does not follow tool call (2013)」**——配对不变量被服务端强校验,§4 断言实证必要。MiniMax 面 thinking 可独立于 tool 对摘除(catalog `replayUnsignedThinking:true` 佐证)。**官方 Anthropic 待测**(明天凭证):V2 为最高风险场景(官方签名加密绑定前缀,预期可能 400;失败则 §3 降级为 thinking 与 tool 对共进退,OQ2 关闭);复测命令与清单见 `.local-probe/p1-last-run.json`。
2. **P2 · OpenAI completions 面**(kimi-k2.5 + MiniMax-M2.5-lightning,18 请求):①过滤重组(tool_calls 子集 + 对应 tool 响应子集 + 新 user)两面 ✅ 200(kimi 需 SDK 自动合成占位 content,`requiresAssistantContentForToolCalls` 已内建);②**named tool_choice 两面均被模型无视**(HTTP 200 但文本作答,两次独立运行一致);kimi `required`+工具集收窄为 `[compress_context]` ✅ 实际调用;MiniMax-lightning 连 required 也无视 → 该面三级只能降级。官方 OpenAI 待测:named 强制、`required`+收窄、gpt-5 系对强制 tool_choice 的限制。
3. **保护区 A/B**:0 vs 默认(max 2 turn / 20K),观察断片率与压缩意愿。→ 回填参数表(待全链路可用)。
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
2. **thinking 块独立性** — 状态:兼容面已测通过(MiniMax:thinking 可独立于 tool 对,§13.1);**官方面待复测**(V2 场景最高风险,签名加密绑定前缀);决策人:探针结果;门禁:官方 V1/V2 通过则维持"独立可选"并关闭本条,V2 失败则修订 §3 为"与 tool 对共进退"并关闭本条。
