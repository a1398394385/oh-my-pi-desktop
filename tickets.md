# Tickets: ACP 双区增量压缩实施队列

> 把已完成终审的设计(spec READY,2026-10-12)落成可接手的实施票:块模型、投影、双工具、三级压缩与降级,全部端到端可验收。
>
> **Triage**: `ready-for-agent`
>
> 来源与合同 SSOT:[Spec](docs/architecture/acp-compaction-spec.md)(实施合同,验收矩阵 §12、参数表 §11)· [ADR-0005](.agents/notes/0005-acp-incremental-compaction.md)(决策 SSOT)。票面不重复契约细节,验收括号引用 spec 验收矩阵编号。
>
> **实施仓库**:omp-desktop **host 层**(`host/` 目录,底座源码零改动,v9 修订);实施 worktree `/Volumes/MacApps/Github/omp-desktop-acp`(分支 `acp-compaction`)。既有 ACP nudge 原型(`host/acp-state.ts` / `acp-context.ts` / `acp-tools.ts`)是演进的底座,其踩坑经验(ref 指纹稳定编号、尾部注入防复读标签、事务边界扩展、投影与 journal 坐标系隔离)保留复用。
>
> 边界约束(全队列有效):
>
> - 设计不可擅改:票中发现 spec 缺陷/歧义,停下上报,不带「开工后现设计」的票继续;事实性小修(行号漂移等)直接改并在回报单列。
> - host 文件不进 tsc;验证 = 单进程 bun 冒烟脚本直跑(`OMP_PROFILE=acp-probe bun run <script>`,禁止全仓 `bun test --parallel`)+ `bun run check`;探针/冒烟脚本放 worktree `.local-probe/`(untracked)。注意 profile 实际目录是 `~/.omp/profiles/acp-probe/agent/`(pi-utils profiles 布局;凭证与 kimi-device-id 已就位)。
> - 真机探针(P1/P2/P4)走真实 API、产生小额费用;探针脚本保留至官方面(Claude/GPT)复测完成再清理,不写入用户默认 profile 的会话数据。
> - 代码注释英文,匹配 host 现有风格;提交遵守「票绿即 commit」(worktree 内 commit,不 push、不提 PR——未经用户明确授权)。
> - 每票完成:focused 测试绿 + typecheck 绿即 commit;commit message 解释为什么。
>
> 侦察已确认的接缝(2026-10-12,供接票 agent 起步;行号会漂移,以符号为准):
>
> - 会话装配:`host/session-lifecycle.ts` 已有 ACP 注入段(acp.enabled 开关 → extension + customTools 注入);ACP 会话在此基础上演进,并经 `createAgentSession({ settings: Settings.isolated({ "compaction.enabled": false }) })` **per-session 关闭底座自动压缩**(底座压缩判定用 stored journal 口径、不受 ACP 投影影响,不关则必误触发),降级时恢复(Settings 活对象可再写)。
> - 投影 + ephemeral:context 事件 extension(`host/acp-context.ts` 现有 `transformContext(state, messages)` 同一接缝;每轮 deep-copy 视图、安全重写、不回写 journal——§7 ephemeral 注入同点)。
> - 工具注册:`createAgentSession({ customTools })`(`host/acp-tools.ts` 五工具先例,ToolDefinition 形态);**exclusive 通道不可用**(ExtensionToolWrapper 未实现 concurrency)→ compress 执行挂 host per-session 互斥锁(锁内完整校验序);投机执行 opt-in(未声明 ToolSpeculationPolicy 即永不投机),无需防护。
> - 持久化:`SessionManager.appendCustomEntry(customType, data)`(SDK 公开 API,session-manager.ts:3512);custom entry 不进 LLM 上下文(`buildSessionContext` 忽略),重建 = 扫描 entries 按 customType 过滤(接口文档官方建议模式)。
> - 精确计数:`@oh-my-pi/pi-agent-core` 导出 `Tokenizer`(Rust native BPE,18.8.6 实证)。
> - prune 两层门控(实证):stale prune(supersedeReads/dropUseless 独立设置,默认 true)在 compaction.enabled 门控**之前**、关压缩后照常;overflow prune 随 enabled=false 关闭,职能归 ACP 保险线/降级(§4)。
> - mock rig:`node_modules/@oh-my-pi/pi-ai`(18.8.6)`createMockModel`(脚本化响应 + calls 断言)。
> - 三级强制:`AgentSession.setForcedToolChoice(toolName)` 公开 API(已验证:强制下一次模型调用指定工具、[forced,"none"] 调完即止;工具须 active——customTools 天然满足;不支持时抛错即降级出口)。
> - 其他已实证接缝:`AgentSession.sessionManager` 公开 getter(recall 读原块/重建扫描/降级检测);`customTools?: (CustomTool | ToolDefinition)[]`;`AssistantMessage.content` 为 block 数组(Thinking/Text/Image/ToolCall 各自独立元素,块模型域内直接映射);`#compactionSettings` 为 getter 每轮动态 resolve(**Settings.isolated 后续写入即时生效**,降级恢复无延迟);context 事件 handler 返回 `{ messages }` **数组级替换**(ephemeral 追加/压缩区头部插入可行;沿用原型 pass-through 兜底:transform 失败透传原视图,绝不炸请求);`new Tokenizer(model)` 直建(文本 LRU);`createAgentSession({ model })` 显式传模型 + `createMockModel`(T3 mock 装配);`AgentSessionEvent` 事件流导出、host 已消费(T4 轮末判定挂点)。

