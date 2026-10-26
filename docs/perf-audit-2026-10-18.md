# 性能审计报告（2026-10-18 时点快照）

> 调研日期：2026-10-18。方法：静态代码审计 + 构建产物实测（`vite build --sourcemap` 后按 sourcemap 逐字节归因 + 静态依赖图 BFS），**未做运行时 profiling**（未跑 DevTools trace、未采集火焰图）。
> 与 `ui-claude-optimization-plan.md` 不重叠：那份是视觉/动效手感，本份是运行时与产物体积。
> 每条均带 `path:line` 证据。**标注「实测」的为本次测量所得，「推断」的为读码推断、未经运行时确认。**

> ⚠️ **本报告 §4 曾有一版错误结论，已修正。** 初版用「在 app.js 里搜到 mermaid/xterm 字符串」来论证依赖进包——**子串命中不等于代码包含**。修正后用 sourcemap 归因重测：mermaid 与 xterm **确实**在启动闭包里（结论对），但 19MB **不是**启动量，真实启动量是 6.23 MiB。以 §4 的实测表为准。

---

## 0. 结论

三句话：

1. **交互卡顿的主因不在单个组件，而在「每个 WS 帧都换掉整个 session 引用」这一个放大器**，它让 10Hz 的流式刷新变成全树重建。修它的收益 > 修任何单个组件。
2. **Host 侧每个 token 发一帧 WebSocket，且无背压**，与前端 100ms 合并窗口完全错配——前端做了合并，后端没做。
3. **启动包 6.23 MiB 里，42%（2.59 MB）是 shiki 语法**，全部来自 `lib/highlighter.ts:18-53` 的 37 个静态 import；mermaid 445 KB + xterm 325 KB 同样在启动闭包里。**而应用层代码分割为零**（27 个设置页全静态进包，190 KB 的 i18n 字符串也是）——依赖库切了、应用自己没切。

**建议顺序**：P0 三条（放大器 / host 合并 / shiki 动态化）→ P1 设置页 lazy + 长列表 → P2 收尾。

---

## 1. 实测基线

| 项 | 实测值 | 备注 |
|---|---|---|
| **启动真实加载量** | **6.23 MiB / 17 个 chunk** | 从 `app.js` 做静态 import 闭包 BFS；其余 381 个 chunk 是懒加载的 |
| 入口 `ui/dist/assets/app.js` | 5,876 KB（gzip 1,327 KB） | 启动量的 94% |
| `ui/dist` JS 总量（磁盘） | 19,473 KB / 398 个 chunk | **不是**启动量，仅代表磁盘占用 |
| 产物里的动态 import | **308 处** | 全部来自 mermaid / shiki 内部的 `lazy()` 包装，非应用代码 |
| CSS | 311 KB（gzip 52 KB） | 单文件 |
| 全仓 `React.memo` 调用点 | **1 处**（`ui-src/components/chat/AssistantMsg.tsx:83`） | `useMemo` 91 处、`useCallback` 33 处 |
| 全仓**应用侧**动态 `import()` | 2 处（`MdSurface.tsx:129` viz-js、`main.tsx:201` tap-probe） | 无一处 `React.lazy` |
| `ui/prov-logos.js` | 102.6 KB（26 个 base64 data URI） | 实测确认进入启动闭包 |
| 设置页静态 import 数 | 27 个（`components/settings/Settings.tsx:20-46`） | 无一 lazy |

### 启动包构成（sourcemap 逐字节归因，实测）

| 包 | 启动占用 | 占比 |
|---|---|---|
| **`@shikijs/langs`** | **2,594 KB** | **42%** |
| 本仓 `ui-src` | 1,166 KB | 19% |
| `mermaid` | 445 KB | 7% |
| `@xterm/xterm` | 325 KB | 5% |
| `react-dom` | 203 KB | 3% |
| `lexical` | 176 KB | 3% |
| `parse5` | 122 KB | 2% |
| `ui/prov-logos.js` | 102 KB | 2% |
| `ui/file-icons.js` | 85 KB | 1% |
| `streamdown` / `marked` / i18next / radix 等 | 余下 ~500 KB | |

