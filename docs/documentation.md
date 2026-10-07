# 文档规范

> 本文件约束本仓所有 Markdown 文档的写作、生命周期与相互关系。
> 触发时机:写/改任何 .md 文档前;commit 含文档变更时。

## 1. 适用范围与读者

- **约束对象**:docs/ 与 .agents/ 全部文档 + 根 AGENTS.md。代码注释不受本规范约束
- **读者**:docs/ 面向人(agent 同样能读),.agents/ 面向 agent(人同样要能读)。"给 agent 读"的正确含义是**结构化、可 grep、少叙事**,不是禁止人类阅读
- 分档要求:契约类文档(ADR / Spec / 本规范 / rules)以可扫描要点为准;handoff / 调研允许过程叙事

## 2. 文档类型与权威边界

docs/ 住面向人的文档,.agents/ 住 agent 工作文档(决策记录 / 硬约束 / 事故账本 / agent 工作流约定),两类合计如下 + 入口文档:

| 类型 | 位置 | 定位 | 权威边界 |
|---|---|---|---|
| 入口规范 | 根 AGENTS.md | 定位/命令/约束速查 | 只放指针与全站硬约束,事实定义在 docs/ 与 .agents/(内容约束见 §5) |
| 防回归规则 | .agents/rules.md | "被破坏过/绕过代价极大"的硬约束全集 | 单条规则的 SSOT;使用指南见 §8 |
| 事故账本 | .agents/BUGS.md | BUG-NNN 总览表 + 四段式详情 | 本仓库 bug 教训 SSOT;外部依赖坑归 PITFALLS.md |
| ADR | .agents/notes/00NN-*.md | 决策 Why + Alternatives | 架构决策 SSOT |
| Spec(阶段产物) | docs/architecture/<feature>-spec.md | 实施合同:字段/API 契约 + 验收矩阵 | 实施与验收期的验收 SSOT;收敛进 ADR 后删除(§3) |
| 外部依赖踩坑 | docs/PITFALLS.md | omp SDK / Tauri / macOS 等外部依赖行为与验证方法论 | 外部系统"实际如何工作"的 SSOT |
| 调研 | docs/(如 openbitfun-borrow-*.md) | 时点快照,决策输入 | 不承诺随代码更新;被 ADR 消化后价值递减 |
| 会话交接 | docs/handoff-*.md | 跨 session 交接快照 | 时点产物,交接完成后价值递减 |
| agent 工作流 | .agents/(issue-tracker / triage-labels / domain) | agent 在本仓的工作约定 | — |
| 子系统手册 | docs/systems/<name>.md | 活文档:一个子系统的跨文件链路地图 + 排障 runbook | 该子系统行为链路与排障步骤的 SSOT;上游坑归 PITFALLS,事故归 BUGS |

目录规则:不新建 docs/<random>/ 或 .agents/<random>/ 目录;要落盘新类型,先在本表登记再写文件。

**决策树**(这次改动该写什么文档):

```
这次改动是?
│
├─ 架构决策(新增/修改接口、模块、协议、跨区约定、依赖方向)
│  └─ 写 ADR: .agents/notes/00NN-xxx.md(新建即 Proposed,模板见 §3)
│
├─ Bug 修复
│  ├─ 本仓库代码 bug → 追加 BUGS: .agents/BUGS.md(总览表加一行,编号顺延 BUG-NNN;详情四段式:现象/根因/修复/教训)
│  │  └─ 如果该 bug 暴露了"不该再被破坏"的规则 → 同时加 RULE
│  └─ 外部依赖行为与预期不符 → 追加 docs/PITFALLS.md 对应章节
│
├─ 实施合同(字段级契约 / RPC 协议 / 验收矩阵)
│  └─ 写 Spec: docs/architecture/<feature>-spec.md(生命周期见 §3)
│
├─ 发现新的显式约束(有真实事故或 Accepted ADR 背书,且绕过代价极大)
│  └─ 加 RULE: .agents/rules.md(判据见 §8)
│
├─ 外部调研 / 同类项目对照
│  └─ 写 docs/<主题>-*.md(时点快照,注明调研日期)
│
├─ 子系统链路/排障知识聚拢(跨文件链路地图、症状→检查点)
│  └─ 写子系统手册: docs/systems/<name>.md(活文档,随代码同步更新,区别于时点快照;事实以代码为 SSOT,手册只画链路与排障路径)
│
├─ 环境变量/命令/配置变更
│  └─ 更新根 AGENTS.md 速查段
│
└─ 都不适用
   └─ 不写新文档。如需说明,写在 commit message 或 ADR 的 Related 段
```

## 3. 生命周期与状态

三类状态**不得混写**,引用时写明指哪一类:

| 状态类 | 载体 | 词表 |
|---|---|---|
| 决策状态 | ADR 头部 Status | Proposed / Accepted(日期)/ Rejected / Superseded(by ADR-00XX) |
| 审阅结论 | Spec 头部 / 票据 | READY / NOT READY / 待独立复审 |
| 实施进度 | Spec 头部 Status 后缀 / commit | 未实施 / 已实施(日期)/ 验收闭环 |

### ADR 模板与状态流转

```markdown
# ADR-00NN: 标题(动词性,如"采用库内嵌单宿主架构")

**Status**: Proposed(YYYY-MM-DD)
**Decider**:
**Informed by**: (参考的项目/文档/讨论)

## Context(背景)
为什么现在做这个决策?触发因素是什么?
- 业务需求 / 技术约束 / 之前的 bug

## Decision(决策)
我们决定做什么。具体到可执行的层面:
1. ...

## Consequences(后果)
**正面**:
- ...

**负面**:
- ...

**风险/不确定性**:
- ...

## Alternatives Considered(备选方案 — 必填,详细)

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 方案 A | ... | ... | ... |
| 方案 B | ... | ... | ... |

(如有 v1→v2→v3 演进,在此段说明每次修订的原因)

## Related(关联)
- ADR-00XX:(关联决策)
- .agents/notes/00XX 或 docs/xxx.md:(相关文档)
- BUGS.md BUG-XX:(相关 bug)
```

**必填段**:Context / Decision / Consequences / Alternatives Considered。**Alternatives 不得少于 2 个备选方案**,且每个都要写"为什么没选"。

**状态流转**:新建即 `Proposed`;由 Decider 评审后转 `Accepted(日期)` / `Rejected` / `Superseded(by ADR-00XX)`。已 Accepted 的 ADR 被新决策取代时,不删原文,改 Status 为 `Superseded` 并指向后继。

**Accepted ≠ 实施授权**:Accepted 只代表决策成立。实施需对应 Spec 起草并经独立审阅闭环(triage 转 `ready-for-agent`)后才进队列——两者是分离的门禁,不得因 ADR 已 Accepted 而跳过 Spec 审阅。

### Spec 生命周期