## 依赖图

```text
P1  探针:Anthropic thinking 签名    ← frontier
P2  探针:OpenAI/Kimi 面             ← frontier
T1  块模型 + 投影核心                ← P1
T2  acpSummary 持久化 + 重建        ← T1
T3  compress_context + 一级压缩     ← T2、P2(首个端到端 tracer bullet)
T4  ephemeral 提示 + 档位 + 清单    ← T3
T5  recall_block 工具               ← T3(与 T4/T6 并行)
T6  二级强力压缩 + 待强力           ← T4
T7  三级强制 + 保险线 + 降级        ← T6
P4  探针:ephemeral 缓存实测         ← T4(与 T6/T7 并行)
P3  探针:保护区 A/B + 参数回填      ← T7(队尾观测)
```

---

## P1: 探针 — Anthropic thinking 签名对 block 级过滤的容忍度

**What to build**:回答 spec OQ2——「留 call、压同消息 thinking」的 block 级过滤后,真 Anthropic API 的 thinking 签名校验是否通过。探针脚本驱动真 thinking 模型:第一轮产生带 thinking + 多 tool_use 的 assistant 消息;构造第二轮请求,对历史做三种投影形态各发一次:①留部分 tool 对、摘除同消息 thinking;②留 thinking、摘除部分 tool 对;③不过滤(对照)。记录 API 接受/拒绝。

**Blocked by**: None — can start immediately
**Status**: 兼容面 done(2026-10-12 MiniMax-M2.5 实测:V1/V2/V3 通过、V4 单边 400 实证配对强校验;thinking 可独立摘除;报告 spec §13.1);官方面待凭证(env 复测:`PROBE_BASE_URL=https://api.anthropic.com PROBE_MODEL=<claude> ANTHROPIC_API_KEY=... bun .local-probe/p1-anthropic-block-filter.ts`),V2 失败则触发 §3 thinking 规则修订(OQ2)

- [ ] 三形态各一次真 API 调用,结论明确(通过/Invalid signature/其他错误码)
- [ ] 结论回填 spec:通过 → §3 维持 thinking 独立可选,OQ2 关闭;不通过 → §3 修订为 thinking 与同消息 tool 对共进退,OQ2 关闭
- [ ] 探针脚本删除,无残留会话数据写入用户 profile

---

## P2: 探针 — OpenAI/Kimi 面对过滤重组合 tool_choice 强制的接受度

**What to build**:回答 spec §13.2——①过滤重组后(assistant 的 tool_calls 子集 + 对应 role=tool 消息子集)的请求在 OpenAI 与 Kimi 真面的合法性;②`tool_choice` 强制指定某自定义工具(将来的 compress_context)各面是否生效、行为形态。探针脚本走真 API,小请求验证。

