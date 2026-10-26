# UI 优化计划：移植 Claude Design System 手感（基于 open-claude-ui 调研）

> 调研日期：2026-10-17。调研对象：`/Users/xys/Github/open-claude-ui`（CDS 逆向资料仓，数值以 `code-examples/cds-theme.css` 源码为准）。
> 本文档是实施计划 + 时点调研快照；分批实施，每批独立验证。

## 实施状态（2026-10-17 更新）

- **Batch 1–2 已完成**（动效/阴影 token 基座、全站 transition token 化、reduced-motion 全局化、spinner 收敛、孤儿 keyframes 清理、按钮/分段控件过渡、stats 半径冲突修复、shadcn 硬编码清理）。
- **Batch 3 已完成**（滚动图钉 150ms 闩锁 + 40px 容差 + 120px 跳至最新阈值、7 档渐隐 mask、思考折叠（流式互斥锁已按用户反馈撤销，思考中可自由折叠）、WebKit IME 500ms 守卫、tabular-nums）。用户真机走查已通过（2026-10-17）：浅色主题 OK；顶部羽化×sticky 气泡、底部双重羽化两权衡项观感 OK，不修。
- **Batch 4–6 大部分完成**：IME 守卫、tabular-nums、阴影 token 化、ring-pop 走 `--shadow-popover`、Composer 三态投影、`.seg` 磁吸、右栏 StartPage 卡片 hover 物理。未完成：暗色边框 inset 内高光翻转（Batch 5 重项）、发丝线仅做了 controls 局部、iframe 指针护盾（无现成分栏拖拽场景）、4px 拖拽死区（侧栏已有 5px 阈值，满足）。
- **第二批已完成**（2026-10-17，两个并行 subagent + 主会话收尾）：按压弹簧落地（`.save-btn/.confirm-btn/.plus-btn/.icon-btn/.add-btn` 按下 scale .975 + 15 阶 `--spring-press` 回弹）；用户气泡 msgIn 入场（assistant 消息流结束瞬间 tail→commit 换节点会重播，评估后只挂用户气泡）；侧栏 `.seg` 纯几何滑块（`--seg-i/--seg-n` 变量 + `::before` 磁吸，TSX 按 viewMode 写变量）；边框交互态全站转 inset 环（15 文件，transparent border 占位零几何漂移，含 `.rt-item` outline→环统一）；2dppx/3dppx 发丝线块全站扩展（86 条 spread 声明）；`.inp` focus 环转 inset（主会话收尾）；浅色主题与滚动羽化权衡项用户走查通过，不修。浏览器验证：seg 滑块几何逐值正确（(154-2)/3 分槽）、变量注入正确、spinner 豁免正确；验证浏览器 `prefers-reduced-motion: reduce` 下 transition 被全局降级压制属预期。
- 第二批遗留（2026-10-17 收尾批处理）：~~`.q-btn` 按压~~ 已补（20px 小钮 scale .9 更紧的挤压）；~~`#composer.in-welcome:hover` border-color~~ 已转 inset 环（含深浅双主题与发丝线）；`stats-port.css` 的 `.segmented` 不升级——它隶属 stats-port 独立设计体系（#pg-stats 私有 token 前缀），单控件迁移会破坏该体系内部一致性，全量并入已在此前评估放弃。
- **Batch 7 已评估，整批跳过**（2026-10-17）：①暗色字重逆补偿——可选字体列表（PingFang/宋体/楷体/黑体/SF Mono）均非可变字体，465/560/660 在非可变字体上快照或合成劣化，仅默认 SF 栈受益，探测不通过按预案跳过；②行高推导间距——消息区为回合分隔式布局（90px/35px/22px 均为带注释的刻意值且含 margin 折叠语义），CDS 的 leading×0.75≈14px 紧凑间距与本服设计风格冲突，替换即视觉回归；③密度双模——无用户诉求，按预案不启动。
- **收官回归**（2026-10-17）：`bun run check` 全绿 + ui:typecheck + ui:build；浏览器预览实测滚动闩锁、渐隐 mask、卡片定位（逐像素一致）、spinner 豁免。事故链 BUG-079（设置标题歧义 + 0.01ms 时长覆写钉死坐标）已修复并记账。

## 0. 决策（已确认）

1. **强调色保持 VSCode 蓝** `--accent #4a9eff`：CDS 陶土橙 `#d97757` 不进入 omp。陶土相关「氛围感」动效（呼吸灯、暖光晕）一律用 `--accent` 色系推导；`--orange` 仅维持既有状态色语义。不改动根 AGENTS.md 的 VSCode 对齐声明。
2. **移植的是「交互物理」而非「配色」**：CDS 2.0 中性底色已主动去黄向 VSCode 靠拢，表面阶梯、圆角、密度与 omp 现状兼容；真正可移植资产是动效 token、滚动图钉、IME 守卫、暗色细节（字重补偿/边框内高光/发丝线）。
3. **一批一验**：每批做完必须 `bun run ui:build` + `ui:typecheck` + `bun run check` 全绿 + 真机冒烟（`bun run dev` 走查改动面），再进下一批。

