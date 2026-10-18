# 性能优化 · 实施 Spec

> **Status**: Draft(2026-10-18) · 未实施
> **证据来源**: [perf-audit-2026-10-18](../perf-audit-2026-10-18.md)（同日静态审计 + 构建产物实测；其中 §4 已带勘误块，勿引用初版结论）
> **执行工作区**: `git worktree` @ `.local/wt/perf-01`，分支 `omp/desktop/perf-01`，基线 `801fb47`
> **审阅结论**: 待审（本 Spec 未过独立审阅，不得据此直接铺开实施）
> **超限说明**: 无——正文 182 行，在 [../documentation.md](../documentation.md) §5 的 300 行默认预算内。

---

## 1. 目标与非目标

**目标**（按实测证据排序，非按直觉）：

1. 消除「每个 WS 帧换掉整个 `openSessions` 引用」这一渲染放大器。
2. 让 host 的流式帧率与前端 100ms 合并窗口对齐，并加背压。
3. 削减启动包 6.23 MiB 中可按需加载的部分（最大单项：shiki 语法 2.59 MB / 42%）。
4. 把上述收益变成**可回归的数字**，而不是一次性观察。

**非目标**（明确不做）：

- ❌ 不做运行时 profiling 驱动的重构（本次全程无 trace / 无火焰图，批次优先级由静态证据排定）。
- ❌ 不重引入消息流的 `content-visibility`（`ui/css/main/shell.css:33` 记录 BUG-017 教训）；长列表窗口化单列为 Batch 5，独立评估。
- ❌ 不改 host 与前端的 WS 协议字段形状（只改**发送节奏**与背压策略，不改帧结构）——协议变更的成本远高于本轮收益。
- ❌ 不动 `agent/`、LRU 驱逐、事件位置戳（`evtSeq`）的既有语义。

**硬约束**（继承自 AGENTS.md，违反即回滚）：

- Profile 隔离：所有冒烟走 `scripts/smoke-profile.ts` 的 `smokeEnv()`，用 `omp-desktop-test`；**严禁污染 `default`**。
- 中文注释禁令：不新增中文注释；UI 文案走 `ui-src/i18n/`。
- 编码：全部 UTF-8，提交前过 `check:encoding`。

---

## 2. 批次总览与依赖

| 批次 | 主题 | 预期影响 | 风险 | 依赖 | 与在途 git 功能冲突 |
|---|---|---|---|---|---|
| **0** | 测量基线固化 | 无直接收益，**是后续所有批次的验收前提** | 低 | — | 无 |
| **1** | 渲染放大器（store） | 高（交互卡顿主因） | **中**（动核心状态语义） | 0 | **无**（`session.ts` 干净） |
| **2** | 消息列表 memo 化 | 高 | 中 | 1 | 无（`MessagePage.tsx` 干净） |
| **3** | host delta 合并 + 背压 | 中高 | **中高**（帧顺序） | 0 | **有**（`host/session-lifecycle.ts`） |
| **4** | 产物体积 | 中（启动包） | 低（可独立回滚） | 0 | 部分（`ui/icons.js`） |
| **5** | 长列表窗口化 | 未知（未实测） | 高 | 1,2 | 无 |
| **6** | P2 清理 + 顺带修 bug | 低 | 低 | — | 部分（`MsgRail.tsx` / `ws.ts`） |

**冲突面实测**：本 Spec 会动的 17 个文件中 **7 个与主工作区未提交的 git 功能改动重叠**——
`Sidebar.tsx`、`RightPanel.tsx`、`tabs.ts`、`MsgRail.tsx`、`store/ws.ts`、`host/session-lifecycle.ts`、`ui/icons.js`。

**关键结论**：**Batch 0/1/2/4 的核心文件全部干净，可立即开工**；Batch 3、6 需等在途 git 功能落地后再动。

---

## 3. 各批次实施合同

### Batch 0 — 测量基线固化

