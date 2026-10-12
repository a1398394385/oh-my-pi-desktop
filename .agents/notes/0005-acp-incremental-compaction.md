# ADR-0005: 采用 ACP 双区增量压缩协议

**Status**: Accepted(2026-10-12)
**Decider**: xys
**Informed by**: 2026-10-12 设计讨论会话;底座 oh-my-pi 压缩链路(packages/agent/src/compaction/、packages/snapcompact/)

## Context(背景)

- 底座现有压缩路径:本地整段总结(cut point 之前全部压掉)、snapcompact 位图归档、provider 端 remote compaction(Anthropic beta / OpenAI V1/V2)。共同局限:**触发晚**(临近窗口才动手)、**粒度粗**(切点之前一刀切,无法细粒度保留"哪几块历史还有用")、**摘要无索引**(压缩后老历史成黑盒)。
- 长会话多任务场景下,已完成任务的历史持续占据上下文,加速上下文腐败;设计目标是**保持活跃区尽量小**,让模型主动管理上下文构成。
- Kimi 等长上下文供应商有前缀缓存,压缩方案必须显式论证缓存影响。

## Decision(决策)

在底座压缩链路中新增 strategy(工作名 ACP 双区增量压缩),最终兜底仍走底座默认压缩流程:

1. **双区模型**:消息分压缩块/活跃块(全局唯一 ID);上下文 = [tools][system][压缩区][活跃区]。
2. **块模型**:assistant 消息拆为 thinking 块 + text 块 + tool 对块×N;tool 对 = tool_use + 其 result 一个整体,ID 挂 result,一轮多个 tool 可拆分选择。
3. **保留清单语义**:AI 调 compress_context 列出**要保留**的块(默认行为 = 进压缩),并给出被压块整体摘要;压缩块追加压缩区末尾。
4. **提示档位 × 压缩方式二维体系**(判定量 = 活跃区精确 token):提示档 L1 激活 / L2 加压 / L3 截断(ephemeral 注入,边界一律严格大于);压缩方式三级——一级普通(活跃区 ≤L3 且压缩区未超线,压缩块累加)、二级强力(活跃区 >L3 或待强力状态下的下一次压缩,重置压缩区为纯摘要初始块)、三级强制(L3 通牒送达后下一轮仍无成功压缩、或总量保险线触发时,tool_choice 强制调用;强制 turn 结束仍无进展即降级 OMP)。保险线:投影总量 > 窗口−15% reserve 触发三级;压缩区 > 窗口×35% 进待强力状态(ephemeral 加注,搭便车执行,无轮次上限)。
5. **recall_block(id)** 工具按 ID 召回历史块,内容走该工具自己的 tool_result 返回。
6. **存储不动、投影重组**:持久历史不改写,发送前经 transformContext 投影过滤;ephemeral 状态提示拼在请求末尾、不落历史。
7. 保留清单**不继承**;每次压缩候选 = 全部活跃块 − 尾部保护区。

契约细节(字段/schema/参数/验收矩阵)归 Spec: docs/architecture/acp-compaction-spec.md。

## Consequences(后果)

**正面**:
- 增量压缩不破坏压缩区前缀缓存;压缩频次与粒度由模型按任务结构决定,已完成任务的历史及时离场。
- 保留清单语义下模型注意力集中在少数要留的块;背包上限天然落在保留侧,校验简单。
- 压缩块带被压块索引清单(id|tokens|intent),老历史对模型保持可定位性,配合 recall 形成"索引→取回"闭环。
- 全链路复用底座触发框架、Tokenizer 缓存、transformContext 管道与默认压缩兜底,不重趟已修过的坑(配对切割/图片定价/thinking 签名)。

**负面**:
- 每次压缩重组活跃区 = 活跃区缓存一次性失效(固有成本)。
- 强力压缩(重置压缩区)下远端历史逐层稀薄(depth 记录 + 专用提示要求保留决策/结论/未决事项,缓解不阻止)。
- 比现有压缩多两个工具的上下文开销与一轮 tool 调用的压缩延迟。

**风险/不确定性**:
- Anthropic thinking 签名校验是否容忍"留 call、压同消息 thinking"的 block 级过滤——未验证,探针 1 决定 thinking 块规则;不通则 thinking 强制随 tool 对共进退。
- 尾部保护区的必要性/大小未实测(Q7 开放,Spec Open Questions 跟踪)。
- 模型压缩合作度:L3 以下纯软提示,模型可能长期不压缩(总量保险线兜底);三级强制(tool_choice)为最终手段,强制 turn 无进展即降级 OMP。

