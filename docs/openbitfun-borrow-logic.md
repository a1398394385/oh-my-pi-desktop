# OpenBitFun 逻辑侧借鉴报告（面向 host / SDK 层）

> 依据：2026-09-20 对 `/Users/xys/Github/openbitfun`（提交 59c87025a 附近）源码与文档的实读核查。
> 所有 OBF 引用路径均相对该仓库根。我方现状指本仓库（oh-my-pi-desktop）host/ 层。
> 结论先行：**L1 能力注册表、L5 分层门禁、L6 性能审计方法论三项成本最低、与我们架构同构度最高；L2 会话投影是 host 状态同步重构的设计蓝本；L3/L4 受 SDK 控制权限制，只能做观测与外围强制。**

---

## 0. 前提：控制权边界决定借鉴方式

OBF 是自研 Rust Runtime（43 crate、664 个注册 Tauri 命令），prompt 组装、事件 journal、工具执行全在自己手里。我们是库内嵌架构：`host/host.ts`（56.7KB，拆分中）持有 `Map<sessionId, PoolEntry>`，通过 `@oh-my-pi/pi-coding-agent` SDK 驱动会话，WebSocket RPC 对接 UI。

| 机制 | OBF 控制点 | 我们的对应物 | 控制权 |
|---|---|---|---|
| 能力目录 / 控制平面 | Rust 注册表 + 生成器 + CI | host RPC handler + ui 设置页 | ✅ 完全（协议是我们定的） |
| 会话投影 / 事件顺序 | Runtime journal + 前端 SessionStream | SDK 事件 → host → WS → ui/chat.js | ⚠️ 半（SDK 事件顺序归底座，host↔ui 段归我们） |
| Prompt cache | agent-runtime 内部 | SDK 内部 | ❌ 基本没有（只能观测 + 不添乱） |
| 评审预算强制 | Task 工具 spawn 路径 | SDK 内 subagent 运行时 | ❌ 直接管不到（可管 RPC 层与我们注入的自定义工具） |
| 分层边界门禁 | cargo + 自写 checker | host/ 与 ui/ 的模块边界 | ✅ 完全 |

所以总策略：**协议与门禁照抄，Runtime 内部机制只抄思想。**

---

## L1. 能力注册表：给 WebSocket RPC 加一层「产品控制平面」（最高优先）

### 1.1 OBF 的机制（已核实到行号）

**核心不变量**（`docs/architecture/product-control-plane.md:9-11`）：一项用户可见功能只有一个业务 owner；GUI 和 Agent 进同一个 Command，禁止各自实现校验/副作用。

**单一事实源 = 三源合并**（`scripts/generate-interactive-capabilities.mjs`）：

1. 手工 overlay `src/shared/interactive-capabilities/catalog.json` —— 只写「解释性」字段（双语标题/摘要/关键词/步骤/agent 示例）。一条能力记录结构：

```json
{
  "id": "setting.application.pet",
  "kind": "setting",
  "categoryId": "application",
  "titleZh": "...", "titleEn": "...",
  "keywordsZh": [...], "keywordsEn": [...],
  "items": [{
    "id": "preset-selection",
    "control": { "kind": "direct", "operations": ["list-pets", "use-pet"] },
    "evidence": ["command:list_agent_companion_pets", "source:src/...#锚点"]
  }],
  "destination": { "kind": "settings", "pageId": "application.pet" }
}
```

2. 编译期 Rust 注册表 `product_control_owner_registry.rs` —— 只写「可执行事实」：schema、handler、risk、argument scope。注释原话："Config paths, command handlers, value schemas, risk... are executable product facts and therefore live in compiled Rust"。
3. 真实值源 —— 主题枚举来自 `startup_appearance_bootstrap.json`，语言枚举来自 `locales.json`，杜绝目录与实现漂移。

**Join 规则是防腐化的关键**（generate 脚本 `resolveOwnerFacts`）：overlay 里每个 option/operation 必须在编译期注册表有 owner，否则 throw；overlay 手写了 `handler/valueSchema/risk` 任一字段直接 throw（"executable owner data may not be handwritten"）；owner 有而 overlay 缺的也 throw。Rust 侧还有反向契约测试。