**为什么先做**：本次审计的体积结论靠临时脚本得出，脚本在 `$env:TEMP` 未入库。不固化则每个批次都无法客观验收，只能靠体感。

**改动**：

| 文件 | 改动 |
|---|---|
| `scripts/perf-budget.ts`（新增） | ①从 `ui/dist/assets/app.js` 沿静态 import 做 BFS，输出**启动闭包**的 chunk 数与字节；②读 `app.js.map` 用 `@jridgewell/trace-mapping` 逐行按列区间归属到源模块，按 `node_modules` 包 / 本仓目录聚类；③对比 `ui/dist/assets/perf-baseline.json` 输出回归表 |
| `package.json` | 加 `"perf:budget": "bun scripts/perf-budget.ts"` |
| `docs/architecture/perf-budget-baseline.json`（新增） | 首次运行生成的基线数字，入库做对比锚点 |

**验收**：

- `bun run ui:build && bun run perf:budget` 输出启动闭包 = **17 chunk / 6.23 MiB**，归因总和与闭包差 < 1%。
- 基线 JSON 入库，二次运行 diff 为空。
- 脚本**不得**修改 `ui/dist` 以外任何路径；纯读。

**风险**：无。纯新增只读脚本。

---

### Batch 1 — 渲染放大器（store 订阅粒度）

**问题**：`store/session.ts:116-131` 每次写入都 `new Map(st.openSessions)` 换引用，导致 `MessagePage.tsx:117`、`Composer.tsx:123`、`SessionRow.tsx:117`、`Sidebar.tsx:136` 全部失效——即使改动与它们无关。

**设计要点（必须照此实现，否则 Batch 2 无效）**：

当前 `applyDelta`（`session.ts:342-354`）**就地改写 items**，靠换 session 对象来通知。若把 `MessagePage` 的订阅改成选 `items`，而 delta 刷新仍走 `updateSession(id, fn, /*withItems*/ false)`，`items` 引用不变 → **流式将完全不刷新**。

因此本批次必须同时改两处：

1. **delta 刷新改为 `withItems: true`**（`session.ts:352`），让 `items` 引用在 100ms 窗口关闭时换一次。
2. **订阅方从「选整个 session 对象」改为「选真正读的字段」**。

| 组件 | 现状 | 改为 |
|---|---|---|
| `MessagePage.tsx:117` | `st.openSessions.get(st.activePath)` | 分别选 `.items` 与 `.assistantDraft`（数组引用 + 字符串） |
| `Composer.tsx:123` | 同上 | 选 `?.streaming` / `?.ctx` / `?.bgJobs` 三个标量 |
| `SessionRow.tsx:117` | `st.openSessions`（整 Map） | `st.openSessions.get(rowPath)?.streaming` —— 每行 O(1)，仅该行 streaming 翻转才重渲染 |
| `Sidebar.tsx:136` | `st.openSessions` | 视实际读取字段收窄；读取不到就不订阅 |

**同时**（低成本、同一改动面）：

- 加 `sessionId → path` 索引模块级 Map，消掉 `session.ts:119` 与 `:343` 的两次线性扫描。
- `session.ts:404` 的 `setState({ evtSeq: seq })` 移出 store 到模块级变量——实测**零组件订阅 `evtSeq`**，改后无行为差异。

**风险**：

- ⚠️ **最高风险点**：漏改任何一个订阅方会导致「那个 UI 不再更新」。必须逐个组件核对，不得批量替换。
- ⚠️ `SessionRow` 改为按 rowPath 取值后，**LRU 驱逐**（`session.ts:149,199-206`）把该行驱逐出 Map 时，rowPath 取到 `undefined` 需回落到原有默认态，不能崩。

**验收**：