## Alternatives Considered(备选方案)

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 列"要压缩"的块(原始设想) | 直觉 | 默认行为=保留,模型须枚举大量待压块;压缩量阈值校验语义绕 | 保留反转后默认=压缩,清单短、背包上限天然落保留侧 |
| 需要历史时重新执行当时的命令 | 零存储/零新工具 | 仅幂等只读命令可重跑;写操作/已变环境结果≠当时且有副作用;非命令类历史(user 指示/推理/报错)无可执行;结果 token 照样占上下文 | recall 读磁盘 JSONL 确定性、零副作用、全块类型通用;重跑命令模型本来就能做,无需机制 |
| 保留清单跨轮继承(钉住) | 省得重复列 | "曾经的重点"只进不出,活跃区缓慢涨满,违背"活跃区尽量小" | 不继承;每轮基于"现在还需要什么"重判,成本只是一个 ID |
| char/4 估算 token | 零成本 | CJK 1 字≈1-2 token,估算低估 4-8 倍,中文会话三档判定全乱 | 底座 Tokenizer(Rust native BPE + 文本 LRU + 消息 memo)稳态每轮只为新增消息付费,≈亚毫秒;精确值同时喂档位判定与硬门槛 |
| turn 级原子块(assistant+全部 result 不可分) | 配对天然安全 | 粒度太粗:只想保留一轮里一个 tool 结果时被迫整轮留下 | block 级过滤 + "call/result 成对出现、成对消失"不变量,投影层重组即可,存储不动 |
| 压缩提示落历史 | 实现直白 | 含每轮变化的活跃区大小,落历史/插中间都会摧毁其后前缀缓存 | ephemeral 注入拼请求末尾、不落历史;持久部分缓存不受影响 |
| 整体替换底座压缩链路 | 单一机制 | 重趟底座已修的十几个坑;失去 provider 端压缩与 snapcompact 的既有能力 | 作为新 strategy 并存,最终兜底仍走默认链路 |

### v2 演进(2026-10-12,首轮独立审阅 NOT READY 后)

审阅发现 6 项阻断,契约修订见 Spec v2 头部;其中两处为新增决策:

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 幻觉 keep ID 丢弃后继续压缩 | 少一轮往返 | 模型可能忽略 warning,静默丢失保留意图;压缩是重操作,错 keep 代价远大于一轮重试 | 选定「拒绝整个调用 + error 附完整有效候选集」(D2=A 同类哲学:重操作宁拒绝不静默) |
| 底座兜底后以混合态继续 ACP(边界前视为虚拟压缩块) | 保持设计完整 | 重建规则复杂一截,为罕见异常路径付的复杂度不值;且兜底触发本身说明 ACP 未兜住 | 选定「会话降级为底座默认链路」(Decider 拍板 D2=A);降级后底座摘要基于原文全文,信息保留反而更好 |

另三处为事实修正而非决策:`acpSummary` 降为纯持久层 role(底座对未知 role 运行时丢弃+不计数,审阅探针实证 `llmMessages=[]、countedTokens=0`);总量保险线改用投影后口径(底座 stored 地板是为防 on-wire 压缩作弊,ACP 投影是协议行为);互斥改用底座原生 `AgentTool.concurrency:"exclusive"`(12.8.0 起支持,另自动豁免投机执行)。

### v3 演进(2026-10-12,二轮独立审阅 NOT READY 后)

二轮审阅 4 项阻断均为缺陷修正,无新增方向性决策:合并块 compressedIds/index 继承全集(否则重启后旧块复活);当轮清单成功提交即消费(exclusive 只保证串行,不能防重复压缩);清单截断方向改为最老优先、截断最新段(v2 写反,且豁免块不计入 L2 校验否则极端块数死锁);summary 预算基数含参与合并的旧摘要(否则纯合并恒拒)。新增参数:L3 实质进展阈值(单轮被压 ≥ 32K 免硬压),支持极端块数下的多轮分批收敛。

### v4 演进(2026-10-12,Decider 澄清合并语义)

压缩区超 35% 线的正确语义 = **主动触发一次 L3 全量压缩流程**(主 agent 在当前轮基于自己正在看的上下文撰写总摘要,零额外 input);v3 误写为"下一次普通压缩顺带合并",其隐含形态是独立摘要调用(input = 旧摘要 + 本次被压块全文,压缩区 90K + 被压上百 K 时单次 input 奔 200K,不可行)。配套:合并触发时允许空被压集(纯合并)。

### v5 演进(2026-10-12,合并机制隐患发散)

合并触发语义的三处修正:硬压摘要改为旧摘要机械拼接+截断最老(模板"统计+索引"会销毁全部已积累摘要);纯合并跳过 keep 上限(不强迫压缩健康活跃区);recall 已 supersede 块重定向到最新合并块。另发现结构性约束:总量线与 35% 合并线联合约束下,L2/L3 名义档位需窗口 ≳440K/640K 才可达,256K 窗口退化为单档——记入 Spec Open Questions 待 Decider 拍板(声明窗口门槛 vs 档位随窗口缩放)。