**Blocked by**: None — can start immediately
**Status**: 兼容面 done(2026-10-12 kimi-k2.5 + MiniMax-M2.5-lightning 实测:过滤重组两面通过;named tool_choice 被无视,kimi required+收窄可用、MiniMax 无视一切;报告 spec §13.2);官方面待凭证(`bun .local-probe/p2-openai-completions.ts openai <modelId>`);kimi 复测需重取 access token(refresh token 复制后失效,见探针报告)

- [ ] OpenAI 面:过滤重组合法性结论 + tool_choice 强制结论
- [ ] Kimi 面:同上两项
- [ ] 结论回填 spec §13.2(或标注为对应实施票的注意项)
- [ ] 探针脚本删除

---

## T1: 块模型 + 投影核心(host 纯函数层)

**What to build**:ACP 的数学核心——把消息拆成逻辑块(§3:thinking `id#t` / text `id#x` / tool 对挂 result id;thinking 规则按 P1 回填结果实现)。**域映射已实证**:omp 域 `AssistantMessage.content` 即 block 数组 `(TextContent | ThinkingContent | RedactedThinkingContent | ImageContent | ToolCall | …)[]`——块级过滤 = content 数组按块过滤 + 删除对应 `ToolResultMessage`(toolCallId 配对),不需要 wire 级操作;「Anthropic 聚合 / OpenAI 多条」重组由底座 provider 层从 omp 域自然生成,T1 只做域内过滤。给定保留集输出投影消息序列:压缩区渲染(元数据头 + 摘要 + 索引清单,单块索引超 4K token 截最老段 + recall 提示行)、活跃区 block 级过滤重组、配对断言(单边留存抛错)。纯函数 + 单测直接喂保留集,不接会话。

**Blocked by**: P1
**Status**: done(2026-10-12,worktree commit a5207f6;冒烟 11 组断言 + `bun run check` 绿;注意:配对断言对未完结 turn 的无 result tool_use 豁免——不属压缩候选,与 §8 流式块不进候选一致;压缩块渲染头字段序已冻结,T2 复用)

- [ ] 一轮 3 tool 保留 1:投影 assistant 只含该 call,配对断言通过(验收 1)
- [ ] 全块被压的 assistant 整条消失,无 orphan use/result(验收 2)
- [ ] Anthropic 与 OpenAI 两种重组形态各自正确
- [ ] 压缩区渲染含元数据头/摘要/索引行 `id | tokens | intent`,超 4K 截最老段 + `… N more` 提示行
- [ ] 投影输出含单边 tool_use/result 时配对断言抛错(实现期防御)

---

## T2: acpSummary 持久化 + 状态重建

**What to build**:压缩块的持久层——SDK custom entry(customType="acpSummary",经 `SessionManager.appendCustomEntry` 写入;`buildSessionContext` 忽略之,不进 LLM 上下文,投影层自己 countTokens),`data` 承载 meta 全套字段(§9:summary/index/meta.createdAt/depth/method/forced/keepIds/compressedIds/supersedes/tokensBefore/tokensAfter);重启重建:扫描 entries 按 customType 过滤,压缩区 = 未被 supersede 的 acpSummary 按序,活跃 = 不在任一未 supersede 压缩块 compressedIds 中的块;检测到底座 compaction entry 即进降级模式(ACP 状态不推进)。

**Blocked by**: T1
**Status**: done(2026-10-12,worktree commit 1ec8a05;真实 SDK 全链路冒烟 4 组断言 + check 绿;遗留小尾巴:T2 冒烟自删只删 JSONL 不删目录与 .lock.os 锁文件——随 T3 修补;malformed acpSummary 重建抛错(spec 未规定,按快速失败准则保留,T3 装配层如需降级再议))

- [ ] 压缩块 JSONL 持久化,重启重建压缩区/活跃集正确(验收 10 前半)
- [ ] 含底座 compaction 记录的会话重建即降级(验收 10 后半)
- [ ] acpSummary 不进底座 LLM 转换、不参与底座消息计数;块 token = 投影层对渲染文本 countTokens
- [ ] 强力压缩块 compressedIds/index 持全集,重建无需递归展开 supersedes 链

---

