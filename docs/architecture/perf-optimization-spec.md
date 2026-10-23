# 性能优化 · 实施 Spec（v3 · 可交付实施）

> **Status**: v3.1(2026-10-19)· 已落地（Batch 0/1/2/3/4/N/G/6；Batch 5 按 §12 不做）· 全部引用与断言已经 4 线并行复核,勘误已直接落入正文
> **基线**: `main` @ `3d1ec45`(全部 `file:line` 已按工作区当前内容复核)
> **工作区**: 直接在主 worktree 实施(v3 原述 `.local/wt/perf-01` worktree 实际不存在,已勘误)
> **证据来源**: `docs/perf-audit-2026-10-18.md`（静态审计；其 §4 带勘误块，勿引用初版结论）
> **交接说明**: 本 Spec 面向**未参与前期讨论的实施者**，可独立执行。§2 陷阱清单是全文最高价值部分，动手前必读。

> **超限说明**: 正文超出 §5 的 300 行默认预算——**超限原因**：每个批次需自带「现状 / 改法 / 陷阱 / 验收」四段才能被独立执行，拆成多份会让实施者在批与批之间丢失上下文。

---

## 0. 给实施者的前置约束

违反任一条即回滚（继承 AGENTS.md）：

1. **Profile 隔离（红线）**：所有冒烟走 `scripts/smoke-profile.ts` 的 `smokeEnv()`，用 `omp-desktop-test`。**严禁污染 `default`**。
2. **中文注释禁令**：不新增中文注释。UI 文案走 `ui-src/i18n/`。
3. **编码**：全部 UTF-8，提交前 `node scripts/check-encoding.mjs` 通过。
4. **zustand 约定**:选择器不得返回新建对象(需要时用 `useShallow`);容器(Map/Set/数组)变更必须换引用;不在 `subscribe` 里 `set`。**现状**:`store/session.ts` 全部直调 `useAppStore.setState`;`setBump`(`store/index.ts:39-41`)只是直通别名、尚未收敛,新代码沿用所在文件既有写法即可,勿为统一顺手改。
5. **真实验证红线**：`?preview=1` 只加载样例，**不得冒充真机验证**。按验证目标选通道（`dev:browser` / CDP 连 Tauri dev 窗口 / 远程形态）。
6. **诚实报告**：未实际跑的测试/构建**不得声称通过**。

**资源边界**（重要，决定顺序）：本应用资源走本地 asset 协议，**不走网络**。所以启动包的瓶颈在**解析/执行**而非传输——优化收益体现在主线程时间，不要用「首屏加载快」这类网络口径描述。

---

## 1. 事实基线（`3d1ec45` 实测）
> ⚠️ **归因方法警告**:绝不能用「在 minified bundle 里搜到某库名字符串」来判断依赖进包——**子串命中不等于代码包含**。本 Spec 的体积结论全部来自 sourcemap 逐行按列区间归属源模块。
>
> **✅ 实测更新(2026-10-19,Batch 4 落地后)**:启动闭包 **6.23 → 2.38 MiB(-61.7%)**,17 chunk 不变;`@shikijs/langs` / `mermaid` / `prov-logos` 归零,`ui-src` 1,193,984 → 506,459 B;新增闭包内 shiki 运行时(~300 KB,预热所需,符合预期)。`app.js` 6,019 → 1,390 kB。基线 JSON 已同步 `perf:budget --update-baseline`。
| 项 | 值 | 测量方式 |
|---|---|---|
| **启动闭包** | **6.23 MiB / 17 chunk** | 从 `app.js` 沿静态 import 做 BFS |
| 入口 `app.js` | 6,019.01 kB（gzip 1,327.72 kB） | `vite build` |
| 磁盘 JS 总量 | 19.03 MiB / 398 chunk | 与启动量无关，其余为懒加载 |
| `@shikijs/langs` | 2,594 KB = **40.7%** 启动包 | sourcemap 逐字节归因 |
| `mermaid` / `@xterm/xterm` | 445 KB / 325 KB | 同上 |
| i18n 语言包 | 266.7 KB / 39 文件(顶层 5 + `ui/` 34;中英双份同在启动包) | 同上 |
| 全仓 `React.memo` | **1 处** | grep |