### v6 演进(2026-10-12,Decider 拍板搭便车语义)

压缩区超 35% 线不再"立即触发 L3 通牒"(v4),改为**待合并状态**:ephemeral 统一加注"下次压缩为 L3 全量",活跃区>L1 时模型下一次主动 compress 搭车按 L3 语义执行;活跃区≤L1 不搭车;无轮次上限(超线无害、总量线兜底)。理由(Decider):合并是维护性操作,不应打断任务流;搭便车让模型自择时机。同轮拍板:档位数值运行时动态调整(配置约束 L3<0.5W−20K 入参数表注);recall 大额召回风险由既有工具裁剪机制覆盖,不设专门规则。新增待决:纯合并 keep 豁免(OQ4)、硬压摘要方式(OQ5,推荐强制 tool_choice)。

### v7 演进(2026-10-12,Decider 拍板三级体系 + 四轮审阅)

压缩方式三级化(Decider 拍板):一级普通压缩(活跃区<L3,压缩块累加);二级强力压缩(活跃区≥L3 或压缩区超 35% 限额时的下一次压缩,重置压缩区为纯摘要初始块,搭便车语义沿自 v6);三级强制压缩(L3 通牒送达后下一轮仍无成功压缩,或总量保险线触发时,tool_choice 强制 compress_context;强制失败即降级 OMP——OQ5 关闭,v3/v5 的模板/拼接硬压路径删除)。「豁免」重新定义为可配置的压缩目标线 target(keep+保护区≤target,默认=L1,可调更低),普通/强力统一生效——OQ4 关闭。档位数值运行时动态可调,配置约束 L3<0.5W−20K 入参数表——OQ3 关闭。四轮审阅(P1 清单轮次归属/P3 recall 截断)处置:通牒轮次归属明确为「送达后下一个 assistant turn 结束才判未响应」,空闲等待不主动唤醒;recall 大结果走底座统一工具结果截断管道(落盘+read 分段,可遍历),不做内置截断;当轮清单改为按块大小降序截断(Decider 拍板)。参考 OMP 压缩链路(docs/compaction.md + session-maintenance.ts 编排):预处理剪枝管道与 ACP 正交并存(prune 先行,ACP 计数用 prune 后值),进度守卫/失败封顶/降级哲学对齐。


### v8 演进(2026-10-12,四轮审阅 3 项 + Decider 裁量)

四轮审阅处置:① L2「强力档」与二级「强力压缩」命名撞车 → 档位改名「加压档」,并新增唯一二维决策表(状态 → 文案档位 → 压缩方式),边界统一严格大于;② 三级强制在「清单可压总量 < minCompress」下无终态 → 先改为 min 取小,**Decider 裁量回退**:极端碎块场景不特化(正常 coding 会话不出现),保留通用终态「强制 turn 无成功压缩即降级 OMP」即可接住,后续视需要再加块数量上限;③ ADR Decision/Consequences 同步至三级体系(此前只加演进段未回改当前值,SSOT 冲突)。

### v9 演进(2026-10-12,Decider 拍板实施宿主)
**全量实施于 omp-desktop host 层,底座源码零改动**(理由:ACP 本体改动量大且难被底座上游接收;omp-desktop 既有 ACP nudge 原型 host/acp-*.ts 已验证全部接缝)。接缝映射:投影/ephemeral = context 事件 extension;双工具 = `createAgentSession({ customTools })`;压缩块持久化 = SDK `SessionManager.appendCustomEntry`(customType="acpSummary",官方「persist extension state across reloads」通道,`buildSessionContext` 忽略)——§9 存储位置不变(仍 session JSONL),实现通道由「新增 message role + declaration merging」改为 custom entry;精确计数 = import `@oh-my-pi/pi-agent-core` Tokenizer(18.8.6 实证导出)。同日接缝实证补遗:三级强制 = `AgentSession.setForcedToolChoice`(公开 API,已验证,T7 无待验证项);ACP 会话经 `createAgentSession({ settings: Settings.isolated({ "compaction.enabled": false }) })` per-session 关闭底座自动压缩(底座压缩判定用 stored journal 口径、不受 ACP 投影影响,不关则 journal 增长必致误触发——v8「strategy off」语义的 host 实现),降级时恢复。

## Related(关联)

- Spec: docs/architecture/acp-compaction-spec.md(实施合同,验收矩阵在其中)
- 底座源码: /Users/xys/Github/oh-my-pi/packages/agent/src/compaction/(shouldCompact / findValidCutPoints / transformContext)、packages/agent/src/tokenizer.ts(精确计数缓存)