shiki 内部的大头（**单 C++ 一族就 766 KB**）：`cpp.mjs` 489 KB、`cpp-macro.mjs` 278 KB、`typescript.mjs` 177 KB、`jsx.mjs` 174 KB、`tsx.mjs` 171 KB、`javascript.mjs` 171 KB、`php.mjs` 110 KB、`less.mjs` 95 KB、`csharp.mjs` 88 KB、`swift.mjs` 84 KB。

> 口径：按 sourcemap 把每行生成代码按列区间归属回源模块，再按 node_modules 包 / 本仓目录聚类；`attributed 6.21 MiB / unmapped 0.01 MiB`，归因完整。

---

## 2. P0 —— 流式渲染放大

### 2.1 每次 WS 帧都克隆整个 `openSessions` Map（放大器本体）

`ui-src/store/session.ts:116-131`

```ts
for (const [p, v] of st.openSessions) { if (v.sessionId === sessionId) { hit = p; break; } }
const next = withItems ? { ...cur, items: cur.items.slice() } : { ...cur };
return { openSessions: new Map(st.openSessions).set(hit, next) };
```

一次写入 = 一次 Map 全量克隆 + 一次 session 浅拷贝 +（带 items 时）一次数组拷贝。
**代价不在克隆本身（openSessions 上限 8，见 `session.ts:149`），而在引用一换，所有订阅了「整个 session 对象」或「整个 Map」的组件同时失效。**

实测订阅点（全部会在任意帧后重渲染）：

- `MessagePage.tsx:117` — 当前会话整个对象
- `Composer.tsx:123` — 当前会话整个对象（Lexical 编辑器跟着重渲染）
- `Sidebar.tsx:136` / `SessionRow.tsx:117` — 整个 `openSessions`，**每个侧栏行都订阅**，且与被改动会话无关的行也一起重渲染

**修法**：给 store 加一个 `sessionId → path` 索引消除线性扫描；值变更走「标量版本号 bump」而不是换 Map 引用；订阅方改成取自己真正读的标量（`s?.streaming`、`s?.title`），而不是整个对象。

### 2.2 消息列表全量重算，且几乎裸奔

`ui-src/components/main/chat/MessagePage.tsx:424`

```ts
const nodes = renderItems(s.items, "", railEntries, streamTail);
```

在 render body 里直接调用，**没有 `useMemo`**。每次重渲染都全量遍历 items、重建所有 ReactElement（含 turn 分组、edit/read/cmd 折叠、`railEntries` 收集）。
配合 §2.1，流的 100ms 合并窗口一关就是一次全量重建。

同时 `ToolRow` / `LoopGroup` / `ReadonlyGroup` / `UserMsg` / `EditRow` **都没有 `memo`**——所以即使 (1) 用相同 props 重建了 element，React 仍会逐个重新执行这些组件。全仓唯一的 `memo` 是 `AssistantMsg`。

> ⚠️ 修 memo 前先看 `applyDelta` 的就地改写（`session.ts:343-346` + `updateSession(..., false)`）：被改的 item **对象身份不变**，所以 memo 必须挂在标量 props 上，不能挂对象。

**修法**：`renderItems` 结果 `useMemo`（依赖 items 引用 + draft 版本号）；行组件补 `memo`（传标量 props）。

### 2.3 Composer 每秒重渲染 10 次

`ui-src/components/Composer.tsx:123` 订阅整个会话对象且组件本身未 memo。流式期间 Lexical 编辑器、pill 栏、ctx 环、各弹层全部跟着重渲染——**这是「打字时输入框顿挫」的最可能来源**。

### 2.4 侧栏每一行都订阅整个 Map

`ui-src/components/main/sidebar/SessionRow.tsx:117` `useAppStore((s) => s.openSessions)`。
后台会话推帧（tool/todo/ctx/subagent）同样会换掉 Map 引用，于是**当前窗口没在动，侧栏几十行却在重渲染**。

---

## 3. P0 —— Host 每 token 一帧

### 3.1 每个 token 一次 `JSON.stringify` + 一次 `ws.send`

`host/session-lifecycle.ts:419`

```ts
if (ui) bus.send(JSON.stringify(stampEvent({ type: "event", sessionId, ...ui })));
```

`host/translate.ts:562` 的 `text_delta` 是**逐 token 无节流**的。一个 4k token 的回复 ≈ 4k 帧、4k 次系统调用发送。