## T3: compress_context 工具 + 一级普通压缩 + 集成接线(首个端到端 tracer bullet)

**What to build**:第一个活着的端到端路径——mock model 会话(ACP 开关启用,`createMockModel` + `createAgentSession({ model })` 装配)中模型调用 `compress_context(keep, summary)` → 六条校验序(§6:清单已消费/幻觉 ID 拒绝并附完整候选集/keep+保护区>target 拒绝报差额/summary 空/summary 超预算/被压集空)→ 执行:压缩块经 appendCustomEntry 追加压缩区、消费当轮清单、tool_result 返回被压/keep 数与 token、活跃区新大小、新档位 → 下一轮请求投影生效。接线:会话装配(见头部接缝清单,acp.enabled 开关演进为 ACP 完整装配)+ compress_context 注册(customTools,执行挂 host per-session 互斥锁)。本票清单来源可为测试直供(T4 才有 ephemeral 清单)。

**Blocked by**: T2、P2
**Status**: done(2026-10-12,worktree commit 6038773;12 组断言冒烟 + check 绿,首个端到端 tracer bullet 闭环;两个实现级偏离已审:①§6 ⑤零基数拒绝已点名空被压集,行为与⑥等价,维持字面序;②§10 生产装配用 settings.overlay 替代 isolated——降级后底座需按用户 methodOrder 接管,isolated 会静默换成 schema 默认,overlay 同样 per-session pin 且保留用户配置;注意:底座 date/cwd reminder 骑在首个 user turn 上,wire 级字节断言须计入该前缀,P4/验收9工具化时注意。遗留:原型三文件不再接线但在盘(fingerprint 仍被复用,legacy 设置页字段未清,后续票清理);Tokenizer 绑定会话初始模型,中途切模型待 T4+ 重绑)

- [ ] 六条校验序按序实现;任一失败零副作用、不消费清单;幻觉 ID 拒绝附完整有效候选集(验收 3)
- [ ] keep + 保护区 > target:拒绝并报差额(验收 4)
- [ ] 同批两次 compress:exclusive 串行;第一个成功 → 清单已消费 → 第二个拒绝(含 keep=[]);第一个失败 → 可修正重试(验收 13)
- [ ] summary 超预算拒绝;基数含参与合并的旧摘要(验收 14 前半)
- [ ] 被压集 <minCompress:L2 档放行带 warning、L3 档放行但不计成功压缩;不影响校验通过(验收 16)
- [ ] 压缩前后 tools/system/压缩区渲染前缀逐字节一致;活跃区缓存失效为预期(验收 9)
- [ ] ACP 会话:extension + customTools 注入生效 + 底座自动压缩 per-session 关闭(Settings.isolated);mock model 端到端一轮压缩闭环可 demo;降级路径恢复底座压缩

---

## T4: ephemeral 状态提示 + 档位判定 + 当轮清单

**What to build**:ACP 的「仪表盘」——块大小计数(settled 且 stale prune 运行后计算;**memo 用 host 自建 fingerprint → tokens 的 Map**(底座 WeakMap 以对象引用为键,context 事件每轮 deep copy 新引用会恒 miss——spec §8),流式中的块不进候选;unknown encoding 兜底 byte 估算)、三档判定(边界一律严格大于,二维决策表唯一,§5.1)、当轮清单(候选 = 活跃区 − 尾部保护区,按块大小降序,渲染超 8K token 截尾部小块豁免)、`[acp-status]` ephemeral 注入(transformContext 输出末尾追加 user 消息,不落历史;档位不变时文案逐字节稳定)、轮次归属(档位轮末判定,通牒随下一次请求注入)。

**Blocked by**: T3
**Status**: done(2026-10-13,worktree commit c1ebc8e;7 层断言冒烟(含 1600-2400 合成块 5 轮收敛)+ T1-T3 回归 + check 绿;实现解释已审:「档位轮末判定」实现为下次请求时从 settled 视图重推导(请求视图=轮末状态,turn_end 快照反而会把间隙 settle 的 tool result 延迟一轮),T7 通牒归属按请求注入锚定;memo key 含 length 项捕获 prune 重写;rebindModel 接 model_changed 已修 T3 遗留)