| 项 | 方法 | 通过标准 |
|---|---|---|
| 流式仍刷新 | `smoke:features` + 手工发一条长消息 | 文本逐段出现，无丢帧、无停顿 |
| 输入框不卡 | 手工流式期间在输入框连续打字 | 无掉字、无输入延迟 |
| 后台会话推帧不抖当前窗口 | 开两个会话，后台会话跑工具 | 当前窗口侧栏不出现可见重排 |
| 契约不变 | `bun run check` | 全绿（尤其 `check-host-boundaries` / `check-architecture`） |
| 回归 | `smoke` + `smoke:features` + `smoke:queue` | 全绿 |
| 视图证据 | `dev:browser`（**非** `?preview=1` 样例页） | 截图对照：消息流 / 侧栏 / 右栏三处布局与批次前一致 |

---

### Batch 2 — 消息列表 memo 化

**前提**：Batch 1 已完成且 `items` 引用在流式期间按 100ms 节奏变化。

**改动**：

1. `MessagePage.tsx:424` 的 `renderItems(s.items, "", railEntries, streamTail)` 移入 `useMemo`，依赖 `[items, draft, railEntriesKey, streamTail]`。
2. 行组件补 `memo`：`ToolRow`、`LoopGroup`、`ReadonlyGroup`、`UserMsg`、`TurnActs`、`EditRow`。

**⚠️ 关键约束（来自审计 S4）**：`applyDelta` 就地改写 item，**被改 item 的对象身份不变**。因此 memo 必须挂在**标量 props** 上（如 `text`、`running`、`added`/`removed`），**挂 `item={item}` 会完全失效**——这是本批次最容易做错的地方。

**验收**：

- React DevTools Profiler（`dev:browser`）录制一次流式：消息行组件的 render 次数应从「10Hz × 全量」降到「仅变更行」。
- 展开/折叠工具行、编辑行 diff 展开、读行展开**行为与视觉零变化**。
- `bun run ui:typecheck` + `bun run check` 全绿。

---

### Batch 3 — host delta 合并 + 背压

> ⚠️ **与在途 git 功能冲突**（`host/session-lifecycle.ts` 已被改）。**等那部分落地、rebase 后再开工。**

**问题 A — 帧率错配**：`host/session-lifecycle.ts:419` 每事件一次 `JSON.stringify` + `ws.send`，`translate.ts:562` 的 `text_delta` 逐 token 无节流。前端 100ms 合并、后端 0ms 发送。

**设计约束（顺序正确性优先于合并率）**：

- 只合并**连续同类**的 `text_delta` / `thinking_delta`；
- 一旦遇到任何其他帧类型（`tool_execution_start/end`、`turn_end`、`todo`…），**先 flush 缓冲再发该帧**；
- 帧结构不变，仅合并为 `{...type:"text_delta", text: <拼接>}`。

**问题 B — 无背压**：`host/state.ts:213-218` 无 `ws.bufferedAmount` 检查。慢消费者（**LAN 远程通道 `host/remote.ts` 16800 是现实场景**）会堆积。

→ 对 delta 帧：`bufferedAmount` 超阈值时**丢弃中间 delta**（保留首尾），保证终端最终态收敛即可。

**问题 C — 事件循环内同步读 2MB**：`host/translate.ts:601-602` 在 `session.subscribe` 回调里 `existsSync + statSync ×2 + readFileSync`，写文件工具启动时阻塞全部 WS I/O。
→ 改 `fs.promises` 异步预读；`pendingWrites` 在 `agent_end` 时清理（当前 `:20` 的模块级 Map 只在 `tool_execution_end` 清，中断的 turn 会滞留 ≤2MB/次）。

**验收**：

- 单次流式回复期间，用抓包/计数确认 delta 帧数 **显著低于 token 数**（目标：下降一个数量级，具体数值先测基线再定）。
- 远程通道开 `dev:browser` + 弱网模拟，慢消费者下内存不持续增长（观察 host RSS）。
- 写文件工具执行时，其它会话的帧不出现 >100ms 卡顿。
- `smoke` / `smoke:features` / `smoke:ssh-result` 全绿。

---

### Batch 4 — 产物体积