> ⚠️ **归因方法警告**：绝不能用「在 minified bundle 里搜到某库名字符串」来判断依赖进包——**子串命中不等于代码包含**。本 Spec 的体积结论全部来自 sourcemap 逐行按列区间归属源模块。

---

## 2. 陷阱清单（动手前必读）

这些是「做错了不会报错、只是性能为零或功能坏掉」的地方。

| # | 陷阱 | 后果 |
|---|---|---|
| **T1** | **Batch 1**：只把 `MessagePage` 改成订阅 `items`，但**没同时**把 delta 刷新的 `withItems` 改成 `true` | **流式完全不刷新**。因为 `applyDelta` 是就地改写 items，靠换 session 对象通知；`items` 引用不变 → 组件收不到更新 |
| **T2** | **Batch 2**：给行组件加 `memo` 时传 `item={item}`（对象引用） | **memo 完全失效且不报错**。`applyDelta` 就地改写，被改 item 的对象身份不变 → 必须传**标量 props**（`text` / `running` / `added` / `removed`） |
| **T3** | **Batch 4a**：改了 `LANG_MODULES` 成 Promise 工厂，但没同步改 `warmupHighlighter` | **启动预热静默失效**——不报错，只是不预热，首帧卡顿回来了。`highlighter.ts:298-312` 当前**同步取值** |
| **T4** | **Batch 4a**:shiki 语法有**传递依赖**(`cpp`→`cpp-macro`、`latex`→`tex`、`ruby`→`haml`、`svelte`/`astro`→`postcss`)。**v3 原写的 `html`→`haml`、`css`→`postcss` 是错的,已勘误**(html 只依赖 js+css,css 无依赖) | 动态加载后若间接依赖没跟着拉起,**该语言退化为纯文本**且不报错。必须用 `.cpp`(非直接导入的语法)做验收 |
| **T5** | **Batch 1**：只收窄 `Sidebar` 的订阅，不动 `:414` 的 `useMemo` 依赖数组 | 只是把「重渲染」换成「每帧重算整条侧栏过滤链」，**问题没解决** |
| **T6** | **任何批次**：给消息流加 `content-visibility` | **踩回 BUG-017**（`ui/css/main/shell.css:33` 明确记录过教训）。消息流要窗口化只能走「只挂载最后 K 个 turn + 上滚加载」 |
| **T7** | **Batch 1**：`SessionRow` 改成按 rowPath 取值后，会话被 LRU 驱逐时取到 `undefined` | 需回落默认态，**不能崩** |
| **T8** | **Batch 1/2**:`chat/items.tsx:100,124` 的 `isTurnTailAssistant`/`scanReadonlyRun` 在 render 期间走 `useAppStore.getState()` 旁路读取,不走订阅 | 订阅收窄 + memo 化后可能出现「订阅字段没变、旁路数据已变」→ 该分支不重算。改造时确认这两处是否需转为订阅 |

---

## 3. 批次总览

| 批次 | 主题 | 影响 | 风险 | 依赖 | 文件面 |
|---|---|---|---|---|---|
| **0** | 测量基线固化 | 后续所有验收的前提 | 低 | — | 新增 1 脚本 |
| **1** | 渲染放大器（store） | **高**（卡顿主因） | **中** | 0 | `store/` + 4 组件 |
| **2** | 消息列表 memo 化 | 高 | 中 | 1 | `chat/` |
| **N** | **新增代码的性能债**（下称 Batch N） | 中 | 中低 | 0 | `host/state.ts` + `SessionRow` |
| **G** | Git 功能性能债 | 中 | 中低 | 0 | `host/rpc/*` + `git/` |
| **4** | 产物体积(~3.0 MB) | 中 | **低** | 0 | 构建 + 懒加载 |
| **3** | host delta 合并 + 背压 | 中高 | 中高 | 0 | `host/` |
| **6** | P2 清理（含一处正确性 bug） | 低 | 低 | — | 零散 |
| **5** | 长列表窗口化 | **未知** | 高 | 1,2 | 默认**不做** |