- [ ] 二维决策表唯一实现;恰好 = L3 → L2 档文案 + 普通压缩;ephemeral 同时输出当前档位与本次允许的压缩方式(验收 19)
- [ ] 清单按块大小降序、超 8K 截尾部豁免;豁免块下轮重新进清单,多轮收敛(验收 15)
- [ ] 清单注入后新到块不进当轮清单、不被压(验收 12)
- [ ] 档位判定用 prune 后值;prune 不破坏配对不变量(验收 18)
- [ ] session JSONL 无 [acp-status] 残留;档位不变两轮的 ephemeral 文案逐字节一致

---

## T5: recall_block 工具

**What to build**:历史取回通道——id 为普通块:从 session JSONL 读原块(tool 对 call+result 一起渲染)经本工具 tool_result 返回,召回产物 = 普通新块、下轮进候选;id 为压缩块:返回完整索引(突破渲染截断的发现机制);id 已被 supersede:重定向到最新强力压缩块索引并注明取代链;id 不存在:tool error 不静默;大结果不做内置截断,统一走底座工具结果截断管道(截断 + 完整版落盘 + read 分段)。

**Blocked by**: T3(与 T4/T6 并行)
**Status**: done(2026-10-13,worktree commit 39c18c9;分层断言 + 七票回归 + check 绿;**截断管道接缝结论**:底座对 tool result 无自动截断,per-tool opt-in 共享 helper(enforceInlineByteCap + allocateOutputArtifact,50KB 头60%尾25%);customTools 走同一 ctx 通道,recall_block 复用底座 helper,spec「统一走底座管道」措辞与 opt-in 事实有出入(建议微调,非设计缺陷);顺手修 T7 残留根因:SessionManager.create(tmp cwd) 在 profile sessions/ 建映射目录 + 退出钩子重建文件,smoke 已 dispose+删真目录+leak guard,44+4 条历史残留清零)

- [ ] 普通块召回:call+result 完整返回,召回块下轮进候选(验收 8)
- [ ] recall 大结果:底座截断管道生效,截断后完整版落盘、read 分段可取全(验收 17 前半)
- [ ] supersede 块重定向最新强力压缩块并注明取代链;不存在 ID 返回 tool error(验收 17 后半)

---

## T6: 二级强力压缩 + 待强力状态

**What to build**:压缩区的自我维护——待强力状态(压缩区 > 窗口×35% 实时判定,无持久标记,ephemeral 统一加注「下次压缩为强力压缩」;活跃区 >L1 时下一次主动 compress 搭便车按强力执行,≤L1 不搭车,无轮次上限);活跃区 >L3 时主动 compress 直接按强力语义;强力执行:新压缩块 supersedes 全部未 supersede 压缩块、compressedIds/index 继承全集并并入本次新压、depth+1、method="strong"、压缩区渲染剩单块;纯重置(空被压集)允许提交;keep 不继承(每轮候选 = 全部活跃块 − 保护区)。

**Blocked by**: T4
**Status**: done(2026-10-13,worktree commit a3d4413;8 节断言冒烟 + T1-T4 回归 + check 绿;三条 spec 文本瑕疵已记录不改行为:①空压缩区首次强力 depth=max(被取代depth,0)+1=1;②§5.2 行6 ≤L1+待强力时统一加注文案与不搭车规则字面矛盾(行为按规则);③tier=none+pending 时清单仍出现(结构统一);mergedOldSummaryTokens 取压缩块渲染全文 token(§8 字面);recall(M) 以 index 数据层断言,工具行为留 T5)

- [ ] S1{a} + S2{b} → M 新压 c:M.compressedIds/index 含 a,b,c;重建后 a,b,c 已压缩、压缩区单块、depth+1;recall(M) 完整索引;多层强力同样成立;纯重置可提交(验收 6)
- [ ] 活跃区 >L1 搭便车、≤L1 不搭车;>L3 直接强力;ephemeral 加注正确
- [ ] keep 不继承:上轮 keep 块本轮未列即被压(验收 11)

---

## T7: 三级强制 + 总量保险线 + 降级