Spec(docs/architecture/*-spec.md)是**实施合同**:字段/API 契约 + 验收矩阵。决策 Why 归 ADR,契约归 Spec。Spec 是**阶段产物**,不是长期文档:验收闭环后**收敛进对应 ADR 的「Spec 收敛」节,然后物理删除**。

1. **Draft / Planned → Accepted**:决策经独立审阅接受后,Spec 头部标注 `Accepted(日期)` 并指向决策 SSOT 的 ADR;契约随之冻结,后续改动在头部记修订
2. **Accepted + 实施完成**:实施状态与日期写进头部 Status;实施与验收期间 Spec 与验收矩阵是验收 SSOT,**此时不得删除**
3. **收敛退役**:验收闭环后,把存活价值并入对应 ADR 的「Spec 收敛(日期)」节,同时验收矩阵自动化为测试/冒烟断言、行为契约由代码/类型承接,然后**物理删除 Spec**。收敛未完成不删,禁止"功能一完成就删"
4. **被取代**:新方案整体取代时 Status 改 `Superseded(指向后继 Spec/ADR)`

实施完成后的收尾动作:同步追加 BUGS.md(如有 bug 修复)、rules.md(如有新规则)、PITFALLS.md(如有外部依赖新坑)。**不包含"删 Spec"**。

## 4. SSOT 原则(Single Source of Truth)

每个事实**只能在一处定义**。其他位置只能放指针。

| 事实 | SSOT 位置 | 其他位置只能写 |
|---|---|---|
| 项目架构与三区职责 | 根 AGENTS.md「项目架构」 | 指针 |
| UI 全站约束(控件语言/图标/ring-pop) | 根 AGENTS.md 各规范节 | 指针 |
| ADR 决策 | .agents/notes/00NN | AGENTS.md 只列 ADR 编号 + 一句话 |
| 外部依赖行为(omp SDK / Tauri / macOS) | docs/PITFALLS.md | 指针 |
| 底座 oh-my-pi 源码事实 | /Users/xys/Github/oh-my-pi 源码 | 指针 |

**禁止**:同一事实在多个文档重复定义。数量类事实(RULE 条数、ADR 份数)不得写进入口文档——一律指针化。

## 5. 长度预算

| 文档类型 | 预算 | 超预算怎么办 |
|---|---|---|
| 根 AGENTS.md | 300 行(硬限) | 下沉到 docs/ 或 .agents/ 对应类型,只留指针 |
| ADR | 800 行(硬限,含 Alternatives) | 拆为多个 ADR |
| docs/ 与 .agents/ 下其他文档 | 300 行(默认预算) | 优先拆分或浓缩;确需超限,在文档头注明"超限原因:..." |
| 追加型历史 / 规则全集 / 验收矩阵 / 踩坑记录 | 结构性超限(允许) | 总量随历史增长是预期,不算违规 |

**粒度约束**(不随类型放宽):RULE 单条 Why 段 ≤ 5 行;BUGS 单条 ≤ 60 行(复杂多阶段 bug 例外见 §9)。

**豁免机制**:非结构性超限,在文档头注明"超限原因:…"并指向本节,说明为何拆分会损失可操作性;结构性超限类型(上表第 4 行)可免注明。

### AGENTS.md 内容约束

根 AGENTS.md 只留:
- 项目一句话定位与底座源码指针
- 关键架构约束(三区职责、依赖方向)
- 文档索引(指向 docs/ 与 .agents/)
- 全站硬约束(用户级安全红线在 ~/.zcode/AGENTS.md,本仓不复制)
- UI 规范节(本仓库特有,已是 SSOT)

**禁止内容**:架构详解、数据流图、版本变更摘要、外部依赖行为清单(归 PITFALLS.md)。

## 6. 更新传播

- **行为变化必须同步文档**:改动产生可观察行为 / 用户可见 / 协议可见的变化时,对应文档须在本次改动内更新(落点按 §2 决策树);纯行为保持的重构通常不动产品文档
- 改动/删除/移动文档后,必须 grep 全仓引用并同步:AGENTS.md 索引、docs 内互链。删除文档前确认无活引用,或同步把引用改指承接位置
- 入口文档(AGENTS.md)禁止复制**易变事实**:数量(RULE 条数、ADR 份数)、状态(Proposed/Accepted)——一律指针化,让 SSOT 文档自己说话
- 调整 RULE 体系 → 同步 rules.md 头部说明
- **禁止矛盾指令**:发现文档与实现、或文档之间给出矛盾指令时,先实测验证哪边是事实,再在本次改动内修正过时一侧;禁止仓库内并存互相矛盾的定义或指令

## 7. 验证(文档变更自检)

每次文档变更 commit 前自查:

1. **链接一致性**:对新增/移动/删除的文档全仓 grep 文件名,零死链(豁免:handoff/调研等时点快照、代码注释)
2. **状态不混写**:对照 §3 状态三分离表
3. `git diff --check` 干净

**placeholder 政策**:

- Accepted / 已生效文档:禁无主 placeholder(`TODO`、`待补充`)——要么写完整,要么删掉该句
- Proposed / Planned / Draft 文档:允许 `Open Questions`,但每条必须写明当前状态、决策人(Decider)与进入下一步的门禁;这是诚实暴露开放问题,不是留欠账

## 8. RULE 使用指南

### 何时读 RULEs

先读 [rules.md](../.agents/rules.md) 的「规则总览」表,再按本次改动的**影响范围**加载对应 RULE——不维护模块清单(清单必然漂移,总览表才是 SSOT)。

绕过任何 RULE 前,**停下,先在 commit/PR 描述里写出理由**。大多数情况下绕过是错的。

### 何时新增 RULE

**必要条件**(同时满足):

1. **背书真实**:引用 BUGS.md 真实条目(BUG-NNN)或 Accepted ADR
2. **可执行**:能写出具体检查(grep 什么关键字、测试/冒烟如何覆盖)

同一问题反复出现(≥2 次事故、review 在多个改动里重复纠正同一件事)是**加强信号,不是必要条件**——单次代价极大的事故同样够格;反之,没有真实背书的"预防性 RULE"不立。

**不应新增**:

- 通用语言/框架规范(交给 linter)
- ADR 已完整说明的决策(只在 ADR 不够"显眼"时加 RULE 指针)
- 一次性 bug 无通用教训(写进 BUGS.md 就够)
- 实现细节(放代码注释,不是 RULE)

### RULE 格式模板

```markdown
### RULE-N: [一句话规则]

**规则**:[具体的、可验证的规则描述,不要模糊]

**Why**:[为什么这条规则存在。来自 bug 引用 BUG-XXX,来自 ADR 引用 ADR-XXXX。≤ 5 行]

**How to apply**:[具体执行方式。改动 X 时检查什么、测试/冒烟如何覆盖、grep 什么关键字验证]

**关联**:[BUG-XXX / ADR-XXXX / 相关 RULE-XXX]
```

## 9. 例外

- 长度类例外统一走 §5 预算制与头部豁免,不逐类枚举(枚举随文档类型扩张失效)
- BUGS.md 单条可超 60 行,限复杂多阶段 bug
- 调研/交接快照中的陈旧引用属历史档案,不强制刷新(§7 豁免清单)
