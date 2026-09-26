# IMPLEMENTATION_PLAN:消息流虚拟化(#stream 窗口化渲染)

状态:待实施(等待指令后在独立 worktree 执行)。完成后本文件删除。

## Context

omp-desktop 消息流目前全量渲染:`ui-src/components/chat/items.tsx` 的 renderItems 把 `openSessions.get(activePath).items` 全部映射为真实 DOM,长会话(数百条,含 diff/终端输出)滚动卡顿、重渲染开销大。
目标:把 #stream 改为窗口化——只渲染视口 ± overscan 的行,滚动几千条保持流畅;参照 ZCodium(~/Github/ZCodium,`@tanstack/react-virtual` + 行高缓存 + 数据索引 find)的模式,落到本仓现有 TSX + zustand + streamdown 栈上。
行为零变化:stickBottom、⌘F 查找、MsgRail、LoopGroup 展开、切会话落底语义全部保持;WS 协议与 store 写入路径不动。

现状关键事实(已核实):items 只在尾部追加与原位拷贝替换(`store/session.ts` 的 updateSession/patchSessionItem,items.slice() 换引用),流式文本只进 `assistantDraft`(100ms 合帧),定稿才入 items;渲染 key 为 index 型,FindBar/MsgRail 以 `data-fk` 属性 ↔ index 为契约直接 querySelector/scrollIntoView;railEntries 在 renderItems 渲染期副作用收集;除 Composer 外消息行无 ResizeObserver。

## Approach

### P0 闸门与依赖

1. 前提:当前 main 工作区分支存在未提交改动,为避免同组文件冲突,虚拟化特性在独立 worktree(`omp-desktop-virtual-stream`,基线切自 `origin/main` 干净提交 `b75256a`)上独立实施。
2. `bun add @tanstack/react-virtual`(唯一新依赖)。

### P1 行模型(纯函数,行为等价重构)

1. 新建 `ui-src/components/chat/rowModel.ts`:导出 `buildRows(s: OpenSession): { rows: ChatRow[]; rowKeyToIndex: Map<string, number>; railEntries: RailEntry[] }`。
   - 把 `items.tsx` renderItems 中的**分组决策**原样搬入:连续编辑合并「更改」组、连续读取「查阅」组、「终端」组、「设备」组的成组规则,steer 待消费气泡后置行,TurnActs 尾挂行,保持与现状逐行等价(顺序、内容、组边界)。
2. `ChatRow` 形状:
   `{ key: string; kind: 'item'|'group'|'steer'|'turnacts'; items: ChatItem[]; pfx: string }`
   - key 固定为 `${kind}:${首条 item 在 items 中的 index}`(例如 `item:0`, `group:3`, `turnacts:12`)。
   - `buildRows` 建立映射表 `fkToRowIndex: Map<string, number>`,供 FindBar 与 MsgRail O(1) 反查。
3. `railEntries` 收集改为在 `buildRows` 中纯数据派生(消除 renderItems 渲染期副作用),每个 entry 保留 `{ key, role, text, rowIndex }`,字段与现状一致。
4. 等价性锚:preview 样本下 `buildRows(items)` 的行序列(kind/首 index/条目集合)与现状 renderItems 输出一一对应。

### P2 虚拟化宿主与布局规整

1. 新建 `ui-src/components/chat/rowHeightCache.ts`:
   - `TimelineRowHeightCache` 类,`Map<string, number>` 行高缓存,默认估计 64px,LRU 上限 2000;
   - 接口 `estimate(key, fallbackPx)` / `set(key, h)` / `clear()`,会话切换时清理。
2. `Chat.tsx`:#stream 下设立虚拟列表总容器,类名 `.stream-virtual-box`。
   - **布局契约继承**:总容器承载原 `#stream > *:not(.scroll-bottom)` 的列宽与居中约束:
     `max-width: min(var(--col-max, 50vw), max(calc(100% - 150px), min(var(--col-max-35, 35vw), calc(100% - 40px)))); margin-left: auto; margin-right: auto;`
     确保虚拟行宽度与底部输入框对齐。
   - 接入 `useVirtualizer({ count: rows.length, getScrollElement, getItemKey: i => rows[i].key, estimateSize: i => cache.estimate(rows[i].key), overscan: 8, measureElement })`;`measureElement` 回写缓存。
3. **渲染迁移与间距契约(修复 Margin 塌陷失效与测高溢出)**:
   - 虚拟行外层包装 `.stream-row`(绝对定位 `top: 0; left: 0; width: 100%; display: flow-root; box-sizing: border-box`)挂载 `ref={virtualizer.measureElement}` 与 `data-index`、`data-row-key`、`data-fk`。
   - `display: flow-root` 建立独立 BFC,杜绝子元素 margin 溢出导致容器测高偏小、上下行重叠。
   - 垂直外边距规范:在 `.stream-row` 上通过 CSS 或微调消除行间 margin 重叠差异(例如给 `.stream-row` 内的 `.msg`/`.act` 设置规范化的上下间距),使视觉间距与原普通流塌陷后效果像素级对齐。
4. **live tail 拆出虚拟列表**(参照 ZCodium `conversationTimelineLiveTail.ts`):
   - 流式尾巴——`assistantDraft` 纯文本尾巴、`WorkSec`、`ChatLoading`、`#stream` 内 `.scroll-bottom` 按钮——保持 normal flow,挂在虚拟列表容器之后;它们不进 rows、不进缓存。
5. **高度变化重测与动画平稳**:
   - 行外层挂载 `measureElement`,依赖原生 ResizeObserver 自动重测。
   - 对 `LoopGroup` 展开/收起等带过渡动画(0.3s)的组件,在动画完成时(`transitionend` 或 310ms 延时)触发最终校准,防止首帧 0fr 误报引起整体列表抖动。