**实测基线**：启动闭包 **6.23 MiB / 17 chunk**（`app.js` 5,876 KB 占 94%）。

| # | 改动 | 文件 | 预估收益 | 冲突 |
|---|---|---|---|---|
| 4a | **`LANG_MODULES` 改动态 import**（**最大单项，42% 启动包**） | `lib/highlighter.ts:18-53,127-137,226-259,298-312` | ~2.1 MB | **无** |
| 4b | mermaid 插件改动态（照抄同文件 `:129` 的 viz-js 写法） | `components/chat/MdSurface.tsx:12` | ~450 KB | 无 |
| 4c | 设置外壳 + stats 路由 `React.lazy`（27 个页面） | `components/settings/Settings.tsx:20-46`、`StatsPage.tsx:2-3` | ~200 KB | 无 |
| 4d | i18n 语言包按当前 `lang` 动态加载（中英双份现同时进包） | `i18n/` + `main.tsx:90` | ~100 KB | 无 |
| 4e | `prov-logos.js` 改按需查表 | `ui/icons.js` 顶层静态引入 | ~100 KB | **有** |

**4a 设计细节**：

```ts
// 改后：值是工厂函数
const LANG_MODULES: Record<string, () => Promise<LanguageRegistration[]>> = {
  javascript: () => import("shiki/langs/javascript.mjs").then((m) => m.default),
  // ...
};
```

- `loadLanguage` 调用处（`:226-259`）改为 `await h.loadLanguage(await mod())`；
- **`warmupHighlighter`（`:298-312`）必须同步改造**——它当前同步取 `LANG_MODULES[lang]`，不改会让启动预热**静默失效**（不报错、只是不预热），这类失效最难发现，验收必须专门覆盖；
- shiki 语法有传递依赖（`cpp` → `cpp-macro`，`latex` → `tex` 等），需验证动态加载后 `loadLanguage` 仍能正确拉起间接依赖。

**验收**：

