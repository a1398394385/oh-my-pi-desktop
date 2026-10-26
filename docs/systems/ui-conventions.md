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
3. **颜色只用 token**（`--panel-*`/`--line*`/`--accent`/`--err`/`--green`…），禁止硬编码十六进制；hover 底板走 `--hover-fill`（见 §6），行 hover 用 `.srow` 同款 2.5% 微高亮。
4. **图标尺寸/风格**：同语义控件跨页取同一图标、同一 `data-size`；新增图标进 `ui/icons.js` 注册表（FA 是实心块时优先手写线条版，如 `refresh`）。
5. **整页按钮风格统一**：同一页面（含其弹层/详情视图）内所有按钮必须复用同一尺寸体系的既有类，禁止混排不同大小的按钮——工具行/卡片头部一律用小号 `.save-btn`（危险操作 `.danger` 变体 hover 变红），大号 `.confirm-btn`（及 `.danger`）只用于弹窗与延展区底部操作行，`.add-btn` 31px 用于页级新建。往页面里加按钮先看同页/同类页已有按钮的高度与 padding，取同一类。
6. **交互反馈约束（全站通用）**：**没有点击反馈的位置，不允许触发 hover 高亮**——hover 高亮是「可点」的 affordance，只能挂在有点击行为的元素上。行内只有局部控件可点时（如角色行的胶囊/删除按钮），高亮只挂控件、不挂承载行；`.srow` 的默认行 hover 仅用于整行可点的列表（记忆/技能行），纯展示承载行必须显式关闭——用更高特异性 `.srow.xxx-row:hover { background: none }`（`ui/css/global/controls.css` 里 `.srow:hover` 的位置可能在覆盖规则之后，同特异性会反杀），浅色主题规则一并覆盖。
7. **卡片行统一 `.set-row`**：独立 `.set-card` 内的不可点行一律 `.srow.set-row`（标准行几何 13px 16px、关行 hover、ctl 右对齐、标题内 `.tag` 弹性排列，定义在 `ui/css/settings/common.css` 末尾）；**禁止**复用其他页面的上下文行类——模型页 `.mp-role-row` 是为其自带内边距的 `.mp-r` 面板设计的（2px 侧边距），挪进独立卡片内容会贴边。新设置页的行结构照抄 `CapabilityPage.tsx` 的 `Group` + `.srow.set-row` 组合。
8. **字号按位置分档**（除代码档外全部随 `--ui-fs` 等比缩放，用户调「界面字号」时同步变化）：

   | 位置 | 档位 |
   |---|---|
   | 页面一级大标题 `.set-tt` / `.skills-tt` / `.mcp-tt` | `calc(var(--ui-fs) * 1.75)`（同本节第 2 条） |
   | 行内编辑标题 `.set-edit-title` | `calc(var(--ui-fs) * 1.5)` |
   | 行标题 `.srow-tx b` | `--ui-fs-base` |
   | 行描述 `.srow-tx span` | `--ui-fs-sm` |
   | 徽标 `.tag` / `.stag` / `.mcp-server-badge` / `.skill-provider-tag` | `--ui-fs-xs` |
   | 导航分组标题 `.set-sec` / 搜索区小字 | `--ui-fs-xs` / `--ui-fs-sm` |
   | 控件内文字（`.inp` / `.save-btn` / `.add-btn` / `.sel` / `.menu .mi`） | `--ui-fs-sm` |
   | 额度卡头 `.lx-head` / 数值 `.lx-mid` | `--ui-fs-md` / `--ui-fs-lg` |
   | 记忆文档 h1 / h2 / h3 | `calc(var(--ui-fs) * 1.3)` / `--ui-fs-lg` / `--ui-fs-md` |
   | 代码块 / 行内 code | `var(--code-fs)`（跟随「代码字号」偏好，回退 12px） |

   1. **同一位置只有一个档位**：行标题里的徽标必须写 `.srow-tx .tag`——`.srow-tx span`（0,1,1）会压过 `.tag`（0,1,0），只写 `.tag` 不生效。
   2. **固定几何元素不参与分档**：键帽 `.sc-key`（height 22px / min-width 24px）、ⓘ 字形 `.mcp-err-icon`（图标尺寸非字号）保留固定 px。
   3. **下拉触发器与菜单项必须同档**：菜单 portal 到 body、不在触发器子树内，需各自声明（`.sel` 与 `.menu .mi` / `.menu .mi .mi-tt` 成对改，否则出现「菜单项比触发器大」的倒挂）。
   4. **例外**：需要保留 base 档的下拉加 `.sel-base`，其 portal 菜单同步加 `.mp-menu-base`。
   5. **不适用**：`#pg-stats` 统计页有独立字号体系（固定几何 + 独立刻度），不按本条分档。
9. **创建/编辑表单**：标签与控件统一使用 `FormRow` / `.frm-rows`；仅把同级、短文本或短枚举字段放进 `.frm-pair`（如 MCP 传输协议＋共享模式），容器不足时由共享 CSS 自动回退单列。名称等短控件复用 `.mcp-inp-name` / `.frm-compact`，命令、URL、工具矩阵和 textarea 保持整行；字段动态说明必须留在所属控件列，禁止为凑双列移动或省略。内容较少的新建页可在 `.set-page` 上加 `.set-page-compact`，宽度上限 860px；编辑页与长文本、复杂配置页保持默认宽度。

