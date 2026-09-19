# AGENTS.md

## 底层源码引用

- **底座 oh-my-pi 源码位置**：`/Users/xys/Github/oh-my-pi`
- **角色定位**：本应用是基于 oh-my-pi 的桌面客户端，采用库内嵌架构，在单一 Bun 宿主进程内通过 `@oh-my-pi/pi-coding-agent` SDK 持有和驱动所有 AgentSession。涉及底座核心行为、会话生命周期、Agent 运行时、模型目录（catalog）及工具执行机制时，请直接参考 `/Users/xys/Github/oh-my-pi` 源码。

## 项目架构

1. **Tauri 桌面外壳 (`src-tauri/`)**：
   - 管理原生窗口、原生菜单、macOS 交通灯（titleBarStyle: Overlay, x: 16, y: 18）。
   - 负责启动和管理 Bun 宿主进程（`host/host.ts`），并向前端传递 WebSocket 动态端口。
2. **Bun 宿主进程 (`host/host.ts`)**：
   - 共享底座（authStorage / modelRegistry / settings）。
   - 管理会话池 `Map<sessionId, PoolEntry>`，对接 `@oh-my-pi/pi-coding-agent` SDK。
   - 通过 WebSocket 向 UI 提供双向 RPC 协议（会话创建/加载、模型切换、分支查询与切换、权限模式、Git diff 等）。
3. **Web 前端 (`ui/`)**：
   - `ui/index.html`、`ui/style.css`、`ui/app.js`、`ui/icons.js`（图标注册表）、`ui/fa-icons.js`（FA 图标生成物）。
   - 纯原生现代 Web 技术栈，不依赖繁重前端打包框架。

## 开发与行为规范

1. **中文规范**：所有思考、分析、解释和代码注释均使用中文。
2. **机器资源安全红线**：禁止裸跑 vitest / 多包并发测试；所有测试必须带单 worker 池参数。
3. **输出风格 (ADHD Mode)**：
   - 第一行必须是可直接执行的命令、路径或代码片段。
   - 多步任务清晰编号，结尾给出 2 分钟内可完成的单一具体操作。
   - 严禁空话、客套话与无意义的铺垫。
4. **外科手术式修改**：只做解决当前问题所必需的修改，不做过度推测性设计，保持既有代码风格。

## 设置页一致性规范（最高优先级 UI 约束）

所有设置页面（`pg-*`）的**风格、按钮、高度、动画、颜色、交互逻辑**必须尽量保持一致；给某个设置页加/改控件时，先找全站既有语言复用，禁止该页另起炉灶：

1. **控件 → 既有语言**（改样式 = 改全站基类，不是在页面里写私有覆盖）：
   - 刷新按钮：统一 `class="icon-btn pg-refresh"` + `<span data-icon="refresh" data-size="17">`（31×31 底板；**禁止用 FA 实心 `rotateRight`**，实心块视觉上像常亮高亮）。点击旋转反馈走 `.pg-refresh.spin`。
   - 新建/添加按钮：`.add-btn` 语言（透明底 + `--line` 描边 + r8 + hover `--panel-2`），高度一律 31px，与刷新钮同高。
   - 开关 `.tg`、下拉胶囊 `.sel`、输入框 `.inp`（r9 + 蓝色聚焦光晕）、弹窗/延展区按钮 `.confirm-btn`（危险操作 `.danger`）、图标小按钮 `.plus-btn`、分段选择 `.mcp-type-pill` 胶囊。
   - 行内展开编辑：一律走记忆页 `.mem-expand` 向下延展模式（行 `.on` 高亮 + caret 旋转 + popIn），**不用模态弹窗**。
2. **一级大标题**：`.set-tt` 语言 —— `calc(var(--ui-fs) * 1.75)`、font-weight 500、标题后首元素间距 29px（skills/MCP 页标题容器 margin-bottom 25px）。
3. **颜色只用 token**（`--panel-*`/`--line*`/`--accent`/`--err`/`--green`…），禁止硬编码十六进制；hover 底板 `--panel-2`、行 hover 用 `.srow` 同款 2.5% 微高亮。
4. **图标尺寸/风格**：同语义控件跨页取同一图标、同一 `data-size`；新增图标进 `ui/icons.js` 注册表（FA 是实心块时优先手写线条版，如 `refresh`）。

## 图标系统