6. `parts.tsx` 的 `patchActiveItem`/`patchGroupSub` 路径不动(拷贝替换后仅受影响行的 row 引用变化)。

### P3 stickBottom 贴底适配

1. 保留语义:120px 容差、渲染前记录贴底、`useLayoutEffect` 在 paint 前落定、切会话强制落底(现 Chat.tsx 逻辑)。
2. **全周期贴底跟随**:
   - 监听依赖包含 `[s?.items, s?.assistantDraft, s?.streaming]`;
   - 若处于贴底状态(`atBottom.current === true`):
     - 行数增加时调用 `virtualizer.scrollToIndex(rows.length - 1, { align: 'end' })`;
     - 在流式文本 `assistantDraft` 增量输出期间(rows.length 不变但 tail 高度增长),同步校正 `el.scrollTop = el.scrollHeight`,确保流式打字与历史追加均平滑钉底;
   - 未贴底时不打断用户主动滚动。

### P4 FindBar(⌘F)定位适配

1. `buildFindIndex` 不动(数据索引,递归 loop 子项)。
2. `gotoMatch` 跨视口精确定位机制:
   - 命中 item → 在 `fkToRowIndex` 中定位所属 ChatRow 及 rowIndex → 先展开 LoopGroup 祖先;
   - 调用 `virtualizer.scrollToIndex(rowIndex, { align: 'center' })`;
   - 为克服 React 19 远距离虚拟行 commit 渲染延迟,FindBar 设置待定位 key(`pendingScrollKey`),行组件挂载时或在短轮询(50ms/次,上限 500ms)检测到真实 DOM 就位后执行 `scrollIntoView({ block: 'center' })` 与 `flashFindTarget`,不再依靠死板的 2 次 rAF。

### P5 MsgRail 刻度适配

1. **刻度排布彻底解耦真实 DOM**:
   - `MsgRail.tsx` 彻底移除 `streamEl.querySelector('[data-fk="..."]')` 检查;
   - 刻度纯由 `userEntries` 数据按 `startTop + i * pitch` 进行数学几何放置,视口外条目的刻度 100% 完整显示;
2. **点击跳转**:
   - 刻度点击直接取 entry 中保存的 `rowIndex`(或根据 key 查表),调用 `virtualizer.scrollToIndex(rowIndex, { align: 'center' })`;
   - hover 连续山峰动画与 150ms 弹卡机制保持不变。

### P6 行级 memo

1. `AssistantMsg` 已 memo;其余行组件(ToolRow/parts 各 Row/LoopGroup 等)统一包 `React.memo`,props 以 ChatRow 为单位——rowModel 用 `useMemo([s?.items, s?.steerPending, s?.streaming, s?.assistantDraft])` 派生,patchSessionItem 换引用时只重渲染对应行与总容器几何。

## Critical files & anchors

- `ui-src/components/chat/rowModel.ts` — 新建,行模型提取。
- `ui-src/components/chat/rowHeightCache.ts` — 新建,行高 LRU 缓存。
- `ui-src/components/chat/items.tsx` — renderItems 抽离与兼容。
- `ui-src/components/Chat.tsx` — #stream 虚拟化容器、stickBottom 贴底校正、live tail 布局。
- `ui-src/components/chat/FindBar.tsx` — 待定位 key 与异步挂载 flash 适配。
- `ui-src/components/chat/MsgRail.tsx` — 刻度移除 DOM querySelector、切为行号跳转。
- `ui-src/components/chat/LoopGroup.tsx` — 动画测高与展开回调。
- `ui/style.css` — `.stream-virtual-box` 与 `.stream-row` 的 BFC/间距规范。

## Verification(阶段目标/成功标准)

1. `bun run ui:typecheck` 绿 + `bun run ui:build` 出 `ui/dist`。
2. `bun run check` 原样绿(host 未动)。
3. `bun run smoke:react` 绿,并新增断言:preview 注入 300 条样本后,`#stream` 直接子节点数 < 50(窗口化生效的可观测证明)。
4. 人工(`bun run ui:dev` → http://localhost:5173/ui/index.html?preview=1):
   - 长样本滚动流畅,滚动到底按钮贴底;
   - ⌘F 命中视口外条目 → 自动展开祖先 → 跳转居中 + 闪烁;
   - MsgRail 视口外刻度完整可见,点击刻度居中、hover 弹卡正常;
   - LoopGroup 展开/收起后滚动位置不跳动;
   - 贴底时流式输出持续平滑跟随;滚到中部时输入不打断;切会话强制落底。
5. 真机端到端:`bun run host` + `bunx tauri dev`,新会话发消息流式输出贴底跟随,`!ls` bash 行渲染正常。
6. 性能对照:同一长会话下 devtools 测量 #stream 子节点数(改前=全量,改后≈视口行数+overscan ≤40),记录数字在交付说明里。

## Assumptions & contingencies

- 时序:虚拟化在独立 worktree 执行,完成后合并回主分支。
- key 稳定性回退:若实施中发现 items 存在中间插入/重排路径(如回滚、重放),`ChatItem` 加稳定 `id: string` 字段(生成点在 store 写入侧),row key 改用 id;否则维持 `${kind}:${firstIdx}`。
- 行高重测回退:若 react-virtual 对行内展开/流式长高的自动重测不生效且显式 measureElement 也无效,退化为展开/收起时 `virtualizer.measure()` 全量重测(性能略差,行为等价)。
- estimate 值 64px 是按现有工具行/消息行高度的初值;若首屏滚动条跳变明显,调至实测中位数(只改 rowHeightCache 默认常量)。
- ZCodium 参照物以 ~/Github/ZCodium 当前 HEAD 为准。
