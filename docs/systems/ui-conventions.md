# UI 约定手册（设置页 / 动效 / 弹出卡片）

> 活文档：全站 UI 约定的 SSOT。登记见 [documentation.md](../documentation.md) §2「UI 约定手册」；根 [AGENTS.md](../../AGENTS.md) 只留摘要与指针。
> 视觉基准是 VSCode 源码（`/Volumes/MacApps/Github/vscode`）：深色对齐 Dark+、浅色对齐 Light+。做新 UI、改颜色、定义 token 前先查 VSCode 对应部件，抄其配色与层次，不另造风格。
> 颜色/组件定位事实以代码与 `ui/css/global/tokens.css` 为 SSOT；本手册只记"必须复用哪一个既有语言"。

## 0. VSCode 对齐（全站基准）

1. **颜色**：语义对照 VSCode 色板（编辑器面/侧栏面对应 `--card`/`--panel-*`，前景 `--text`/`--dim`/`--faint`，强调 `--accent`，行高亮/diff 底色参照 Dark+/Light+ 的 token 色）；禁止凭感觉配新色。
2. **代码染色**：shiki 主题固定 `dark-plus`/`light-plus`，随 `data-theme` 切换；消息体走 streamdown code 插件双主题、文件/diff 视图走 `ui-src/lib/highlighter.ts`。
3. **右栏三区结构**（`#right` 内部从上到下，每块通栏、左右零边距，整块边栏是一个整体）：
   - 第一区 tab 栏（`.sp-head`）；
   - 第二区 tab 专属操作栏（`.rb-head`：返回钮/全路径等，可无）；
   - 第三区详情区（`.rb-scroll` 滚动承载）。
   内容缩进走各块内部 padding（统一 8px），不在容器上加左右 margin。

## 1. 设置页一致性（最高优先级 UI 约束）

所有设置页面（`pg-*`）的**风格、按钮、高度、动画、颜色、交互逻辑**必须尽量保持一致；给某个设置页加/改控件时，先找全站既有语言复用，禁止该页另起炉灶。

1. **控件 → 既有语言**（改样式 = 改全站基类，不是在页面里写私有覆盖）：
   - 刷新按钮：统一 `class="icon-btn pg-refresh"` + `<span data-icon="refresh" data-size="17">`（31×31 底板；**禁止用 FA 实心 `rotateRight`**，实心块视觉上像常亮高亮）。点击旋转反馈走 `.pg-refresh.spin`。
   - 新建/添加按钮：`.add-btn` 语言（透明底 + `--line` 描边 + r8 + hover `--panel-2`），高度一律 31px，与刷新钮同高。
   - 开关 `.tg`、下拉胶囊 `.sel`、输入框 `.inp`（r9 + 蓝色聚焦光晕）、弹窗/延展区按钮 `.confirm-btn`（危险操作 `.danger`）、图标小按钮 `.plus-btn`、分段选择 `.mcp-type-pill` 胶囊。
   - 行内展开编辑：一律走记忆页 `.mem-expand` 向下延展模式（行 `.on` 高亮 + caret 旋转 + popIn），**不用模态弹窗**。
2. **一级大标题**：`.set-tt` 语言——`calc(var(--ui-fs) * 1.75)`、font-weight 500、标题后首元素间距 29px（skills/MCP 页标题容器 margin-bottom 25px）。
3. **颜色只用 token**（`--panel-*`/`--line*`/`--accent`/`--err`/`--green`…），禁止硬编码十六进制；hover 底板 `--panel-2`、行 hover 用 `.srow` 同款 2.5% 微高亮。
4. **图标尺寸/风格**：同语义控件跨页取同一图标、同一 `data-size`；新增图标进 `ui/icons.js` 注册表（FA 是实心块时优先手写线条版，如 `refresh`）。
5. **整页按钮风格统一**：同一页面（含其弹层/详情视图）内所有按钮必须复用同一尺寸体系的既有类，禁止混排不同大小的按钮——工具行/卡片头部一律用小号 `.save-btn`（危险操作 `.danger` 变体 hover 变红），大号 `.confirm-btn`（及 `.danger`）只用于弹窗与延展区底部操作行，`.add-btn` 31px 用于页级新建。往页面里加按钮先看同页/同类页已有按钮的高度与 padding，取同一类。
6. **交互反馈约束（全站通用）**：**没有点击反馈的位置，不允许触发 hover 高亮**——hover 高亮是「可点」的 affordance，只能挂在有点击行为的元素上。行内只有局部控件可点时（如角色行的胶囊/删除按钮），高亮只挂控件、不挂承载行；`.srow` 的默认行 hover 仅用于整行可点的列表（记忆/技能行），纯展示承载行必须显式关闭——用更高特异性 `.srow.xxx-row:hover { background: none }`（`ui/css/global/controls.css` 里 `.srow:hover` 的位置可能在覆盖规则之后，同特异性会反杀），浅色主题规则一并覆盖。
7. **卡片行统一 `.set-row`**：独立 `.set-card` 内的不可点行一律 `.srow.set-row`（标准行几何 13px 16px、关行 hover、ctl 右对齐、标题内 `.tag` 弹性排列，定义在 `ui/css/settings/common.css` 末尾）；**禁止**复用其他页面的上下文行类——模型页 `.mp-role-row` 是为其自带内边距的 `.mp-r` 面板设计的（2px 侧边距），挪进独立卡片内容会贴边。新设置页的行结构照抄 `CapabilityPage.tsx` 的 `Group` + `.srow.set-row` 组合。