## 1. 现状痛点（调研证实，按置信度排序）

| # | 痛点 | 证据 |
|---|---|---|
| P1 | 时长/缓动无 token：7 种时长（.12/.15/.18/.2/.22/.24/.3s）× 4 种写法（ease/ease-out/bezier(.2,0,0,1)/token）混用，同类控件跨文件时长不同 | 设置页 `.16s` vs 主区 `.15s` |
| P2 | 阴影 ~35 处 5 种配方无 token；圆角字面量 10 种 | tokens.css 无 shadow token |
| P3 | `rotate(360deg)` keyframes 重复 8 次；`ringpop` 与 `popIn` 语义重叠 | animations.css + boot/stats-port/stats |
| P4 | `prefers-reduced-motion` 仅 4 个文件响应；`html[data-motion]` 双轨覆盖更窄 | 侧栏/菜单/消息展开全部不响应 |
| P5 | 浅色主题靠 60 处散点 `:is(light)` 覆写，新增组件易漏 | 23 文件 60+ 处 |
| P6 | stats 页第二套 token，`--radius-md:8px` 与全局 `--r-md:10px` 冲突 | settings/stats.css:45-68 |
| P7 | 流式滚动无「防抢夺」闩锁（需核对现有实现） | 无 150ms 冷却证据 |
| P8 | `transition: all` 3 处；TSX 内控件级硬编码颜色（switch thumb 等） | choice-pills/stream-node-item |

## 2. 分批计划

### Batch 1 — 动效 token 基座（纯新增，零视觉变化）

**目标**：全站动效有唯一 token 来源，后续批次全部改引用。

- `ui/css/global/tokens.css` 新增：
  - 时长：`--dur-fast:60ms / --dur-snap:120ms / --dur-base:200ms / --dur-sheet:300ms / --dur-slow:450ms`
  - 缓动：`--ease-swift(.16,1,.3,1) / --ease-expand(.19,1,.22,1) / --ease-enter(.22,1,.36,1) / --ease-overshoot(.34,1.3,.64,1) / --ease-pop(.34,1.56,.64,1)`
  - 弹簧：`--spring-press: linear(0,.2459,.6526,.9468,1.0764,1.0915,1.0585,1.0219,.9993,.9914,.9921,.9957,.9988,1.0004,1)`
  - 保留既有 `--spring`/`--swift` 作别名（指向新值），存量引用不炸。
- keyframes 去重：`rotate(360deg)` 收敛为单个 `--kf-spin`；`ringpop` 保留（语义已全站铺开，不动）。
- 修 P8：`transition: all` 3 处改为显式属性。
- **验收**：三个检查命令全绿；视觉零变化（纯等价替换）。

### Batch 2 — 动效统一与 reduced-motion

- 全站 transition 时长/缓动收敛到 Batch 1 token：`.15s+--swift` → `var(--dur-fast) var(--ease-swift)` 等映射表统一；消灭裸 `ease`/`ease-out`/`cubic-bezier(.2,0,0,1)` 字面量。
- **reduced-motion 全局化**：`@media (prefers-reduced-motion: reduce)` 一次性压掉全站非必要 transition/animation（白名单：opacity 类即时反馈可保留）；`html[data-motion="off"]` 与之一并处理，消除双轨。
- 按钮按压弹簧：`.save-btn/.confirm-btn/.plus-btn/.icon-btn` 的 `:active` 加 `scale(.975)` + `--spring-press` 回弹（100ms 进、弹簧出）。
- **验收**：全绿 + 逐面走查（设置页/主聊天/侧栏/右栏）确认无可见退化；`data-motion` 开关全局生效。

### Batch 3 — 滚动手感（流式输出信任问题）

- 消息区滚动图钉：40px 底部容差 + **150ms 用户滚动冷却闩锁**（用户上滚后 150ms 内禁止程序滚底）+ 距底 >120px 显示「回到底部」（现有回到底部按钮接此阈值逻辑）。
- 7 档非线性渐隐遮罩：聊天滚动容器顶/底 28px 羽化，`y≈x^1.5` 七档 alpha（0/#0d/#26/#4d/#80/#b3/#d9/100%），触顶/触底动态归零，遮罩切换 150ms 过渡。优先纯 CSS `animation-timeline: scroll()` + JS 兜底。
- 程序滚动一律 `behavior:'auto'`。
- **验收**：流式生成时上滚不被抢夺；走查遮罩在深浅主题无色阶断层。

### Batch 4 — IME 守卫与排版细节