代码库里**已经有**合并的先例（`session-lifecycle.ts:405-412` 的 queue 推送走 `queueMicrotask` 合并），只是 delta 路径没做。前端 100ms 合并、后端 0ms 发送，后端在做无用功。

**修法**：按 session 缓冲 delta，每 ~16ms（一个事件循环 tick）合并成一帧。

### 3.2 发送路径无背压

`host/state.ts:213-218`

```ts
send(data: string) { for (const w of entry.uiSockets) w.send(data); }
```

无 `ws.bufferedAmount` 检查，`Bun.serve` 也未设 `backpressureLimit`。慢消费者（**LAN 远程通道是现实场景**，`host/remote.ts` 16800）会让 host 以模型产出速度堆积帧。
→ 对 delta 帧在超阈值时丢弃/合并。

### 3.3 事件循环内同步读最大 2MB 文件

`host/translate.ts:601-602`

```ts
if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size <= 2_000_000) {
  pendingWrites.set(ev.toolCallId, { path: abs, oldText: fs.readFileSync(abs, "utf8") });
}
```

在 `session.subscribe` 回调里，即**事件循环上**；且 `statSync` 调了两次。写文件工具启动时阻塞全部 WS I/O。

### 3.4 TTS 让帧率翻倍

`host/voice.ts:98-101` 每 token 额外发一帧 `tts_delta`（`speech.enabled` + assistant/all 模式）。
→ 按标点缓冲成句再发。

---

## 4. P1 —— 产物体积：依赖库切了，应用自己没切

### 4.0 先说清楚边界（实测）

- **启动闭包 = 6.23 MiB / 17 chunk**（从 `app.js` 沿静态 import BFS）。磁盘上 19.02 MiB / 398 chunk，**其余 381 个是懒加载的**——初版把磁盘总量当成启动量是错的。
- **产物里已有 308 处动态 import**，但全部来自 **mermaid 与 shiki 内部的 `lazy()` 包装**（已验证：产物中形如 `()=>import(\`./chunk-xxx.js\`)`，上下文是 `createMermaidPlugin` 的 `React.lazy`、mermaid 的 dagre/elk layout loader、shiki 的 `{id:"java", import:()=>import(...)}` 注册表）。**不是本项目写的代码**。
- 所以准确的结论是：**依赖库自己切了，应用层一行动态 import 都没写。**

### 4.1 shiki 语法 = 启动包的 42%（最大单项）

`ui-src/lib/highlighter.ts:18-53` 静态 import 37 个语法模块，`LANG_MODULES`（`:127-137`）做的是**惰性注册**——但模块本身早已进包。实测这 47 个 shiki grammar 文件在启动闭包里合计 **2,594 KB / 6.23 MiB = 42%**，其中 C++ 一族就 766 KB（`cpp.mjs` 489 KB + `cpp-macro.mjs` 278 KB，其余 10 个是语法间接依赖：latex→tex、html→haml、css→postcss 等）。

一次会话里真正用到的高频语法就是 `typescript / tsx / javascript / json / markdown`——其余三十多个（C++、PHP、Swift、Ruby、Lua、Kotlin…）几乎不会被点开，却占了启动包的大头。

**修法**：`LANG_MODULES` 的值改成 `() => import("shiki/langs/xxx.mjs").then(m => m.default)`，`loadLanguage` 处 await 一下即可。**注意 `warmupHighlighter`（`:298-312`）依赖同步拿 `LANG_MODULES[lang]`，要一起改成接受 Promise**。预估省下 ~2.1 MB（未做对照构建验证）。

### 4.2 mermaid / xterm 在启动闭包里

- **mermaid 445 KB**：`MdSurface.tsx:12` 静态 `import { createMermaidPlugin } from "@streamdown/mermaid"`。实测 mermaid 核心确实在启动闭包内（它自己的**图类型语法**与 dagre/elk layout loader 是懒的）。
  → 对比：同文件 `:129` 的 viz-js **已经是动态 import**，mermaid 漏了同样待遇。
- **`@xterm/xterm` 325 KB**：`components/main/right/TerminalPage.tsx:8` 静态 import，用户不打开终端标签就白付。
  → 右栏各 tab 改 `React.lazy`。

### 4.3 应用层：27 个设置页 + 190 KB i18n 全静态