**推荐序**：`0 → 1 → 2 → N → G → 4 → 3 → 6`，5 待定。

**可并行**：`4`（构建/懒加载）与 `G`（host git 层 + GitPage）文件面不重叠，可分两条支线。
**不可并行**：`1` 与 `2` 语义耦合——1 未落地时 2 的 memo 依赖不成立（见 T1）。
**建议串行**：1+2 一条线；3 单独一条（帧顺序风险最高，单独评审）。

---

## 4. Batch 0 — 测量基线固化

**为什么必须先做**：本 Spec 的全部体积结论来自临时脚本（写在 `$env.TEMP`，未入库）。不固化则每批次只能靠体感验收，无法回归。

| 文件 | 改动 |
|---|---|
| `scripts/perf-budget.ts`（新增） | ①从 `app.js` 沿静态 import BFS 输出**启动闭包** chunk 数与字节；②读 `.map`，用 `@jridgewell/trace-mapping`（devDep 已具备）逐行按列区间归属源模块，按 `node_modules` 包 / 本仓目录聚类；③与基线 JSON 对比输出回归表 |
| `package.json` | 加 `"perf:budget": "bun scripts/perf-budget.ts"` |
| `docs/architecture/perf-budget-baseline.json`（新增） | 首次运行生成的基线数字 |

**验收**：`bun run ui:build && bun run perf:budget` 输出 **17 chunk / 6.23 MiB**、归因总和与闭包差 < 1%；二次运行 diff 为空；脚本**纯只读**，不写 `ui/dist` 以外任何路径。

---

## 5. Batch 1 — 渲染放大器（store 订阅粒度）

**问题**：`store/session.ts:116-131` 每次写入都 `new Map(st.openSessions)` 换引用，导致订阅了「整个 session 对象」或「整个 Map」的组件全部失效——**即使这次改动与它们无关**。

### 5.1 当前订阅点(已逐个核实行号与路径,均以 `ui-src/components/` 为根)

| 文件:行 | 当前写法 | 实际读取的字段 |
|---|---|---|
| `main/chat/MessagePage.tsx:117` | `st.openSessions.get(st.activePath)`(整个对象) | `assistantDraft` `externalWrite` `items` `sessionId` `streaming` |
| `Composer.tsx:124` | 同上(整个对象) | `autoResolved` `computerMode` `ctx` `model` `sessionId` `thinking` `isSubagent`(`:396,:795`)`streaming`(`:1113`)——后两项为复核新增,漏拆会导致输入框状态不刷新 |
| `main/sidebar/SessionRow.tsx:117` | `st.openSessions`(整个 Map) | `open`(`streaming`/`pendingApprovals`)等 |
| `main/sidebar/Sidebar.tsx:136` | `st.openSessions`(整个 Map) | 见 `:409` 的 memo 依赖 |

> 注：`{...cur}` 是**浅拷贝**，`ctx` / `model` 这类嵌套对象换批次时引用不变 → 直接选它们是安全的。

### 5.2 改法

**第一步（必须与第二步同时落地，见 T1）**——`store/session.ts:352`：

```ts
// 现状：delta 窗口关闭时的空补丁，用 withItems=false
for (const id of ids) updateSession(id, () => {}, false);
// 改为：items 必须换引用，否则订阅 items 的组件收不到通知
for (const id of ids) updateSession(id, () => {}, true);
```

**第二步**——订阅方改为选真正读的字段：

```ts
// MessagePage.tsx
const items = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.items : undefined));
const draft = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath)?.assistantDraft : undefined));
// 其余字段（sessionId / streaming / externalWrite）同理逐个拆出
```

`SessionRow` / `Sidebar` 改为按 path 取值的标量选择器。**注意 T5**：`Sidebar.tsx:414` 的 `useMemo` 依赖数组含 `openSessions`，必须同步处理。