- Composer IME 双层守卫核对：确认 `isComposing || keyCode===229` 已覆盖；补 WebKit `compositionend` 后 500ms 内吞一次 Enter 的守卫（BUGS.md 已记录该类问题）。
- `tabular-nums`：耗时统计、token 计数、diff 行号、倒计时类数字统一。
- 图标光学对齐：行内小图标 `vertical-align:-0.125em` 抽查修正（消息区/工具行）。
- **验收**：中文输入法候选态敲 Enter 不发送；数字列无抖动。

### Batch 5 — 表面与边框体系

- 阴影 token：`--shadow-sm/md/lg/popover/panel` 五档，替换 ~35 处字面量（含 ring-pop 的 `0 12px 32px`）；深浅双值。
- 边框 inset/outset 化：`.inp/.sel/.dock/.set-card` 等激活/聚焦态从 `border-color` 切换改为 `box-shadow: inset 0 0 0 1px`（0 重排），暗色下内高光翻转 `rgba(255,255,255,.10)`。
- 发丝线：`@media (min-resolution: 2x/3x)` 下 `--line` 相关 1px 降 0.5px/0.33px。
- 单闭合边框原则：新改组件执行（容器有边框则内部 chip 去边框）；存量只修明显双层边框处，不大面积返工。
- P6 修复：stats 页 `--radius-md` 改名 `--st-radius-md`（或并入全局档），消除冲突。
- **验收**：全绿 + 深浅主题走查描边一致性；`check-style-tokens` 无新硬编码。

### Batch 6 — 组件级改造

- Composer 三态投影：idle/hover/focus 三档阴影 + 描边强度，220ms `--ease-swift` 过渡。
- 思考折叠：CSS Grid `0fr↔1fr` 展开（消高度抖动）+ 生成中互斥锁（流式期间禁止折叠）。
- 分段控件 `.seg`：滑块 120ms 磁吸（`--ease-snap` 即现 `--spring` 值）。
- 代码块：12px 圆角统一、复制按钮 2.5s 衰减状态机（现 2s 则对齐）。
- 拖拽 4px 死区：侧栏会话重排 / 右栏分栏（若存在 pointer 拖拽）统一死区；iframe 预览（Browser 标签）拖拽时 pointer-events 护盾。
- 卡片 hover：`-1.5px` 上浮 + 阴影/描边强度升级，200ms `--ease-swift`（仅设置页卡片等有明确 hover 语义的承载体，遵守「无点击不挂 hover」红线）。
- **验收**：全绿 + 逐组件走查。

### Batch 7 — 暗色排版增益（视收益决定）

- 暗色字重逆补偿：暗色下 medium/semibold/bold 映射 465/560/660（受 `--ui-font` 可变字体支持度约束，不支持则跳过）。
- 会话间距由行高推导：`--chat-turn-gap = 行高×.75`、item-gap ×.5，替换消息区魔数间距。
- 密度双模（compact/comfortable）：仅当 Batch 2–6 完成后仍有明确诉求再做；属于新功能面，需设置页入口。
- **验收**：全绿 + 大字号（设置页调最大字号）走查无折行/溢出。

### Batch 8 — 收尾

- 动效 token 指针已归位：SSOT 在 `ui/css/global/tokens.css`，全站约定在 `docs/systems/ui-conventions.md` §2（新增动效必须用 token，禁止新裸时长字面量）；考虑 `check-style-tokens.mjs` 增加时长/缓动字面量棘轮。
- 全量回归：`bun run check` + `ui:build` + `ui:typecheck` + dev 冒烟全页面走查。
- 本文档状态置「已实施」，保留作调研快照。

## 3. 明确不做

- 不换强调色/品牌色，不引入陶土橙 token，不改 shiki 主题。
- 不改 `--base/--card` 等表面主色（CDS 表面阶梯与 VSCode Dark+ 差异 <2%，不值得全站换肤风险）。
- 不做 Web Audio 提示音、语音波形、媒体 Lightbox（omp 无对应功能面）。
- 不返工全部存量组件的视觉，只修痛点清单 P1–P8 及批次内点名处。
- 触控 44×44 命中区负边距补偿：桌面键鼠应用，暂不需要。

## 4. 风险与依赖

- **级联顺序**：`style.css` @import 顺序即级联，新增 token 文件或调序须验证渲染等价；优先在既有 `tokens.css` 内追加而非新建文件。
- **批次 2  diff 大**：~140 处 transition 声明收敛，须按域（global→shared→main→settings）分子提交，每子提交走查。
- **字重补偿（Batch 7）**：依赖可变字体，系统字体回退栈可能无 wght 轴；做前先探测，探测不通过整批跳过。
- **数值漂移风险**：open-claude-ui 内部存在版本矛盾（呼吸 2.4s vs 3s、渐隐 24 vs 28px），一律以 `cds-theme.css` 源码值为准（3s / 28px）。
