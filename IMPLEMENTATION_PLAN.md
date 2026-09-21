# ZCode 设计移植实施计划

来源仓库：~/Github/ZCode（React+Tailwind）；目标：本仓库 ui-src（React 19 + 手写 CSS）。
侦察报告：agent://ZIcons / agent://ZComposer / agent://ZSidePane / agent://ZBrowserTerminal / agent://ZDiff

## 成功标准（每阶段）

- `bun run ui:build` 通过；`bun run smoke:react` 全绿；改动提交。

## 阶段 1：全局图标（lucide 线条风替换 FA 实心层）

- 目标：图标注册表新增 lucide 风格线条 SVG（strokeWidth 1.5），替换 FA_ICONS 层中被引用图标的默认观感。
- 做法：写 `.local/build-lucide-icons.py`（或一次性脚本）从本机 lucide 包（~/Github/ZCode/node_modules/lucide-react 或 lucide 源码）提取我们实际在用的 ~40 个图标名（grep `icon("` / `data-icon` 全量收集）的 path 数据，生成 `ui/lucide-icons.js`（同 fa-icons.js 模式：name → svg 字符串，width/height 16 viewBox 24）；icons.js 末尾 `Object.assign(ICONS, LUCIDE_ICONS)` 置于 FA 层之上实现同名覆盖。
- 状态：✅ 已完成（2026-09-21）。新增 `ui/lucide-icons.js`（60 个用名，来源 lucide-static@1.17.0，经一次性脚本从 unpkg 拉取后改写 width/height=16、stroke-width=1.5）；`bun run ui:build`、`bun run smoke:react` 全绿。
- lucide 无对应图形、保留 FA/自定义层兜底的用名：`logo`、`termBox`（自定义终端外壳）；`refresh`/`stage`/`unstage`/`discard`/`stop`/`chevronUp`/`chevronDown`/`fork` 已是 feather 线条风，维持原样。
- 语义映射说明：`think`/`memory` → brain，`agents` → bot，`hook` → webhook，`skills` → sparkles，`plugins` → puzzle，`stats` → chart-column，`todo` → list-checks，`mcp` → plug，`commands`/`term` → terminal，`permAsk` → hand，`permDefault` → square-check，`scopeProfile` → circle-user，`read` → search（FA 原为放大镜），`shieldWarn` → shield-alert，`folderPlus` → folder-plus，`ftHtml`/`ftCss` → file-code、`ftJs` → file-json、`ftImg` → file-image。

## 阶段 2：输入区二级重叠卡片 + 加载转圈

- 目标 1（主页输入框）：欢迎页/新建会话输入框改成 ZCode 的「外层 contextHeader 卡 + 内层输入卡」叠卡视觉（rounded-2xl、shadow、负 margin 堆叠）。
- 目标 2（队列卡）：QueueCard 改成负 margin 堆叠（`z-0 -mb-N pb-N rounded-t-2xl` 被 composer `z-20` 压住），行内队列条目视觉对齐 ZCode ConversationQueuePanel。
- 目标 3（加载转圈）：流式中输入框上方显示 ChatLoading（lucide LoaderIcon + spin 动画），挂时间线最后一轮底部。
- 参考：packages/ui/src/v4/ConversationQueuePanel.tsx、ConversationComposer.tsx、components/ai-elements/chat-loading.tsx
- 状态：待实施

## 阶段 3：右栏复刻

- 目标：右栏改为 ZCode Side Pane 设计——h-12 tab 头（tab 总览 popover + 等宽 tab + 关闭）、可拖拽排序、可 resize（拖柄）、空态启动器卡片、pane 内容区统一容器。
- 范围：ui-src/components/RightPanel.jsx、right/tabs.js、right/StartPage.jsx、style.css 右栏段。
- 注意：现有 tab 类型（subagent/gitdiff/bgcmd/file/tree）保留，新增 browser/terminal tab 入口由阶段 5 填充；本阶段先把 tab 框架与已有页面对齐新设计。
- 状态：待实施

## 阶段 4：diff 渲染替换 diff2html

- 目标：用 ZCode 自研轻量 diff（packages/ui/src/components/ui/lightweight-diff-preview.tsx，纯 CSS 行解析：行背景 color-mix + inset 状态条 + 行号 gutter，无第三方依赖）替换 ui/vendor/diff2html 与 GitDiffPage 内的 Diff2Html 调用；编辑行内联 diff（chat/parts.jsx）同步替换。
- 依赖：语法高亮沿用 ui/markdown.js 现有高亮，不引入 shiki（超范围）。
- 验收后：删除 ui/vendor/diff2html.* 与 index.html 引用。
- 状态：待实施

## 阶段 5：浏览器 + 终端 pane

- 终端：xterm.js（vendor 或 npm 依赖）+ host 侧 PTY。host 是 Bun——node-pty 兼容性需先验证（Context7/实测）；不可行则 Bun.spawn `script -q` 类 pty 包装。新右栏 tab「终端」。
- 浏览器：ZCode 用 Electron webview，Tauri 无等价。方案（实施时代理先用 Context7 验证 Tauri v2 inline webview 能力，macOS WKWebView 限制）：优先 Tauri 子 webview；不可行则 iframe + 「外部浏览器打开」兜底，UI 完整复刻 ZCode（工具栏/地址栏/空态/错误态，抄 EmbeddedBrowserPaneParts.tsx 设计）。
- 新右栏 tab「浏览器」。
- 状态：待实施

## 明确不做

- 辅助对话（selection side-chat 等）、模型轨迹、whiteboard 等其余 19 种 tab。
- @pierre/diffs 富 diff（它本身是第三方 Shadow DOM 库，与「替换第三方」目标相悖）。
- shiki worker 池高亮。

## 执行方式

单 writer 串行 subagent（同一 cwd），每阶段一个任务，完成后主会话验证 build+smoke 再进入下一阶段。