**第三步（同一改动面，低成本）**：
- 加 `sessionId → path` 模块级索引，消除 `session.ts:119` 与 `:343` 的两次线性扫描。
- `session.ts:404` 的 `useAppStore.setState({ evtSeq: seq })` 移到模块级变量——已核实**全仓零组件订阅 `evtSeq`**，改后无行为差异，却省掉每 token 一次的全量 selector 重跑。

### 5.3 验收

| 项 | 方法 | 标准 |
|---|---|---|
| 流式仍刷新 | `smoke:features` + 手工长消息 | 逐段出现，无丢帧 |
| 输入框不卡 | 流式期间连续打字 | 无掉字、无输入延迟 |
| 后台推帧不抖当前窗口 | 双会话，后台跑工具 | 当前窗口侧栏无可见重排 |
| 契约不变 | `bun run check` | 全绿 |
| 回归 | `smoke` + `smoke:features` + `smoke:queue` | 全绿 |
| 视图证据 | `dev:browser`（**非** `?preview=1`） | 消息流 / 侧栏 / 右栏三处布局与批次前一致 |

---

## 6. Batch 2 — 消息列表 memo 化

**前提**：Batch 1 完成，`items` 引用按 100ms 节奏变化。

1. `MessagePage.tsx:424` 的 `renderItems(s.items, "", railEntries, streamTail)` 移入 `useMemo`，依赖 `[items, draft, railEntriesKey, streamTail]`。
2. 行组件补 `memo`：`ToolRow`、`LoopGroup`、`ReadonlyGroup`、`UserMsg`、`TurnActs`、`EditRow`——**必须传标量 props**（见 T2）。

**验收**：Profiler 录制一次流式，消息行 render 次数从「10Hz × 全量」降到「仅变更行」；折叠/展开行为与视觉零变化；`bun run ui:typecheck` + `bun run check` 全绿。

---

## 7. Batch N — 新增代码的性能债（`3d1ec45` 引入）

### N1 — 每行侧栏的 `.some()` 全数组扫描（本次新代码引入）

`ui-src/components/main/sidebar/SessionRow.tsx:126`

```ts
const poolBusy = useAppStore((st) => st.poolSessions.some((p) => p.path === s.path && p.busy === true));
```

**返回值是对的**（`some()` 出布尔值，`Object.is` 稳定，不会引发重渲染风暴）。
**但 `.some()` 本身在「每次 store 通知 × 每一行侧栏」各跑一遍。** 通知频率：流式合并窗口 10 次/秒 + `session.ts:404` **每 token 一次** + 每次 `pool_sessions` 推送。30 行侧栏 ≈ **每秒上千次全数组扫描**，全部发生在侧栏正被 `session.ts` 换引用打爆的窗口里。

**改法**：让选择器走标量索引而非每次扫数组——

```ts
// 方案 A（推荐）：store 维护 busyPaths 集合，选择器 O(1)
const poolBusy = useAppStore((st) => st.busyPaths.has(s.path));
// 方案 B（退而求其次）：至少把 .some() 包进 useMemo，只在 poolSessions 真变了时重算
```

**先测量再改**：记录 `poolSessions` 的实际长度。若长期 ≤ 10，方案 B 可能已足够；若上百，A 才有意义。**把测量结果写进本 Spec。**

### N2 — host 每个回合多跑两次全池序列化

`host/state.ts:190`（`pushPoolSnapshot`）对**整个会话池**做 `JSON.stringify`；新加的 `handleRunLifecycleEvent`（`state.ts:216`）在**每个 `agent_start` / `agent_end`** 调 `eachUiWs(pushPoolSnapshot)`，且每个 `agent_end` 还挂一个 `waitForIdle().then(...)` 再广播一次。

频率是「每回合」不是「每 token」,**本身不致命**。但它叠在一个既有问题上:**会话池无 LRU 驱逐**——`sessions.delete` 仅由显式 RPC 触发(`host/rpc/session.ts:318` reload_session、`:352` session_unload、`:413` delete_session;勿把 `host/pty.ts:97,163` 算进来,那是 PTY 自己的 Map),池会持续增长,这个 O(池大小) 遍历随之增长。