**What to build**:失败出口全集——通牒轮次归属(送达后的下一个 assistant turn 结束才判未响应;空闲等待不主动唤醒)、三级强制(`setForcedToolChoice("compress_context")`,meta.forced=true,按强力语义;API 不支持该模型时抛错即降级出口)、总量保险线(判定量 = 投影后总量,> 窗口 − 15% reserve 即触发强制)、降级(强制 turn 结束仍无成功压缩含校验屡败/输出不合法,或 API 错误 → 本会话 ACP 永久退出:工具停注、提示停发、投影关闭、**恢复 compaction.enabled**、OMP methodOrder 接管;边界前 acpSummary 随底座边界隐藏,底座摘要基于原文全文)。

**Blocked by**: T6
**Status**: done(2026-10-13,worktree commit 9f12331;A-G 七节冒烟×3 + 六票回归 + check 绿;**形态②接缝查证结论**:与①同通道——底座 openai-completions transport 在 compat supportsNamedToolChoice=false 时自动收窄工具集为 forced tool 并降 required,一次 setForcedToolChoice 覆盖①②,③=抛错即降级;形态选择是 compat 驱动而非 outcome 驱动(声明支持但实际无视的面经强制 turn 终态降级,安全);其他口径:判定事件=turn_end only(API 错误 settle 为 error-assistant+turn_end,无定时器)、保险线判定量=projectedTokens(tools/system 开销由 15% reserve 吸收)、customTools 创建后不可摘→降级=工具入口拒绝;§5.2 决策表+§11 参数抽出 host/acp-plan.ts;遗留:T7 冒烟在 profile sessions/ 留 44 条映射目录残留(自删断言漏查 SDK 影子目录),随 T5 修)

- [ ] 通牒送达轮不算;送达后下一轮有成功压缩(被压 ≥minCompress)免强制;无 → tool_choice 强制;强制 turn 无成功压缩或 API 失败 → 降级;空闲不主动唤醒(验收 5)
- [ ] 投影总量 > 保险线:三级强制;强制后仍超或失败 → 降级,OMP 默认链路接管(验收 7)
- [ ] 降级后工具停注/提示停发/投影关闭;重建(含底座 compaction 记录)不再推进 ACP 状态
- [ ] 降级路径下底座摘要输入基于边界前原始消息全文(存储未改写,原文均在)

---

## P4: 探针 — ephemeral 注入对前缀缓存的影响实测

**What to build**:T4 落地后,真 API 对照——同一会话序列分别以「注入 [acp-status]」与「不注入」发送,对比 cacheRead 命中率(Kimi 与 Anthropic 前缀缓存面各一组;档位稳定期多轮连续注入的局部缓存复用是重点观察项)。

**Blocked by**: T4(与 T6/T7 并行)
**Status**: 依赖已满足(T4 done 2026-10-13);真 API 花钱(Kimi/Anthropic 各一组对照),等用户在场决策后跑;注意 T7 发现:底座 date/cwd reminder 骑在首个 user turn 上,wire 级字节对比须计入该前缀

- [ ] 两家 provider 各一组对照数据,报告 cacheRead 命中率差异
- [ ] 若稳定期命中率显著劣化,结论回写 spec §7 缓存安全段并上报用户定夺文案策略

---

## P3: 探针 — 尾部保护区 A/B + 参数回填

**What to build**:全链路可用后的观测票——保护区 0 vs 默认(max(最近 2 turn, 最近 20K token))两配置下跑真实长会话任务,观察断片率(模型丢失近期上下文的频次)与压缩意愿,结论回填 spec §11 参数表,关闭 OQ1。

**Blocked by**: T7(队尾观测)
**Status**: 依赖已满足(T7 done 2026-10-13,全链路可用含 recall);真 API 长会话花钱,等用户在场决策后跑

- [ ] 两配置对照数据(断片率 + 压缩行为)落回报
- [ ] spec §11 保护区参数回填,OQ1 关闭

---

## T8: v10 pull 模式落地(acp_status + 短号 + 精简 ephemeral + status 剔除)