`components/settings/Settings.tsx:20-46` 静态 import 全部 27 个设置页（实测 ui-src 占用里 `McpPage` 46 KB、`ModelPage` 25 KB、`ExtensionsPage` 14 KB、`GeneralPage` 14 KB…），`StatsPage.tsx` 同理。
i18n 侧实测：`settingsPage.en.ts` 71 KB + `settings-zh-CN.ts` 51 KB + `settingsPage.zh.ts` 43 KB + `chat.zh.ts` 30 KB —— **中英双份语言包同时进包**，用户只用一种。

**修法**：设置外壳 + stats 路由 `React.lazy`；i18n 语言包按当前 `lang` 动态加载（`main.tsx:90` 的 `initI18n` 处）。

### 4.4 图标注册表

`ui/prov-logos.js` 102.6 KB（26 个 base64 PNG）+ `file-icons.js` 85.7 KB + `fa-icons.js` 32.9 KB + `lucide-icons.js` 23.7 KB = **245 KB base64/SVG 字符串**，在 `ui/icons.js:顶层` 被静态引入，启动即解析。
→ prov-logos 改按需查表（只在模型页/供应商页取用）。

### 4.5 构建配置

`vite.config.mts:31` 把 `chunkSizeWarningLimit` 抬到 6000 kB —— 而实测 `app.js` 恰好 6,017 kB，**告警每次都被静音**。这条阈值本是为了压制噪音；建议随优化进展逐步下调（如 2000），让它重新成为信号。

### 4.6 消息流无虚拟化，且显式禁用了 content-visibility

`ui/css/main/shell.css:33`

```css
/* No content-visibility on the message flow (BUG-017): reconciling the initial 120px estimate ... */
```

这是**有意为之**（BUG-017 的教训），不算 bug。但代价是：1000 条消息 = 1000 行全部挂载并参与 reconcile。
→ 若要做，方向应是「只挂载最后 K 个 turn + 向上滚动加载」，而不是重新引入 content-visibility（那正是 BUG-017 踩过的坑）。

---

## 5. P2 —— 次级问题

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| 5.1 | 每 token 一次 store 写 | `store/session.ts:404` `setState({ evtSeq: seq })` | 实测**无任何组件订阅 `evtSeq`**（全仓仅 store 内部读写）。所以它不触发重渲染，但会让 zustand 对**每个已订阅组件**重跑一次 selector。token 频率下是纯浪费。→ 移到模块级变量 |
| 5.2 | 热路径反向扫描分配数组 | `store/wsHandlers/stream.ts:126,130`；`store/session.ts:530,562` | `[...s.items].reverse().find(...)`，`bash_chunk` 每次拷两遍。→ 反向 for 循环，或在 session 上记运行中 item 的下标 |
| 5.3 | `applyDelta` 内二次全表扫描 | `session.ts:343` → `:119` | 随 §2.1 的索引一起修 |
| 5.4 | `MsgRail` 每帧强制同步布局 | `components/chat/MsgRail.tsx:302,305` | layout effect 依赖新建的 entries 数组，10Hz 重跑，逐条 `querySelector` + `getBoundingClientRect`。→ 批量读进一个 rAF |
| 5.5 | Hub 页 `useMemo` 依赖整个 session | `components/main/AgentHubPage.tsx:72` | `s` 每帧换 → 行持续重建。→ 依赖 `[s?.subagents, hubMode]` |
| 5.6 | `MdSurface` 每次渲染重建 `plugins` | `MdSurface.tsx:308` + `fixStrongAutolink`（`:316`） | 与该文件自己 `:274-276` 的注释（要求引用稳定）矛盾。当前靠 `AssistantMsg` 的 memo 挡着，其他直接用 `MdSurface` 的 surface 会中招 |
| 5.7 | host 会话池无 LRU + 2s 全池轮询 | `host/session-poll.ts:13-14,25` | 池无上限，只有显式 RPC 才 delete；每 tick 对**每个**池内会话 `stat`。→ 空闲条目 LRU 驱逐 |
| 5.8 | `pendingWrites` 在 abort 时泄漏 | `host/translate.ts:20` | 模块级 Map，只在 `tool_execution_end` 清理；中断的 turn 每次可滞留 ≤2MB 原文 |
| 5.9 | stats 推送节流字段被跨 socket 共享 | `host/session-lifecycle.ts:453` + `session-snapshot.ts:234` | `entry.statsPushedAt` 是单字段：本地 + 远程同时连上时，先到的 socket 吃掉节流名额，**另一个永远收不到 stats**。这是正确性问题，顺带也是性能问题 |
| 5.10 | `notifyLastAt` 去重表永不清理 | `store/session.ts:294` | 量小，随进程生命期缓慢增长 |

