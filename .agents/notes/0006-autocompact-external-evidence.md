# AutoCompact 论文结论与 ACP 优化方向(外部证据笔记)

> 来源:arXiv 2610.02163(AutoCompact: Learning When to Compact Context in Long-Horizon Coding Agents,Zhang et al.,2026-10)。本地备份:`~/Github/xhs-harvest/backup/AutoCompact-*.md`。
> 用途:外部实证证据 + ACP 后续优化候选清单。本文不是决策记录(决策走 ADR-0005 演进段);本文是「以后优化 ACP 时回来看」的参考。
> 延伸:[0007](0007-acp-cost-model-and-semantics.md) 承接本论文的成本实验补遗、DeepSeek Flash 三轮成本演算、manifest 语义之辩与 P3 四臂消融设计。

## 论文做了什么

训练 coding agent(Qwen3-Coder-30B)把压缩作为策略的一部分:judge 纠正的在线轨迹收集(何时压/留什么/压后怎么继续)→ SFT → outcome-based RL(GRPO,二元任务成功 reward,压缩与编码联合优化,无压缩特定 shaping)。SWE-bench Verified 30.4% → 39.6%。

## 核心结论(与 ACP 的映射)

| 论文结论 | 数字 | 对 ACP 的含义 |
|---|---|---|
| **主动压缩优于水位触发,即使全历史放得下** | 256K 窗口零强制触发,主动压缩仍 +9.2%;Fixed 长度触发反而 −1.6% | 佐证 v10「压缩时机还给模型」路线;压缩应绑任务进度(阶段完成即压),不绑水位 |
| **主动 + 强制兜底互补** | 16K 受限场景,带 fallback 的主动压缩全预算段赢 Base | 佐证三级架构(主动→通牒→强制→降级 OMP),兜底不吃掉主动层收益 |
| **base model 几乎不主动压缩** | prompt 写明规则仍极少自发调用;训练后使用率也只 58.5% | **警讯**:compress_context 意愿不能赌模型自觉,引导靠工具描述+档位行;P3 压缩意愿是头号观测项 |
| **摘要缺「下一步动作」是最高频失败** | next-action 遗漏 8.2%(SFT)→ 2.2%(RL);key-state 遗漏 3.1% → 0.2% | summary 三段结构(findings / workspace state / remaining actions 含具体下一步)已写入 COMPRESS_CONTEXT_DESCRIPTION(2026-10-13) |
| **summary self-consistency** | 案例:摘要记录未解决错误却提议收尾 → 任务失败;RL 学到状态约束行动 | 工具描述已加自洽约束一行;P3 观测此失败模式 |
| 摘要保留原始任务,压掉探索细节 | — | ACP 对应:任务背景应出现在压缩摘要中(spec §14 已有「长期目标外部文件承载」权衡,互补不冲突) |
| rubric 引导(不训练)也赢 Base | SelfCompact +1.3%(低于训练的 +9.2%) | 协议+提示路线有价值但天花板低于训练;ACP 的档位仪表盘 = 我们的 rubric,frontier 模型效果待 P3 |

## 已落地(2026-10-13)

1. `host/acp-assembly.ts` COMPRESS_CONTEXT_DESCRIPTION:summary 三段结构 + self-consistency 约束 + 阶段完成即压的习惯引导。
2. P3 票面(tickets.md)加「Summary-ignored 消融臂」。

## 优化候选(以后回来看,按优先级)

1. **压缩意愿不足时的干预阶梯**(P3 若证实):档位阈值下调(L1 更早介入)→ L1 文案升格(建议→更强)→ system prompt 层加压缩习惯引导。
2. **P3 消融设计**(已入票):ACP 开 vs 压缩调用被跳过(Summary-ignored 变体),分离压缩收益与协议开销;对照组再加 full-history(无 ACP)则三臂齐。
3. **摘要质量观测**:P3 记录 summary 的三段覆盖与自洽性(论文的 keyword screening + 人工抽查方法可复用)。
4. **eval 升级**(远期):真实任务集上 full-history vs ACP 的 pass-rate 对照(论文的 SWE-bench 协议),替代断片率这类代理指标。

## 与 ACP 的本质差异(不追平的理由)

- AutoCompact 压缩 = 全量重写(单段 working-state summary 替换历史+保留最近几轮),压掉即丢:无索引、无 recall、不管前缀缓存。ACP 的增量双区 + bN 索引 + recall + 缓存友好渲染在信息保真与成本上更精细。
- 训练不可用(我们是 harness 层,接任意 frontier/API 模型);论文恰好证明 rubric 路线(协议+提示)在未训练模型上也有正收益。