**What to build**:Decider 拍板 v10 设计变更落地——清单从 ephemeral 注入移入新工具 acp_status 返回(pull 替代 push);短号 bN 替代 UUID 面向模型渲染;ephemeral 降为一行精简状态行/无档零注入;acp_status tool 对不进候选且在下次成功压缩后整对摘除。spec §3/§5/§6/§7/§11 v10。

**Blocked by**: T5(全链路)
**Status**: done(2026-10-13,worktree commits 8a819e8 docs + 025a15a 实施;新冒烟 smoke-acp-pull + 七旧冒烟适配回归 + check 全绿;三个实现判断已记:①工具返回前缀 [acp-report](区别 ephemeral 的 [acp-status],避免 JSONL 残留断言冲突,spec 可钉死命名);②非 bN 原始 id 穿透宽松读取(模型视角全 bN,无实害;收紧一行);③请求起点自动重生成保留——三级强制路径无模型 status 调用需要清单供给,两快照同源候选一致)

---

## T9: v10.1 通牒伴随合成 status 对

**What to build**:凡注入通牒文案的请求(L3 档或强制已武装/保险线直接触发),在活跃区末尾、通牒行前注入一对合成 acp_status tool 对(新造 assistant 承接,禁向既有 assistant 插 tool_use),使三级强制也是有依据的挑选。spec §5.2/§6 v10.1。

**Blocked by**: T8
**Status**: done(2026-10-13,worktree commits 741a4d5 docs + 7e2a8c4 实施;新冒烟 smoke-acp-synth 7 段 + 九冒烟回归 + check 绿;两个实现判断:①合成对复用完整 renderStatusText——「Call acp_status now」措辞在 forced 请求出现与既有 ephemeral 同病,无新增矛盾,措辞统一留未来 spec pass;②注入条件三子句显式(tier=L3 / 武装目标 / 保险线),保险线子句默认参数下被 L3 覆盖但按 §5.2 保留;注意:acp-runtime.ts 已到 800 行架构门禁,下次改动必须拆分;合成对 assistant 身份元数据固定(acp-synthetic-status),官方面形态确认留探针)

---

## T10: 原型清理 + forced 文案修复

**What to build**:①删除老 ACP 原型三文件(acp-state/acp-context/acp-tools)+ 旧探针(probe-acp-live/probe-acp-tools),复用符号迁移(messageFingerprint → 新 host/acp-fingerprint.ts——放 acp-refs 会造成 refs↔projection 循环依赖;REF_TAG_RE → translate.ts 内联,旧 journal 兼容语义保留);②forced 请求文案修复:L3 指令与 STATUS_POINTER 在 forced 时改为「按上方清单立即 compress_context」,不再指向 acp_status;非 forced 措辞字节不变。

**Blocked by**: T9
**Status**: done(2026-10-13,worktree commits 2870efb 清理 + e48188b 文案;九冒烟回归 + check 绿(边表 307 边更新);grep 零残留引用;主仓误触 translate.ts 已即时 revert 并复核 git diff 为空——主仓 M 文件均为用户会话前在途改动;遗留:acp-runtime.ts 仍卡 800 行门禁,下次加代码必须拆分;probe-acp-tools.ts 超票面删除但可从 git 历史恢复)

---

## T11: acp-runtime.ts 拆分(纯重构)

**What to build**:Decider 拍板三刀拆分:①#validateAndExecute 判定纯化入 host/acp-compress.ts(planCompression + Outcome/Rejection 类型);②recall 分派归位 recall-tool(按逃生条款实际留类内——13 行 state 耦合入口,纯部分 v10 起已在外);③工厂/工具定义/extension 迁 host/acp-assembly.ts,session-lifecycle 改 import。

**Blocked by**: T10
**Status**: done(2026-10-13,worktree commit cd63380;acp-runtime 800→579、acp-compress 288、acp-assembly 84;**九冒烟断言零改动全绿**(git diff 证明)、check 绿;已知取舍:①runtime↔assembly 有意保留 re-export 循环(冻结冒烟 import;将来允许改冒烟时删 re-export);②snapshot 的 syncRefs 提前到 degraded/no-manifest 检查前(幂等重放,无观察差异,六条校验序内部顺序逐字不变);③579 而非 500——状态机内聚,再切就是把私有成员跨模块摊开换行数)
