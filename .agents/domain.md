# Domain docs

本仓库使用单一领域上下文,三区(src-tauri / host / ui)共享同一套术语与架构决策。

## 探索代码前必读

- 架构与三区职责:根 AGENTS.md「项目架构」
- 架构规则:`.agents/rules.md`
- 相关 ADR:`.agents/notes/`
- 外部依赖行为(omp SDK / Tauri / macOS):`docs/PITFALLS.md`

不要另建 `CONTEXT.md` 复制现有术语。满足 ADR 条件的架构取舍写入 `.agents/notes/`;术语积累到足以产生歧义时再建 `docs/onboarding/glossary.md`,此前以根 AGENTS.md 为准。

输出中的领域概念必须使用既有正式名称(如「会话池 PoolEntry」「右栏 tab」「ring-pop 弹卡」)。若实现方案与现有 ADR 冲突,必须显式指出,不能静默覆盖。