## 2. 动效（全站）

1. **时长/缓动/阴影只走 token**：SSOT 在 `ui/css/global/tokens.css`——时长 `--dur-fast/snap/base/sheet/slow`、缓动 `--swift/--spring/--ease-expand/enter/overshoot/pop`、按压弹簧 `--spring-press`、阴影 `--shadow-sm/md/lg/popover/panel`（深浅双值）。新写 `transition` 禁止裸时长/缓动字面量（`@keyframes` 内部除外）；存量裸值收敛见 [ui-claude-optimization-plan.md](../ui-claude-optimization-plan.md)。
2. **spinner 统一**引用规范化 `@keyframes spin`（`ui/css/global/animations.css`），禁止新造 `rotate(360deg)` 等价 keyframes。
3. **reduced-motion 全局降级**已统一在 `animations.css`（`prefers-reduced-motion` + `html[data-motion="off"]` 同规则）：装饰性过渡/入场动画以 `animation/transition: none !important` 压制（**禁止用 0.01ms 时长覆写**——非零时长会激活默认 `transition-property: all`，引擎卡死 transition 会把 JS 定位的 fixed 浮层钉在旧坐标），**存活指示循环（spinner、呼吸点、骨架扫光）经 `:not()` 清单豁免保持转动**——该清单是语义的一部分，新增 `animation: ... infinite` 状态指示时须同步加入清单，勿当冗余清理。

## 3. 弹出卡片（ring-pop 系）

所有「锚点 hover 弹卡」（上下文明细卡及后续同类卡片）必须共用同一套设计，基类为 `.ring-pop`（`ui/css/global/overlays.css`），不得另起炉灶：

1. **容器样式**：背景 `var(--ctl-bg)`、1px `var(--line)` 边框、圆角 `var(--r-md)`、阴影 `var(--shadow-popover)`（token 自带深浅值，不要写浅色覆写）、内边距 `12px 12px 14px`、`min-width: 192px`、字号 `var(--ui-fs-base)`、正文色 `var(--dim)`、标题 `<b>` 为 `var(--text)` + `font-weight: 500`。
2. **弹出动画**：统一使用 `animation: ringpop .18s ease-out`（`@keyframes ringpop`：淡入 + 自上方 6px 上滑归位），禁止瞬显或其他入场动画；卡片自身的变体样式挂在叠加类上（如 `.rail-pop`），动画不重定义。
3. **定位**：`position: fixed; z-index: 110`，坐标一律经 `placeMenu()` 写入（内部除以 `zoomLevel` 补偿界面缩放）；弹出位置贴在锚点旁（上下文明细卡在环正上方 7px），边缘距视口至少 8px。
4. **交互闭环（hover 宽限模式）**：锚点 `mouseenter` 不立即弹卡——先起 150ms 悬停定器，鼠标停够才弹出（划过不打扰），提前离开则取消；锚点 `mouseleave` 时不立即收卡——朝卡片方向离开则启动 200~250ms 宽限定器，途中有 `relatedTarget` 进入卡片则取消；卡片自身 `mouseenter` 取消关闭、`mouseleave` 关闭。悬停期间数据到达只重绘内容，不重建锚点（「移开即弃」策略）。
5. **内容结构**：卡片头一行（标题 + 右侧辅助信息，如百分比），正文摘要式呈现（长文本截断 + `pre-wrap`），单行数值布局沿用「值 | 百分比」竖线分隔右对齐（`.cx-val`/`.cx-sep`/`.cx-pct` 同款）。
6. **参考实现**：上下文明细卡见 `ui-src/components/chat/CtxCard.tsx`（旧 `ui/ringpop.js` 的 ctxRing/buildCtxCard/mountRingPop 1:1 React 移植，含 150ms 悬停定器与宽限期逻辑）。

## 4. 新增 UI 的决策顺序

1. 先找全站既有语言（本节 §1–§3 与 `docs/systems/frontend.md` 的样式域）。
2. 需要新语言时，改全站基类（`ui/css/global/controls.css` 等），不要在页面里私有覆盖。
3. 颜色/动效只用 token；新增 token 先改 `tokens.css` 并同时给浅色值。
4. 改完跑 `bun run ui:build` + `ui:typecheck`，并按 [DEVELOPMENT.md](../DEVELOPMENT.md) 选真机通道走查。