**改法**：①给池加空闲 LRU 驱逐；②`pushPoolSnapshot` 加节流或只在 `busy` 集合真变化时才推。

**验收**：N1——DevTools Performance 录一次流式，确认侧栏不再有 `Array.some` 热点；N2——反复开关 20 个会话后观察 `sessions.size` 不单调增长。

---

## 8. Batch G — Git 功能性能债

> 只动 `host/git.ts`、`host/rpc/git-graph.ts`、`host/rpc/files.ts`、`ui-src/components/main/git/*`、`ui-src/store/git-graph.ts`。与 Batch 1/2 文件面不重叠。

| # | 问题 | 证据 | 改法 |
|---|---|---|---|
| **G1** | **discard 逐 path 串行 2 次 spawn** | `host/rpc/files.ts:250-259`：`for (const p of paths)` 内 `await ls-files` + `await checkout/clean`；丢 50 个文件 = **100 次串行 spawn**，全程阻塞事件循环 | 一次 `ls-files -z --` 分区，再两次批量调用（**同文件的 `git_stage` 已经是这样批量的，照抄**） |
| **G2** | **`graphCache` 是唯一无驱逐的缓存** | `git-graph.ts:244` 裸 `Map.set`(`:184` 是 Map 声明行,v3 误标,已勘误);`GRAPH_TTL_MS` 只管**读**(`:212`)不管**写**。key 是 `(root, scope, limit)`,每换一个分支/tag 作用域永久留一条(最多 1000 commits)。**同文件 `detailCache:286`、`fileDiffCache:328` 都走了 `remember()` LRU** | `graphCache` 改走 `remember()`,与同类对齐 |
| **G3** | **提交列表无窗口化，最多 1000 行 × 每行一个 SVG** | `GitPage.tsx:585`「加载更多」把 limit 加 `PAGE_STEP=100`，无上限；每行 `<LaneStrip>`（`graph-lanes.tsx:83`）= 1 `<svg>` + N 个 `<line>`/`<circle>`/`<path>` → 1000 行 ≈ 3–5k SVG 节点全挂载。筛选输入每次击键全量重渲（`GitPage.tsx:138-164,206` 已正确 useMemo，但依赖 `filterText`） | 按滚动位置窗口化（可见区 ± overscan）；筛选输入加 debounce |
| **G4** | **缓存命中仍要跑一次子进程** | `git-graph.ts:199-215`：`repoRoot(cwd)`（→ `git rev-parse --show-toplevel`）在 `graphCache.get` **之前**执行。文件头 `:12` 声称「重开页面零子进程」是错的 | 缓存 key 用原始 `cwd`，或按 cwd memoize `repoRoot` |
| **G5** | `fileDiffCache` 上限约 150 MB | `git-graph.ts:328` `remember(fileDiffCache, key, stdout.slice(0, 500_000))`，`MAX_IMMUTABLE_ROWS = 300` → 300 × 500 KB 常驻 | 条目降到 ~64，或改成按总字节预算 |
| **G6** | 每次 git-status 刷新 = 3 次 spawn + 6 次阻塞 `existsSync` | `files.ts:347` → `host/git.ts:213-225`:`rev-parse --absolute-git-dir` spawn + 最多 6 次 `fs.existsSync`(`:217` 三连 + `:218-220` 各一,v3 误数 5 次) + `symbolic-ref` spawn。同步 stat 阻塞 Bun 事件循环 | 按 git-dir 缓存 `HEAD`/`.git` 读取 |

