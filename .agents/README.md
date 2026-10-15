# .agents/ — Agent 文档区

本目录存放**为 agent 工作服务的文档**:决策记录、防回归规则、bug 账本与 agent 工作流约定。分层理念:`docs/` 住面向人的文档(踩坑速查 / 调研 / 交接 / Spec),本目录住 agent 每次改动前要查的"为什么"与"不许做什么"。

| 文件 / 目录 | 定位 |
|---|---|
| `notes/` | ADR 全集(架构决策 Why + Alternatives;验收闭环特性附「Spec 收敛」节) |
| `rules.md` | RULE 硬约束全集(「被破坏过 / 绕过代价极大」的防回归规则) |
| `BUGS.md` | BUG-NNN 事故账本(总览表 + 四段式详情);外部依赖坑归 docs/PITFALLS.md |
| `issue-tracker.md` / `triage-labels.md` / `domain.md` | agent 在本仓的工作约定(issue tracker / triage 词汇 / domain 文档指针) |

规范约束(预算 / SSOT / 生命周期)见 [documentation.md](../docs/documentation.md);文档类型登记表在其 §2。