---

## 6. 已经做对的（别重复劳动）

审计中确认以下优化**已经存在且合理**：

- **流式合并**：`session.ts:342-354`，100ms 窗口内就地改写、窗口关闭才换引用一次——思路正确，缺的是订阅粒度（§2.1）。
- **`openSessions` 上限 8 + LRU 驱逐**：`session.ts:149,199-206`。
- **shiki 高亮缓存**：`lib/highlighter.ts` 有 LRU（2M 字符上限）、并发请求合并、rAF + `setTimeout` 让出主线程、启动 idle 预热。质量高于一般项目。
- **viz-js 已是动态 import**：`MdSurface.tsx:129`。mermaid 照抄这个写法即可。
- **终端 / groupExpand 两条总线**：`store/terminal.ts:6-13` 无缓冲、按 id 过滤扇出、卸载时退订；`groupExpand.ts:8-18` 只在用户操作时 bump。设计干净。
- **git 走 async `Bun.spawn` 并带分级超时**：`host/git.ts:25-26`。
- **WS fan-out 只 stringify 一次**再分发给各 socket（`state.ts:213-218`），socket 数上限 2（本地 + 远程），无 per-client 重序列化。
- **重连后是整体重建而非追加**：`session.ts:793` 全量替换 `s.items`，不会重复累积。

---

## 7. 未验证 / 本次没做

- **没有做运行时 profiling**：没有 DevTools trace、没有火焰图、没有真实 token 频率采样。§3.1 的「4k token ≈ 4k 帧」是读码推断的量级，不是实测。**6.23 MiB 启动包在真机上折合多少 ms 未测**——本项目的资源走本地 asset 协议（不走网络），所以瓶颈大概率在**解析/执行**而非传输，但这个换算本次没有做。
- **体积归因已做，改动收益未做对照构建**：§1 的构成表来自 `vite build --sourcemap` + sourcemap 逐字节归因（归因完整，unmapped 0.01 MiB），这部分是实测；但「shiki 改动态后能省多少」需要真的改完再跑一次 `bun run ui:build` 对比。
- **`Bun.serve` 默认 `backpressureLimit` 行为未确认**：未读 Bun 版本文档，§3.2 的严重程度取决于部署版本的实际默认值。
- **未验证 N=1000 消息时的实际掉帧**：`content-visibility` 那条基于代码事实（确实没有挂载窗口化），性能数字未实测。
- **未触碰 `node_modules` 与上游 oh-my-pi 源码**：涉及底座行为的判断（如 SDK 实际 delta 频率）留给实机验证。

---

## 8. 建议的下一步

按投入产出排：

1. **给 `session.ts` 加 `sessionId → path` 索引 + 收窄订阅**（§2.1/2.3/2.4）——单点改动，解锁其余多项。
2. **`renderItems` 套 `useMemo` + 补行组件 `memo`**（§2.2，注意标量 props）。
3. **host 侧 delta 合并 + 背压**（§3.1/3.2）。
4. **`LANG_MODULES` 改动态 import**（§4.1，预期是单笔最大体积收益，占启动包 42%）；改完跑 `bun run ui:build` 对比 `app.js`，把结果回填本节。
5. **设置外壳 / stats / 右栏终端 tab 改 `React.lazy`；mermaid 照抄 viz-js 的动态写法**（§4.2/4.3）。
6. 事件循环内的 2MB 同步读改 `fs.promises`（§3.3）。
7. P2 逐条清理。
8. 收尾时把 `chunkSizeWarningLimit` 降回有意义的量级（§4.5）。

---

## 附：复现本次测量

```powershell
# 启动闭包（静态 import BFS）
bunx vite build; # 或 bun run ui:build
# 逐字节归因
bunx vite build --sourcemap
# 再用 @jridgewell/trace-mapping 按 sourcemap 行内列区间归属到源模块，按包聚类
```

> 归因脚本本次写在临时目录（`$env:TEMP`）执行，**未入库**；如需长期复用再考虑挪进 `scripts/`。