**产出五类投影共享同一 graph hash**（sha256 over 合并图）：公开目录 JSON、前端搜索目录、Rust include_str! 目录、TS 类型绑定、审计表。`--check` 模式下任一文件漂移 → exit 1（CI 步骤 "Validate interactive capability contract"）。

**两步发现流 wire**（`openbitfun_control_tool.rs`）：单工具六动作 `list/search/get/open/execute/configure`。

- list/search 返回 ≤50 条/页的紧凑卡（id/kind/双语标题/operationCount/controlCoverage/最多 5 条 matchedItems/**nextToolCall**——可直接复制的下一条调用）。文本打分：精确 100 / 前缀 94 / 词前缀 88 / 包含 80。
- get 返回完整契约（schema + availability + 当前值），并附 `validItemIds/validOperationIds/validOptionIds` 与 `idNamespaceRules`（明示哪些 ID 只是展示元数据不可调用）。
- execute 前校验链：operation 存在（错误信息列出全部合法 ID）→ 自实现 JSON Schema 子集校验 → 远程参数 scope 校验。
- 权限分级：list/search/get 与 risk=Read 的 execute 免权限；写操作发 `PermissionIntent{resources:["{action}:{capability}:{member}"]}`。
- 完整目录永不进 system prompt；工具描述 <600 字符且有测试断言不含目录内容。

**四类控制分类**：`direct`（可直接调用）/ `delegate`（交给工具链）/ `open`（必须带枚举原因码：ExternalAuth/SecretEntry/VisualSelection/UnstructuredInteraction）/ `unsupported`。「打开页面」不计为已控制。

### 1.2 对我们的落地（最小版 → 完整版）

**现状痛点**：host RPC handler 散落在 host.ts（+ 拆分出的各领域模块）里，UI 设置项散在各 pg-* 页；两边靠人肉对齐，AGENTS.md 规范没有机器执行。

**第一步（约 1-2 天）——静态清单**：
- `host/capabilities.json`：手工维护，一条记录 `{id, kind, risk, handler, presentation}`。handler 指向 WS RPC method 名，presentation 指向 ui 设置页 id。
- 写一个 `scripts/check-capabilities.mjs`：扫描 host.ts 里实际注册的 RPC method 名集合，与清单 diff，孤儿双向报错（handler 没登记 / 清单指向不存在的 handler）。这一步就拿到了 OBF 「无证据子能力阻断生成」的门禁效果。

**第二步（约 1 周）——运行时发现**：
- host 加两个只读 RPC：`capability.list/search`（分页 + nextCursor）与 `capability.get`（精确 schema/枚举值）。
- ui 的设置搜索（若做）与未来的 Agent 侧命令发现共用这两个入口，而不是各自 hardcode。

**第三步（价值确认后再做）——值源与漂移门禁**：设置项的枚举值（模型列表、profile 列表）从真实值源（models.ts / profile.ts 导出）生成进清单，CI 校验。

**不抄的部分**：Tauri command 注册表那套 Rust 反向契约测试——我们是单一 TS 宿主，脚本 diff 足够。

---

## L2. 会话投影契约：host ↔ ui 状态同步的重构蓝本

### 2.1 OBF 的机制

契约三条（`docs/architecture/session-projection.md`）：

1. **每个写入带位置，投影永不回退**。位置落后（not-ahead）的写入「丢弃而非合并」。Runtime 位置 = `(streamId, cursor)`（streamId 随 Host 进程重启而变，旧进程 cursor 永远不会被误认）；History 位置 = turn ordinal。两套坐标互不比较，比较结果 `unrelated` 时整体重置所有权。
2. **一个 Turn 只有一个 writer**。执行中归 runtime 流（持久化 checkpoint 也不得写）；落盘后归持久记录；所有权在「持久化成功后发出的 SessionHistoryChanged 事件」这道 durable fence 处一次性转移（coordinator.rs:3066-3081，注释明确 terminal chunk 是低延迟投影、fence 才是真相）。
3. **(surface, session) 是一等身份**。一个 SessionStream 对象独占 position/pending queue/projection；per-session 状态只能经流访问，「没有别的地方可放」。

**实现细节值得抄的三处**：

- **held queue**（SessionStream.ts）：读进行中（load/backfill）时到达的 live 事件入 `held` 队列返回 'hold'；读 settle 后按序释放，释放走与 live 完全相同的 admit 规则——**读与流永不交错乱序**。`beginRead` 生成代次号，新读取代旧读并继承其 held。
- **双视图投影**（session_event_journal.rs）：压缩视图 events（「这个 Turn 现在长什么样」）+ append-only tail（有上限，回答「cursor N 之后我错过了什么」）；尾部可证连续则返回 Delta，否则 `SnapshotRequired`——"never a guess"。
- **诚实的缺口管理**：文档自认两个契约未闭合的缺口（无 runtime 流的旧 Host、部分 history 读），因此 `snapshotDropsProjectedTurnContent` 这类内容比较启发式仍存活在 `persistedReadMayReplaceTurn` 里，并写明"删掉守卫前先闭合缺口，否则是真实缺陷回归"。

### 2.2 对我们的落地

我们的乱序风险来源：SDK 事件流（agent 运行中）、会话加载（getEntries 重建）、分支切换、（未来）多窗口。目前 host→ui 是「事件即发、ui 全信」，没有位置概念。

**建议的渐进路线**（配合 host.ts 拆分中的 state.ts）：

1. **先立坐标**：host 给每条发往 ui 的会话事件盖 `(hostInstanceId, seq)`。hostInstanceId 在 host 进程启动时生成——进程重启后旧 seq 全部 `unrelated`，ui 整体重置而非错位拼接。这一条成本极低（一个计数器 + 一个 uuid），直接消灭「重连后消息重复/错序」整类 bug。
2. **加载与流不交错**：ui 发起 load 会话时，host 把 load 结果与后续事件排在同一序列（或 ui 侧实现 held queue）。OBF 的 'hold' 而非 'reject' 语义直接照抄。
3. **turn_end 当 fence**：SDK 的 agent_end/turn_end 落盘事件对应「这个 Turn 归档」，此后历史重建（分支切换回来）才允许整体替换该 Turn 的 DOM——这与我们 v11 已做的「turn_end 自动收起 loop 组 + 历史同构重建」天然契合，只需把「替换合法性」判定从「元素在不在屏幕上」换成「fence 是否已过」。
4. **不做**双视图 tail/backfill——单机 WebSocket 无需重连补洞，等真出现多窗口再说。

---

## L3. Prompt cache：只做观测与「不添乱」约束

### 3.1 OBF 的机制（供理解，非直接可抄）

- cache identity 就是字符串 scope key：内置 agent `template:{模板名}`、自定义 agent `custom_prompt_sha256:{全文哈希}`、user context = section 集合 join（`workspace_context|memory_summary|...`）。
- 分层缓存：SystemPromptCacheIdentity 与 UserContextCacheIdentity 独立存取，persistence TTL 默认 24h。
- branch 复制清单（session_branch.rs）：截至边界 turn 的 dialog_turns、per-turn context 快照、skill/agent 快照、**源 prompt cache 原样写入**、compression 状态、evidence ledger。
- 模式设计：plan/multitask 是 Skill 而非独立 Agent 模式——切模式不改 prompt 根 identity；前端只在 scope key 变化时弹缓存警告（ChatInput.tsx 比较上次提交的 scopeKey）。
- 观测：`cached_tokens / cache_hit_rate` 进 usage 报告卡，coverage 未上报时显示「未上报」而非编造。

### 3.2 对我们的落地

诚实边界：prompt 组装在 SDK 内部，我们改不了分层与 branch 复制。**能做的是两件事**：

1. **观测**：SDK 的 usage 里若含 cached token 字段，host 透传，ui 的 usage/ctxRing 明细卡加一行 cache read/write（OBF 的展示措辞可抄：未上报就明示未上报）。先确认底座是否上报（查 pi-coding-agent 的 usage 类型）。
2. **不添乱约束写进设计准则**：若未来加「会话模式」（plan/chat/agent 切换），必须做成 system prompt 的增量段而非换根；切换 UI 控件不触发重新组 prompt 的路径。这条写进本仓库 AGENTS.md 或设计文档即可，零代码。

---

## L4. Subagent 预算门禁：思想可抄，落点在 RPC 层与自定义工具

### 4.1 OBF 的机制

- 全局 `DeepReviewBudgetTracker`（LazyLock 单例）按「父 dialog turn」记账：judge_calls / reviewer_calls / retries / active_reviewers / diff 字符数（每 turn 240K 上限）/ diff 获取次数（≤128/turn）。
- 扣减点在 Task 工具 spawn 路径（execution.rs:714-743）：启动前 `record_...`，Err 直接变工具错误，错误码区分 `deep_review_spawned_budget_exhausted` 等。
- 关键设计语句（deep-review.md:131）："The runtime enforces the shared allowance even if a weak model ignores the prompt. This is a resource ceiling, not a keyword or risk-score workflow rule." —— **预算是资源上限，不依赖模型听话**。
- strict 模式 Reviewer+Judge 共享 3 次调用额度；大规模评审走确定性 packet：按 workspace-area 分桶、桶内按 40 文件切块、轮转凑 8 批、并发 ≤2；reviewer 只读（无 edit/git 写工具），修复者是独立 ReviewFixer 身份且需用户批准。
- 证据状态（complete/limited/stale/failed）与模型风险评级分开存储，UI 分别展示——「可信度受限不改写结论」。

### 4.2 对我们的落地

subagent 的 spawn 在 SDK/底座侧，我们插不进扣减点。**外围可做的**：

1. host 注入的自定义工具（createAgentSession 的 customTools 选项）如果包含长跑/批量类工具（批量读文件、批量 diff），在 host 侧实现同款记账：`Map<sessionId, {calls, chars}>` + 每 turn 上限 + 超额返回带错误码的 tool error。这是我们能完全控制的一层。
2. RPC 层防御：对高成本 RPC（get_file_diff 全仓、list_dir 深层）加 per-session 限额——同「资源上限而非关键词规则」原则。
3. 设计语言可先抄进我们的多 agent 协作约定：reviewer/scout 只读、worker 才有写权、审批后才跑修复——这与本会话环境的 subagent 分工已一致，缺的是把「证据可信度分级」（complete/limited/stale）引入 reviewer 产出的报告格式。

---

## L5. 分层边界与门禁脚本：host.ts 拆分的「防退化」配套

### 5.1 OBF 的机制

六层 `src/crates/`：contracts（纯类型，禁 runtime/fs/network/UI 依赖）→ execution（agent-runtime/tool-execution）→ services → interfaces（app-server/acp/sdk-host）→ assembly → adapters（pi/codex/claude-code/opencode）。每层一个 AGENTS.md，两节固定结构：Placement Rules（什么放这层）+ Dependency Boundaries（不许依赖谁）。

`scripts/check-core-boundaries.mjs`（+ 171KB 自测）五类规则：crate 目录↔层映射、Cargo 依赖边界（含 noCoreDependencyCrates 白名单——**禁止依赖 core 的 crate 清单**）、feature 组合、源码内容规则（如 Rust 源码全文不得出现 `web-ui` 字样）、测试拓扑。另有 TUI legacy 棘轮（只减不增）。

代表规则两句：
- contracts/AGENTS.md："单 runtime/product crate 用的类型留在该 crate，直到第二个 owner 出现。"
- adapters/AGENTS.md："不要为单个宿主或未来协议预建共享 API crate。"

### 5.2 对我们的落地

host.ts 拆分已在进行（assets/bootstrap/models/profile/state/stats/translate）。**建议补的不是更多层，而是一个 50 行的边界检查脚本**（进 `.local/` 或 scripts/）：

1. **依赖方向表**：`state.ts/profile.ts/models.ts 不得 import host.ts`（只能反向）；`ui/core.js 是唯一直连 WS 的模块`之类，按实际拆分结果定 3-5 条。
2. **孤儿检测**：拆完后 grep 已搬走符号在旧文件的残留 import。
3. 跑法：pre-commit 或手动 `node scripts/check-host-boundaries.mjs`，exit 1 列违规。

OBF 的教训值（对我们最有用的一句）：他们证明「SDK/外部运行时适配层值得单独成层」——我们对应的是 host 里直接调 `@oh-my-pi/pi-coding-agent` 的胶水代码，拆分时应聚到一个 `sdk-adapter` 性质的模块，其余模块只依赖我们自己定义的接口类型（contracts 思想），这样底座升级时改动面收敛。

---

## L6. 性能审计方法论：PITFALLS.md 的升级三件套

### 6.1 OBF 的机制（docs/performance/02/03 为范本）

- **固定基线**：报告顶部声明锚定提交号（"所有行号以 main@48a003b73 为准"），之后作为历史证据归档；功能退役时用退役说明关闭相关条目，禁止据此恢复已删功能。
- **方法论声明**：先 Grep 系统性扫描反模式（clone 密集区、async 中同步 IO、非静态 Regex、block_on、未节流监听、高频 IPC），对每个可疑点**精读上下文并论证调用频率后才收录**。
- **误报排除记录表**（19 行，两列：候选 | 排除依据）：「明显但确认无害」的候选连依据留档，避免下一轮重复审查；排除过程中顺带发现的正确性缺陷单独标出跟进。
- **发现总览表按预期收益排序**：列 = `# | 层 | 问题 | 位置(文件:行) | 预期收益 | 修复风险`，30 项分高/中高/中/低。
- **任务清单 T1-T19**：具体到函数/字段级改法 + 涉及文件:行 + 风险 + 建议顺序（低风险高收益先行）。
- **「已做对、勿回退」清单**（03:17-27，10 项）：既有优化 + 位置两列，防后人重构时好心拆掉（详见 UI 报告 U5）。

### 6.2 对我们的落地（零代码，纯文档纪律）

给 docs/PITFALLS.md 补三节，或新开 `docs/perf/` 系列：

1. 每次性能专题排查注明基线提交号；
2. 加「误报排除记录」节（已存在的「四征」类判断正适合这种留档：如「心跳停+无错+CPU 0% = 隐藏窗口节流，非挂死——已排除，勿再查」）；
3. 维护一份 ui/host 的「已做对勿回退」清单（我们已有素材：探针法 DOM 断言、placeMenu 的 zoomLevel 补偿、turn_end 同构重建等）。

成本：一次整理约半天；收益：每次回归排查少走弯路，且 agent 会话能直接引用。

---

## 优先级与成本总结

| 项 | 价值 | 成本 | 建议时机 |
|---|---|---|---|
| L1 第一步：能力清单 + handler diff 门禁 | 高（消灭协议漂移） | 1-2 天 | host 拆分定型后立刻做 |
| L2 第 1 步：事件盖 (hostInstanceId, seq) | 高（消灭错序类 bug） | 半天 | 可与 L1 并行 |
| L6 性能审计三件套 | 中高 | 半天 | 随时 |
| L5 边界检查脚本 | 中高 | 半天 | host 拆分合并时 |
| L2 第 2-3 步：held queue + turn fence | 高 | 3-5 天 | 会话状态重构窗口 |
| L1 第二步：capability.list/get RPC | 中 | 1 周 | 设置搜索/Agent 命令发现需求出现时 |
| L3 观测（cache 指标透传） | 中 | 半天-1 天 | 先查底座是否上报 |
| L4 自定义工具预算记账 | 中 | 1-2 天 | 批量类自定义工具落地时 |
