# React 迁移实施计划（react-migration 分支）

> 目标：ui/ 原生 ESM 前端 → React 19 + esbuild 组件化。CSS（style.css 及 token 体系）全量保留、类名不变，视觉零回归。
> 主分支（原生版）持续可用；本 worktree 全量重写，完成前不合并不删旧。

## 架构定稿

- 构建：`bun run ui:build` / `ui:watch`（esbuild --bundle --format=iife --jsx=automatic → ui/assets/app.js）
- 挂载：ui/index.html 精简为 root + vendor(diff2html) + style.css + assets/app.js
- 数据层：`ui-src/store.js` —— S mutable 单例 + 容器（自 core.js 平移）+ onMessage 全量平移（渲染调用 → notify()）；组件经 `useStore()`（useSyncExternalStore 版本号订阅）重渲染
- 图标：`ui-src/Icon.jsx` 包装 ui/icons.js 的 icon()（icons.js/fa-icons.js 已补 ESM 导出）
- 非受控输入：Composer textarea + 模块级 draft（等价原 inputEl.value，欢迎页↔dock 换位不丢值）
- 外部库命令式豁免：diff2html 允许 effect+ref 注入

## 阶段

### ✅ 阶段 0：地基（已完成）
- [x] react/react-dom/esbuild/happy-dom 依赖，ui:build/ui:watch/smoke:react scripts
- [x] store.js（数据层 + onMessage 平移 + notify 桥）
- [x] App.jsx 三栏壳 + ChatHead + Toast；五个屏的占位组件
- [x] index.html 挂载点化；icons.js/fa-icons.js ESM 化
- [x] 冒烟 `scripts/smoke-react-shell.ts` 6 断言全绿（happy-dom + preview 模式）

### ✅ 阶段 1：五屏并行迁移（已完成，da12402）
- [x] chat-wave：Chat.jsx 完整版（chat.js/tool-rows.js/tool-labels.js/markdown 渲染管线；loop 组/思考行/工具行/审批卡/分叉/编辑重发/msgRail/work-line/statusCard）
- [x] composer-wave：Composer.jsx 完整版（附件行/发送链路/模型·思考·权限菜单/排队卡/ctxRing）
- [x] sidebar-wave：Sidebar.jsx 完整版（项目分组/最近视图/置顶/归档/拖拽排序/右键菜单/确认弹窗/清理模式）
- [x] welcome-wave：Welcome.jsx 完整版（项目选择菜单/分支菜单）
- [x] right-wave：RightPanel.jsx 完整版（五页面；详情页保持 rb-head 固定 + rb-scroll 滚动骨架）

成功标准：每 wave `bun run ui:build` 通过 + 冒烟 6 断言不回归；`pnpm tauri dev` 手工冒烟：新建会话→发消息→流式渲染→loop 收起→排队→切换会话→右栏五页。

### ✅ 阶段 2：设置中心七件套（settings/* 2400 行）
- [x] 设置页容器（全屏 overlay + 左导航）+ 打开/关闭链路（settingsBtn/菜单 open-settings/⌘,/Esc；`ui-src/components/settings/Settings.jsx`）
- [x] 常规/外观/模型设置（模型页角色视图 buildRolePicker/供应商卡片/配额明细）+ MCP + skills + memory + agents + stats（14 页组件在 `ui-src/components/settings/pages/`，common.jsx 公共件：confirmDialog/登录横幅/emptyRow）
- [x] store.js 里 TODO(settings-wave) 标记的回包分支接通（models_catalog/provider_limits/asset_file/memory_file/mcp_server_tested/login 系 + ready/settings 帧 uiPrefs 字段级白名单合并 + 连接就绪补拉）

### ✅ 阶段 3：壳交互与弹卡补全
- [x] shell.js 平移：主题切换/缩放（zoomLevel）/左右 resizer 拖动/右键主菜单/closeAllMenus 体系（`ui-src/shell.js` initShell：applyTheme/toggleTheme/menuZoom/placeMenu/attachResizer/closeAllMenus；⌘+/-/0 与原生菜单四 action 接通）
- [x] ringpop.js 平移：上下文明细卡（`ui-src/components/chat/CtxCard.jsx`，ctxRing hover 150ms 定器 + 朝卡宽限 + 配额段 + 压缩按钮）+ 消息轨道 hover 卡（阶段 1 已随 MsgRail 落地）
- [x] store.js TODO(ringpop-wave) 分支接通（context_detail→S.ctxDetail / limits_result→S.ctxLimits 瞬态落地）

### ⬜ 阶段 4：收尾
- [ ] preview 对照模式去留；旧 ui/*.js 命令式模块删除（icons.js/fa-icons.js/markdown.js 保留共用）
- [ ] pre-commit 挂 smoke:react；tauri.conf.json 确认 frontendDist 不变（仍是 ../ui）
- [ ] 全量手工回归（对照 AGENTS.md 设置页一致性规范抽查）+ 合并 main

## 约定（所有 wave 遵守）
- 禁改 store.js / App.jsx / ui 原模块 / host / src-tauri；新文件放 ui-src/components/<域>/
- 类名与 DOM 结构 1:1 对照旧版（git show HEAD:ui/… 查旧结构）；CSS 只在必要时新增且用 token
- 交互/动效类名（kids-in/lift/flash/on 等）沿用，动画 CSS 已存在
- 每完成一步：bun run ui:build && bun scripts/smoke-react-shell.ts 全绿