## 2. 动效（全站）

1. **时长/缓动/阴影只走 token**：SSOT 在 `ui/css/global/tokens.css`——时长 `--dur-fast/snap/base/sheet/slow`、缓动 `--swift/--spring/--ease-expand/enter/overshoot/pop`、按压弹簧 `--spring-press`、阴影 `--shadow-sm/md/lg/popover/panel`（深浅双值；`--shadow-popover` 为 `none`，浮层只留自身 1px 边框，不叠投影）。新写 `transition` 禁止裸时长/缓动字面量（`@keyframes` 内部除外）；存量裸值收敛见 [ui-claude-optimization-plan.md](../ui-claude-optimization-plan.md)。
2. **spinner 统一**引用规范化 `@keyframes spin`（`ui/css/global/animations.css`），禁止新造 `rotate(360deg)` 等价 keyframes。
3. **reduced-motion 全局降级**已统一在 `animations.css`（`prefers-reduced-motion` + `html[data-motion="off"]` 同规则）：装饰性过渡/入场动画以 `animation/transition: none !important` 压制（**禁止用 0.01ms 时长覆写**——非零时长会激活默认 `transition-property: all`，引擎卡死 transition 会把 JS 定位的 fixed 浮层钉在旧坐标），**存活指示循环（spinner、呼吸点、骨架扫光）经 `:not()` 清单豁免保持转动**——该清单是语义的一部分，新增 `animation: ... infinite` 状态指示时须同步加入清单，勿当冗余清理。

## 3. 弹出卡片（ring-pop 系）

所有「锚点 hover 弹卡」（上下文明细卡及后续同类卡片）必须共用同一套设计，基类为 `.ring-pop`（`ui/css/global/overlays.css`），不得另起炉灶：

1. **容器样式**：背景 `var(--ctl-bg)`、1px `var(--line)` 边框、圆角 `var(--r-md)`、**不设投影**（`--shadow-popover` 已置 `none`：浮层自带 1px 边框，再叠投影会读成一圈模糊的晕边）、内边距 `12px 12px 14px`、`min-width: 192px`、字号 `var(--ui-fs-base)`、正文色 `var(--dim)`、标题 `<b>` 为 `var(--text)` + `font-weight: 500`。
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

## 5. 下拉与浮层底色（全局唯一档）

全站下拉只有一档底色，由 `--ctl-bg` 承担（定义在 `ui/css/global/tokens.css`）：

1. **底色 = `--ctl-bg` = `var(--inset)`**：深色 `#2B2B2B`（与输入框同层），浅色 `#ffffff`（继承 `--inset`）。所有下拉、弹层卡片（ring-pop 弹卡、tooltip、对话框、悬浮菜单）共用这一档，不存在第二种浮层底色。
2. **禁止页面私有底色**：下拉一律复用 `ui/css/global/controls.css` 的 `.menu` 基类与 `--ctl-bg`；Radix `SelectContent`（`ui-src/components/ui/select.tsx`）用 `bg-[var(--ctl-bg)]`。需要新下拉时加类，不要另写 `background`。
3. **行状态色在底色之上**：hover 与键盘光标行走 `--menu-hl`（下拉选项高亮，定义在 `tokens.css`：浅色 `#F0F0F0`、深色 `#363636`；青夜等自定义主题在各自主题文件里单独取值），与底色不同层，避免"行底色 = 面板底色"导致整行看不见（见 `ui/css/shared/model-picker.css`）。**composer 模型菜单与权限模式菜单的当前选中项不加底色**，只用 ✓ 勾选标记（设置页选择器仍用 `.on` 底色），避免静止选中态比 hover 更抢眼。
4. **原生 `<select>` 例外**：原生下拉弹层由系统绘制，无法改底色；应用内自绘下拉才是本节范围。

## 6. hover 底板（全局唯一档）

hover 底板走 `--hover-fill`（定义在 `ui/css/global/tokens.css`，默认 `var(--panel-2)`）：

1. **面上控件 = `--menu-hl`**：凡所在容器的底色是下拉底色（`--inset` / `--panel` / `--ctl-bg` 三者同值）——输入框、composer dock、下拉菜单、弹卡、输入类卡片——其上按钮（权限选择、computer use、模型选择、上下文明细环等）的 hover 底板必须是 `--menu-hl`，与该容器同属一个"档"。深色 `#363636`、浅色 `#F0F0F0`、青夜 `#56656E`；暖纸/珊瑚/深思在各自主题文件里取同族暖调值。
2. **面外控件 = `--panel-2`**：底色不是上述档的表面（侧栏行、设置卡片行、列表行）保持 `--panel-2`，用同一个变量的不同取值区分。
3. **写法**：`:hover` 规则里用 `var(--hover-fill)`，不要直接写 `var(--panel-2)`；Tailwind 侧用 `hover:bg-hover-fill`（`@theme inline` 已映射 `--color-hover-fill`）。
4. **作用域**：令牌按容器继承，所以给某个面声明 `--hover-fill: var(--menu-hl)` 时，其内部的子面必须自己显式声明（面用 `--menu-hl`，非面用 `var(--panel-2)`），否则会继承到不合适的档。`#pg-stats` 把内部 `--panel` 重定义为 `var(--panel-2)`，语义不同，已排除在统一之外。