| 项 | 方法 | 通过标准 |
|---|---|---|
| 体积下降 | `bun run ui:build && bun run perf:budget` | 启动闭包 < 4.0 MiB；`@shikijs/langs` 在启动闭包中的占比 < 5% |
| 回归防线 | 再跑一次 `perf:budget` | 与基线 JSON 的 diff 即为本次收益记录，回填本文档 |
| 高亮不回归 | 手工读一个 `.cpp`（**间接依赖语法**）、`.ts`、`.py` 文件 | 三者均有语法着色；无语言退化为纯文本 |
| 预热仍生效 | `main.tsx:198` 路径 | 启动后首次展开读行无首帧卡顿 |
| mermaid | 贴一个 ```mermaid 围栏 | 正常渲染出图 |
| 设置页 | 逐个打开 27 个页面 | 全部正常加载（有 `Suspense` fallback 闪现属预期） |
| 门禁 | `bun run check` | 全绿 |

**5. 收尾**：`vite.config.mts:31` 的 `chunkSizeWarningLimit: 6000` —— 实测 `app.js` 恰好 6,017 kB，**告警长期被静音**。随本批次进展下调到有意义的量级（如 2000），让它重新成为信号。

---

### Batch 5 — 长列表窗口化（独立评估，默认**不做**）

消息流目前无虚拟化且**显式禁用** `content-visibility`（`ui/css/main/shell.css:33`，BUG-017 教训）。1000 条消息 = 1000 行全部挂载并 reconcile——这是代码事实，但**掉帧幅度未实测**。

**建议**：先做一次 profiling 拿到 N=1000 的真实数字，再决定是否投入。若要做，方向是「只挂载最后 K 个 turn + 向上滚动加载」，**不是**重新引入 `content-visibility`。

**进入条件**：有 runtime profiling 数据支撑「长会话确实卡」。无数据则本批次维持不做。

---

### Batch 6 — P2 清理（含一处正确性 bug）

| # | 改动 | 文件 |
|---|---|---|
| 6a | 反向扫描零分配（`[...items].reverse().find` → 反向 for） | `store/wsHandlers/stream.ts:126,130`、`store/session.ts:530,562` |
| 6b | `useMemo` 依赖从整个 session 收窄为 `[s?.subagents, hubMode]` | `components/main/AgentHubPage.tsx:72` |
| 6c | `MdSurface` 的 `plugins` 对象提到模块常量；`fixStrongAutolink` 套 `useMemo` | `components/chat/MdSurface.tsx:308,316` |
| 6d | 布局读批进单个 rAF | `components/chat/MsgRail.tsx:302,305`（**冲突**） |
| 6e | `notifyLastAt` 去重表定期清理 | `store/session.ts:294` |
| 6f | **修 bug**：`statsPushedAt` 跨 socket 共享导致第二个 UI 永远收不到 stats | `host/session-snapshot.ts:234` + `host/session-lifecycle.ts:453` |

**6f 是正确性问题，不是性能问题**（本地 + 远程同时连接时，先到的 socket 吃掉节流名额）。它落在性能批次里只是因为改动面重叠——**若要单独修，需 Decider 确认**。

---

## 4. 验收矩阵（汇总）

| 批次 | 自动化门禁 | 手工验证（**不可省略**） | 数据指标 |
|---|---|---|---|
| 0 | `bun run check` | `perf:budget` 输出与本 Spec 数字一致 | 启动闭包 17 chunk / 6.23 MiB |
| 1 | `bun run check` + `smoke` + `smoke:features` + `smoke:queue` | `dev:browser` 三处布局截图对照；输入框连续打字 | 流式期间重渲染组件数下降 |
| 2 | `ui:typecheck` + `check` + `smoke:features` | Profiler 录制；折叠/展开行为对照 | 消息行 render 次数下降 |
| 3 | `smoke` + `smoke:features` + `smoke:ssh-result` | 弱网下远程通道 host RSS 观察 | delta 帧数降一个数量级 |
| 4 | `bun run check` | `.cpp`/`.ts`/`.py` 着色；mermaid 围栏；27 个设置页 | 启动闭包 < 4.0 MiB |
| 5 | — | 需先有 profiling 数据 | 未定 |
| 6 | `bun run check` + 相关 smoke | — | — |

**通用**：任何批次未跑完上述全部项，不得标记为已实施（AGENTS.md 交付报告红线：未实际执行的测试不得声称通过）。

---

## 5. 顺序与依赖说明

**推荐执行序**：Batch 0 → 1 → 2 → 4 → （等 git 功能落地）3 → 6 → （有数据再议）5。

理由：Batch 0 是所有验收的前提；1/2 是交互卡顿主因且文件干净、可立即开工；4 独立于运行时改动、风险最低收益最大；3 必须等冲突消除；6 多为收尾；5 需要尚不存在的数据。

**不建议并行开多分支**：Batch 1 与 2 语义耦合（1 未落地时 2 的 memo 依赖不成立），4a 与 4b/4c 同改 `ui-src` 入口图，拆开易冲突。

---

## 6. 开放问题（需 Decider 拍板）

| # | 问题 | 当前倾向 | 阻塞谁 |
|---|---|---|---|
| Q1 | 6f（stats 饿死）作为 bug 单独修，还是并入 Batch 6？ | 倾向单独修（它是正确性缺陷，不该等性能批次） | Batch 6 |
| Q2 | Batch 3 是否等在途 git 功能落地，还是先 rebase 到最新 main 再动？ | 倾向等落地 | Batch 3 |
| Q3 | `chunkSizeWarningLimit` 下调到多少？（2000 / 1500 / 其他） | 倾向 2000，随优化推进再降 | Batch 4 收尾 |
| Q4 | Batch 5 是否值得投入？ | 倾向**不做**，除非拿到 profiling 数据 | Batch 5 |
| Q5 | 本 Spec 的批次顺序是否接受（渲染 → 体积，host 排后）？ | 待确认 | 全部 |