1. **结构**：
   - `ui/icons.js`：图标注册表与取用入口。自定义图标（目前仅 `logo`）直接写在 `ICONS` 里；末尾 `Object.assign(ICONS, FA_ICONS)` 让 Font Awesome 层同名覆盖。
   - `ui/fa-icons.js`：**自动生成，禁止手改**。由 `.local/build-fa-icons.py` 从本机 `/Users/xys/Github/Font-Awesome` 提取（FA Free 7.3.1，图标 CC BY 4.0）。
   - `.local/`：本地开发脚本目录，不入库（`.gitignore` 已排除），用法见其 `README.md`。
2. **取用规则（禁止内联 SVG 字面量）**：
   - JS 中：`icon("folder")` / `icon("caret", 12)`——第二个参数覆盖尺寸，viewBox 不变。
   - HTML 中：`<span class="..." data-icon="folder" data-size="23"></span>` 占位；`hydrateIcons()`（app.js 启动时）替换为 svg 并复制占位元素上的 `class` / `id` / `style`。
   - 动态图形（ctxRing 进度环、trend/donut 图表）不是图标，仍在 index.html 内联。
3. **新增/换图标**：改 `.local/build-fa-icons.py` 顶部 `MAPPING`（注册表名 → FA 子目录/图标名/尺寸），跑 `python3 .local/build-fa-icons.py` 重新生成。FA 没有的自定义图标才写进 `ui/icons.js`。
4. **方向与状态语义**：
   - 可展开尖角一律用图标（`caret` 系列），方向与弹出方向一致：向上弹出的菜单（输入区各胶囊）默认尖角朝上、展开时旋转 180°；向下弹出的（`.sel` 下拉）默认朝下、展开时旋转。
   - 展开/收起类图标要随状态切换（如边栏开关 `collapseLeft`/`collapseRight`），在对应的 setter 里 `btn.innerHTML = icon(...)` 同步替换。
   - 主对话区展开图标原地旋转（思考行 chevron 转 90°、工具行 `.ed-arrow` 转 90°、changebar `#chv` 转 180°），禁止换元素。
5. **加载顺序**：`index.html` 按 `vendor → fa-icons.js → icons.js → app.js` 依次引入，不可调换（icons.js 依赖 FA_ICONS）。

## 弹出卡片设计规范（ring-pop 系）

所有「锚点 hover 弹卡」（上下文明细卡及后续同类卡片）必须共用同一套设计，基类为 `.ring-pop`（`ui/style.css`），不得另起炉灶：

1. **容器样式**：背景 `var(--ctl-bg)`、1px `var(--line)` 边框、圆角 `var(--r-md)`、阴影 `0 12px 32px rgba(0,0,0,.5)`（浅色主题降透明度至 `.18`，用 `[data-theme="light"] .ring-pop` 覆盖）、内边距 `12px 12px 14px`、`min-width: 192px`、字号 `var(--ui-fs-base)`、正文色 `var(--dim)`、标题 `<b>` 为 `var(--text)` + `font-weight: 500`。
2. **弹出动画**：统一使用 `animation: ringpop .18s ease-out`（`@keyframes ringpop`：淡入 + 自上方 6px 上滑归位），禁止瞬显或其他入场动画；卡片自身的变体样式挂在叠加类上（如 `.rail-pop`），动画不重定义。
3. **定位**：`position: fixed; z-index: 110`，坐标一律经 `placeMenu()` 写入（内部除以 `zoomLevel` 补偿界面缩放）；弹出位置贴在锚点旁（上下文明细卡在环正上方 7px），边缘距视口至少 8px。
4. **交互闭环（hover 宽限模式）**：锚点 `mouseenter` 不立即弹卡——先起 150ms 悬停定器，鼠标停够才弹出（划过不打扰），提前离开则取消；锚点 `mouseleave` 时不立即收卡——朝卡片方向离开则启动 200~250ms 宽限定器，途中有 `relatedTarget` 进入卡片则取消；卡片自身 `mouseenter` 取消关闭、`mouseleave` 关闭。悬停期间数据到达只重绘内容，不重建锚点（「移开即弃」策略）。
5. **内容结构**：卡片头一行（标题 + 右侧辅助信息，如百分比），正文摘要式呈现（长文本截断 + `pre-wrap`），单行数值布局沿用「值 | 百分比」竖线分隔右对齐（`.cx-val`/`.cx-sep`/`.cx-pct` 同款）。
6. **参考实现**：上下文明细卡见 `ui/app.js` `buildCtxCard()`/`mountRingPop()`。