**已确认干净,实施者不要重查**:所有 git 调用都是 async `Bun.spawn` 带超时(`git.ts:85-96`),**无 `spawnSync`/`execSync`**;`MAX_LIMIT=1000`/`DEFAULT_LIMIT=200` 有上限(`git-graph.ts:22-23`);前端 `graphMemo` 已有 40 条 FIFO 驱逐(`store/git-graph.ts:44-50`);`computeGraphRows` **不是 O(n²)**(`graph-lanes.tsx:27-71`,`lanes` 宽度=可见列数,已 memo);**GitPage/CommitDiffPage 不订阅 `openSessions`**(`GitPage.tsx:54` 只订阅 `s.gitManage` 原始值),未扩大 Batch 1 爆炸半径;`ui/css/main/git-page.css`(`ui/style.css:45` 引入,v3 误写为 `ui-src/components/main/git/` 下,已勘误)421 行 grep 无 `:has()`/`will-change`/`backdrop-filter`/`filter:`/`box-shadow`。

**验收**：

| 项 | 方法 | 标准 |
|---|---|---|
| G1 | 手工丢弃 50 个已跟踪 + 50 个未跟踪文件 | 子进程数从 ~200 降到 3；墙钟显著下降 |
| G2 | 切 20 个分支作用域后观察 host 内存 | `graphCache.size` 不超过 LRU 上限 |
| G3 | 加载到 1000 条提交 + 连续筛选 | 无掉帧；DOM 中 SVG 行数 = 可见区 + overscan |
| G4 | 重复打开/关闭 Git 页 | 第二次起 `git_graph` 调用 0 子进程 |
| G6 | 触发一次 status 刷新 | 子进程数 ≤ 1 |
| 回归 | `bun run check` + `smoke:git-refs` + `smoke:features` | 全绿 |

---

## 9. Batch 4 — 产物体积

| # | 改动 | 文件 | 预估 |
|---|---|---|---|
| 4a | **`LANG_MODULES` 改动态 import**(最大单项,40.7%) | `lib/highlighter.ts:18-53`(36 条静态 import)、`:127-137`(Record 本体)、`:228-233`(loadLanguage)、`:298-312`(warmup) | ~2.1 MB |
| 4b | mermaid 插件改动态(照抄同文件 `:129` 的 viz-js 写法) | `chat/MdSurface.tsx:13`(v3 误标 `:12`,差 1 行) | ~450 KB |
| 4c | 设置外壳 `React.lazy`(27 页) | `settings/Settings.tsx:20-46`;`pg-stats` 是其中子页 `settings/pages/StatsPage.tsx:2-3`,**无独立路由**(v3 表述已勘误) | ~200 KB |
| 4d | i18n 语言包按当前 `lang` 动态加载 | `i18n/` + `main.tsx:90`;旁路静态引入两处勿漏:`Settings.tsx:13-14`、`PaletteMenu.tsx:12` | ~130 KB |
| 4e | `prov-logos.js` 改按需查表 | `ui/prov-logos.js` 经 `shared/models/ProvLogo.tsx:4` 静态引入(v3 误写 `ui/icons.js` 顶层,该文件无 prov 引用) | ~100 KB |

**4a 设计**：

```ts
const LANG_MODULES: Record<string, () => Promise<LanguageRegistration[]>> = {
  javascript: () => import("shiki/langs/javascript.mjs").then((m) => m.default),
  // ...
};
// loadLanguage 处（:226-259）
await h.loadLanguage(await mod());
```
> 注:default export **本身就是** `LanguageRegistration[]`(`highlighter.ts:122-126` 注释已记录过此坑),`.then((m) => m.default)` 之后不要再包一层。
> 4d 隐藏约束:语言切换走 `<App key={lang}>` 整树重挂载,动态加载必须保证 `initI18n` await 完成前不渲染。

> ⚠️ **T3**：`warmupHighlighter`（`:298-312`）当前同步取 `LANG_MODULES[lang]`，**必须同步改造**，否则预热静默失效。
> ⚠️ **T4**:验证 shiki 语法传递依赖(`cpp`→`cpp-macro`、`ruby`→`haml` 等,详见 §2 表)在动态加载后仍能拉起。

**验收**：

| 项 | 方法 | 标准 |
|---|---|---|
| 体积 | `bun run ui:build && bun run perf:budget` | 启动闭包 < 4.0 MiB；`@shikijs/langs` 占比 < 5% |
| 记录收益 | 同上 | 收益回填本 Spec §1 |
| 高亮不回归 | 手工读 `.cpp`（**间接依赖语法**）、`.ts`、`.py` | 三者均有着色，无语言退化为纯文本 |
| 预热仍生效 | `main.tsx:198` 路径 | 首次展开读行无首帧卡顿 |
| mermaid | 贴 ```mermaid 围栏 | 正常出图 |
| 设置页 | 逐个打开 27 页 | 全部正常加载（`Suspense` fallback 闪现属预期） |
| 门禁 | `bun run check` | 全绿 |

**收尾**：`vite.config.mts:31` 的 `chunkSizeWarningLimit: 6000`——实测 `app.js` 恰好 6,019 kB，**告警长期被静音**。随本批次下调到有意义量级（如 2000）。

---

## 10. Batch 3 — host delta 合并 + 背压

| # | 问题 | 证据（`3d1ec45` 行号） | 改法 |
|---|---|---|---|
| 3a | **每 token 一帧，无节流** | `session-lifecycle.ts:424` `bus.send(JSON.stringify(stampEvent(...)))`；`translate.ts:562` 的 `text_delta` 逐 token。前端 100ms 合并、后端 0ms 发送 | 只合并**连续同类** `text_delta`/`thinking_delta`；**遇任何其他帧类型先 flush 再发**（顺序正确性 > 合并率）；**帧结构不变** |
| 3b | **无背压** | `host/state.ts:250-253` `entryBus.send` 无 `ws.bufferedAmount` 检查。慢消费者(**LAN 远程通道 `remote.ts` 16800 是现实场景**)会堆积 | delta 帧超阈值时**丢弃尾部、保留已发前缀**,背压解除后从上次已发位置续发。前端 `text_delta` 是拼接语义(`store/session.ts:502-504` `s.assistantDraft += msg.text`),**v3 原案「丢中间段保首尾」会永久丢文本,已勘误** |
| 3c | **事件循环内同步读 ≤2MB** | `translate.ts:601-602` 在 subscribe 回调的同步调用栈上(`translateEvent` 的 `tool_execution_start` 分支,经 `session-lifecycle.ts:419-424` 调入)`existsSync + statSync×2 + readFileSync`,写文件工具启动时阻塞全部 WS I/O | 改 `fs.promises` 异步预读;`pendingWrites`(`translate.ts:20` 模块级 Map,当前只在 `tool_execution_end` 清)在 `agent_end` 清理——中断的 turn 会滞留 ≤2MB/次 |

**验收**：单次流式期间 delta 帧数显著低于 token 数（**先测基线再定目标值**）；弱网远程通道下 host RSS 不持续增长；写文件执行时其它会话帧无 >100ms 卡顿；`smoke` / `smoke:features` / `smoke:ssh-result` 全绿。

---

## 11. Batch 6 — P2 清理（含一处正确性 bug）

| # | 改动 | 文件:行 |
|---|---|---|
| 6a | 反向扫描零分配(`[...s.items].reverse().find` → 反向 for) | `store/wsHandlers/stream.ts:126,130,137,313-314`、`store/session.ts:516,530,562-563,605,612,618,644`(v3 只列 2 处,实际 11 处) |
| 6b | `useMemo` 依赖从整个 session 收窄为 `[s?.subagents, hubMode]` | `main/AgentHubPage.tsx:72` |
| 6c | `plugins` 对象提为模块常量；`fixStrongAutolink` 套 `useMemo` | `chat/MdSurface.tsx:308,316` |
| 6d | 布局读批进单个 rAF | `components/chat/MsgRail.tsx:289-290,297,305-306,318-319,333-338,367`(路径无 `main/` 层;`:302` 是 querySelector 非布局读,v3 误标) |
| 6e | `notifyLastAt` 去重表定期清理 | `store/session.ts:294` |
| 6f | **修 bug**:`statsPushedAt` 挂在池条目而非 per-socket(`session-snapshot.ts:230-237`,节流窗 1500ms)→ 本地+远程同连时第二个 UI **回合内收不到实时 stats**;attach 重建(`session-lifecycle.ts:926`)与 terminal `agent_end`(`:517-519`)的无条件推送仍会到,v3「永远收不到」表述过强已勘误 | `host/session-snapshot.ts:234` + `host/session-lifecycle.ts:466-467`(节流状态移到 per-socket) |

**6f 是正确性问题不是性能问题**，建议单独成一个修复提交，不要混在性能批次里。

---

## 12. Batch 5 — 长列表窗口化（默认**不做**）

消息流无虚拟化且显式禁用 `content-visibility`（`shell.css:33`，BUG-017 教训）。这是代码事实，但**掉帧幅度未实测**。建议先 profiling 拿 N=1000 的真实数字再决定投入。方向是「只挂载最后 K 个 turn + 上滚加载」，**不是**重引入 `content-visibility`（见 T6）。

> 区别：Batch G3 的 Git 提交列表窗口化**不是同一件事**——G3 做窗口化是因为上限 1000 且每行含 SVG（已实测节点数），风险远低于消息流。

---

## 13. 验收矩阵（汇总）

| 批次 | 自动化门禁 | 手工验证（不可省略） | 数据指标 |
|---|---|---|---|
| 0 | `bun run check` | `perf:budget` 输出与 §1 一致 | 17 chunk / 6.23 MiB |
| 1 | `check` + `smoke` + `smoke:features` + `smoke:queue` | `dev:browser` 三处布局截图；流式打字 | 重渲染组件数下降 |
| 2 | `ui:typecheck` + `check` + `smoke:features` | Profiler 录制；折叠展开对照 | 行 render 次数下降 |
| N | `check` + `smoke:features` | DevTools Performance 看侧栏热点 | `.some` 热点消失；`sessions.size` 不单调增长 |
| G | `check` + `smoke:git-refs` + `smoke:features` | 批量丢弃 50+50；切 20 分支看内存；1000 条筛选 | spawn 数 200→3；SVG 行数 = 可见区 |
| 4 | `bun run check` | `.cpp`/`.ts`/`.py` 着色；mermaid 围栏；27 页 | 启动闭包 < 4.0 MiB |
| 3 | `smoke` + `smoke:features` + `smoke:ssh-result` | 弱网远程通道 RSS 观察 | delta 帧数降一个数量级 |
| 6 | `bun run check` + 相关 smoke | — | — |

**通用红线**：任何批次未跑完上表全部项，不得标记为已实施；未实际执行的测试不得声称通过。

---

## 14. 本 Spec 未验证的事项（实施者须知）

不要把以下内容当作既成事实：

- **全程没有做运行时 profiling**——没有 DevTools trace、没有火焰图、没有真实 token 频率采样。§3 的影响排序由**静态证据**排定，不是实测。实施者应当**先测量再改**，尤其是 Batch 1 的实际收益。
- **体积收益是预估**：`~2.1 MB`、`~450 KB` 等均来自「该依赖当前在启动包中的实测字节数」，**未做改前/改后对照构建**。Batch 0 的 `perf:budget` 就是为了做这个对照。
- **G1–G6 未实测量化**：`100 → 3` 次 spawn、150 MB、3–5k SVG 节点均为静态推断。
- **`Bun.serve` 默认 `backpressureLimit` 行为未确认**（未读 Bun 版本文档），Batch 3b 的严重程度取决于部署版本的实际默认值。
- **Batch 5 的价值完全未知**，需先 profiling。

---

## 15. 待拍板事项

| # | 问题 | 当前倾向 |
|---|---|---|
| Q1 | 6f（stats 饿死）单独修还是并入 Batch 6？ | **单独修**——正确性缺陷不该等性能批次 |
| Q2 | Batch 4 与 Batch G 是否分两条支线并行？ | 并行——文件面不重叠，且都是低风险高收益 |
| Q3 | `chunkSizeWarningLimit` 下调到多少？ | 2000，随优化推进再降 |
| Q4 | Batch 5 是否值得投入？ | **不做**，除非拿到 profiling 数据 |
| Q5 | 批次序认可？（`0→1→2→N→G→4→3→6`） | 待确认 |
