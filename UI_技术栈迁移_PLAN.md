# UI 技术栈破坏式迁移:对齐 ZCodium(TS + Vite + Tailwind + shadcn + zustand + streamdown + Lexical)

> **生命周期**:本文件是 UI 栈迁移的**实施合同**,冻结于 2026-09-24。决策 Why 归 `.agents/notes/00NN-*` ADR,字段/契约变化以此为锚;迁移期间(`P1`–`P7` 任一未验收)不得删除,完成后按 `docs/documentation.md` §3 收敛到对应 ADR 后退役。
>
> **实施进度**(2026-09-24):P0 ✅ → P1 ✅ → P2 ✅ → **P3 ✅**(zustand 切分完成:store/ 十文件 index 组合六 slice[ui/session/projects/right/settings/ws]+shapes/terminal/utils/groupExpand;全部组件(含 6 个漏网 .jsx)切 useAppStore selector 订阅;容器写入全量换引用(openSessions 走 updateSession 拷贝链);S/useStore/notify/_v 版本桥/liveRef 容器代理全部退役,store.ts 成为纯转发桶文件;delta 流式改 applyDelta(100ms 窗口 mutate+flush 换引用);rightTabs/rightRecentClosed 迁入 RightSlice;查阅组/设备组展开态独立 groupExpand 通道;__dbg 终态={useAppStore},smoke 适配;四绿验收)。P4–P7 未实施。
> P3 执行波次:波 1 zustand 底座+兼容壳 → 波 2 业务逻辑迁 slice+转发壳 → 波 3-0 live 代理+流式主路径换引用 → 波 3-A~I 组件 9 批并行切 selector(subagent 分工,只跑 typecheck,build/smoke 协调者统一跑)→ 波 4 删 _v/版本桥+delta 节流重构+tabs 入 store。
> P3 关键教训:① zustand subscribe 回调里 set(同步或微任务延迟)与 React 19 useSyncExternalStore 级联死循环(#185 同步版与异步死循环版均实测)——渲染触发只能靠显式 setState 换值/换引用;② Proxy/兼容层写必须区分静默写与通知写(旧代码存在「写后不 notify」静默写,写即 bump=渲染循环);③ grep 迁移清单必须覆盖 .jsx 后缀(P3 曾漏 6 个 .jsx 文件);④ ESM 循环 import 中模块函数引用 useAppStore 安全(运行时调用),slice 工厂体内不得引用;⑤ selector 禁止构造新对象/数组字面量(无限重渲染)。
> P3 偏差记录:PLAN 只列 4 个 slice 文件,实际为六 slice(+settings/ws:分节注释独立成节+连接路由域)+辅助模块(shapes/terminal/utils/groupExpand);组件过渡写法 setBump 保留为 setState 直通别名(具名入口,后续阶段自然消亡);查阅组/设备组的模块级 WeakMap 展开态保留原位,渲染走 groupExpand 独立通道(未入 store)。
> P2 偏差记录:① typecheck 基线 158 错由收口修至 0(跨批次类型对齐:SessionInfo.title/ModelRole.tag 允许 null、TimerHandle 统一、settingsSchema 定 SchemaDef、AppState.mpDetailProv 定 AllProviderEntry、frames.mcp 补 McpAssetsPayload);② 两批次把类型守卫写成运行时 `instanceof HTMLElement`(Composer cbar 宽度计算、parts ResizeObserver),happy-dom 无此全局致 smoke 崩——已回退为 `as` 收窄,**教训:类型收窄只用 as,不得新增运行时 instanceof 守卫**;③ P1 偏差:vite.config.ts 暂以 CJS 加载(package.json 无 type:module,加则影响全仓 .js 语义,未动)、smoke CSS 解析改正则为属性顺序无关。

## Context

omp-desktop 前端(`ui-src/`,97 个 `.jsx`/`.js` 共 14301 行 + `ui/style.css` 4193 行纯 CSS)当前为 esbuild + 裸 JSX + 手写 store。目标:一次性对齐 ZCodium(`~/Github/ZCodium`)的 UI 技术栈——TypeScript + Vite 8 + Tailwind v4 + shadcn/Radix + zustand,并换 streamdown(markdown 渲染)与 Lexical(composer)。Tauri 2 壳与 Bun host 不动,WS 协议与线上消息格式零变化。设计基线仍是 VSCode Dark+/Light+(`data-theme` 机制、AGENTS.md 设置页规范复合类全部保留)。共享工作区改动已提交在 `4cddfbc`，作为本计划的当前基线。

## Approach

### P0 前置闸门

**目标**:在动手前确认入口文件状态无并行未提交改动,避免与另一会话的侧栏改动打架。

1. 确认基线为 `4cddfbc`;检查 `git status --short -- ui-src ui/style.css ui/index.html package.json src-tauri/tauri.conf.json`，目标文件有未提交改动时先核对，不覆盖、不自行合并。

### P1 基座(无行为变化)

**目标**:在不改变可见行为的前提下,把构建/类型链切换到 Vite 8 + TS,为 P4 Tailwind 与 P3 zustand 打好基座。

1. 一次性装齐依赖:`bun add -d typescript vite @tailwindcss/vite @vitejs/plugin-react @types/react @types/react-dom` + `bun add tailwindcss zustand clsx tailwind-merge class-variance-authority radix-ui lexical @lexical/react streamdown @streamdown/cjk @streamdown/code`。
2. 新建 `vite.config.ts`(仓库根):`root: "ui"`、`base: "./"`、plugins `[react(), tailwindcss()]`；输出目录设为相对 root 的 `dist`(即 `ui/dist`)，`emptyOutDir: true`、`assetsInlineLimit: 0`，通过 `build.rolldownOptions` 固定入口为 `assets/app.js`、分块名为 `assets/chunk-[hash].js`。不额外开放 `server.fs`。
3. 新建 `tsconfig.json`:`strict: true`、`target ES2022`、`module ESNext`、`moduleResolution bundler`、`jsx react-jsx`、`noEmit: true`、`allowJs: true`、`checkJs: false`、`include: ["ui-src", "vite.config.ts"]`、`types: ["vite/client"]`，让现存 JS/JSX 与迁移后的 TS/TSX 共存，并检查 Vite 配置。
4. 新建 `ui-src/env.d.ts`:`/// <reference types="vite/client" />` + `export {};` + `declare global { interface Window { __dbg?: Record<string, unknown> } }`(preview 调试用)；它是类型输入之一，不是唯一输入。
5. `package.json` scripts:`ui:build` → `vite build`;`ui:watch` → `vite build --watch`;新增 `ui:dev`: `vite`、`ui:typecheck`: `tsc --noEmit`;`check` 追加 `&& bun run ui:typecheck`。同时 `bun remove esbuild`(ui:build/ui:watch 换 Vite 后无消费者,不留死依赖)。
6. `src-tauri/tauri.conf.json`:`frontendDist` 改为 `"../ui/dist"`；Tauri 的 dev/build 验收都要先生成并实际加载这份前端产物。显式约定:桌面端开发**无 HMR**(不配 `devUrl`),`bunx tauri dev` 始终加载预构建产物；浏览器 preview 走 `bun run ui:dev`。
7. `.gitignore` 增加 `ui/dist/`(保留已有 `ui/assets/` 行不动)。
8. 图标注册表留在 `ui/`:`.local` 生成脚本把输出路径固定写在那里；保留 `ui/icons.js`、`ui/fa-icons.js`、`ui/lucide-icons.js`、`ui/file-icons.js` 与现有导入路径，不手改生成文件。
9. `ui/index.html` 的入口先指向 `<script type="module" src="../ui-src/main.jsx">`，等 P2 将入口改名后再同步为 `main.tsx`；`<link rel="stylesheet" href="style.css">` 保留，由 Vite 处理本地样式引用。
10. 验证:`bun run ui:build` 产出 `ui/dist/index.html`、`ui/dist/assets/app.js` 和 CSS；`bun run ui:typecheck` 检查 TS/TSX 与 Vite 配置。

### P2 全量 TSX 化(逻辑零改动)

**目标**:让全部前端源码进入 TS,只在类型层增量,行为零变化;完成后 `bun run check` 必须维持 86 RPC/29 边界绿。

1. 97 个文件按目录所有权切 6 批并行迁移(每批内部串行):A `components/Sidebar.jsx`+`components/sidebar/`、B `components/Composer.jsx`+`components/composer/`、C `components/chat/`、D `components/right/`、E `components/settings/`(含 settings-zh.js、placement.js)、F 根层(`App/main/shell/keys/appearance/store`)+`lib/`。每批 `.jsx→.tsx`、`.js→.ts` 并补类型；共享入口、全局 store、跨目录 importer 由唯一负责人收口，避免多人同时改同一文件。每波完成后串行跑类型检查与构建；不改正文行为、类名、字符串，diff 应≈纯类型。
2. `ui-src/types/frames.ts`:WS 帧判别联合。权威来源是发送端——`host/host.ts` 与 `host/*.ts` 中全部 `ws.send`/广播帧的构造点(约 60 种),逐帧镜像为 `type` 字面量判别联合;store 巨型 switch 逐分支消费,穷尽检查必须覆盖 switch 的 default 路径。
3. `ui-src/types/session.ts`:会话条目判别联合(user/assistant/thinking/tool/loop/bash/mention/meta/phase/err,字段以 `components/chat/items.jsx` 分发处的实际读取为准)+ openSessions 容器与 S 的形状。
4. `main.tsx` 的 preview 注入块与 `window.__dbg` 逻辑原样保留,仅补类型。
5. `shell.js`/`keys.js` 的命令式 DOM 副作用与 `omp:close-menus`/`omp:zoom` 事件机制原样保留。

### P3 zustand 切分

**目标**:把巨型 `store.js` 切到 slice,清理所有直接状态写入,组件订阅走 selector;`notify()` 机制退出。

1. 按 `store.ts` 现有分节注释切 slice,字段名零改动:`store/ui.ts`(theme/zoom/侧右折叠/isCreatingNew/settings 页/sigil/uiPrefs)、`store/session.ts`(openSessions 容器 + 当前会话字段 + modelNames/modelEfforts 宿主 models 帧容器)、`store/projects.ts`(diskProjects/pinned/projectLimits/expandedProjects/unseenFinished)、`store/right.ts`(rightState/gitDiffCache/fileDiffCache/briefDiffCache);`store/index.ts` 桶导出。`onTerminalFrame` 终端帧总线不经 zustand,原样保留为独立模块(直推订阅者、不触发整树订阅)。
2. 所有状态写入都迁到 slice actions：包括 WS switch、组件交互、`shell.js`/`keys.js` 和所有 `notify()` 调用点；逐项搜索并清理对 `S`、`openSessions` 及其他可变容器的直接写入。仅迁移 WS 分发不算完成。删除 `notify()`/版本号机制，组件订阅改用 selector。
3. `window.__dbg` 暴露等价 store 句柄(preview 与 smoke 依赖)。
4. LRU/内存闸门(openSessions 上限 8、briefDiffCache 上限 30)语义原样迁移。

### P4 Tailwind v4 与 token 迁移

**目标**:把视觉规范接入 Tailwind utility,保留 AGENTS.md 复合类与现有 token 变量,不改色值。

1. `ui/style.css` 显式声明 `@layer theme, base, components, utilities;`，导入 `tailwindcss/theme.css` 与 `tailwindcss/utilities.css`，**不导入 Preflight/base reset**，避免重置现有控件和壳层样式；加 `@source "../ui-src/**/*.{ts,tsx}";` 与 `@theme inline` 块:token 名直接映射现有变量——`--color-base/card/inset/panel-2/select/surface/line/line-soft/text/dim/faint/accent/green/orange/red/err/yellow/blue/purple/bash/diff-added/diff-removed`、`--radius-sm/md/lg/card`、`--font-size-ui-xs/sm/base/md/lg/xl`(值用 `var(--ui-fs-*)`)、`--font-sans/mono`。`:root` 与 `:root[data-theme="light"]` 原变量块一字不动,utility 经 @theme 间接引用。
2. 组件批量 utility 化(className 换 utility,对应 CSS 块删除,删前搜索 JS/HTML/CSS/冒烟中的引用)。**例外(AGENTS.md 点名的全站复合语言,保留为 style.css `@layer components` 定义,可用 @apply)**:`.srow .pill-btn .icon-btn .save-btn .sel .inp .tg .add-btn .confirm-btn .mem-expand` + 布局骨架(`.dock` 负 margin 重叠卡、`#right` 三区、`#sidebar` 壳)。`.menu`、`.act`、`.ring-pop`、markdown 样式及被 JS/测试查询的类名钩子也保留；不新增替代图标体系。
3. 主题机制不变:`html[data-theme]` + localStorage,不用 Tailwind dark variant;浅色仍靠 `[data-theme="light"]` 变量覆盖。
4. 同步更新 `AGENTS.md` 技术栈段落(React+TS+Vite+Tailwind、设置页规范中复合类保留的表述、图标系统不变),使后续 agent 按新栈写码。
5. 组件文件可按 P2 的目录边界并行迁移；共享的 `ui/style.css` 由单一负责人串行编辑。每波结束后由协调者依次跑 `ui:typecheck`、`ui:build`，禁止并行构建覆盖 `ui/dist`。

### P5 shadcn/Radix 基件

**目标**:仅在三个真实迁移点引入 Radix 基件,替换现有控件实现,视觉与交互等价。

1. 从 `~/Github/ZCodium/packages/ui/src/components/ui/` 复制 `button/dialog/dropdown-menu/select/switch/tooltip/popover/tabs/input/textarea/scroll-area` 到 `ui-src/components/ui/`,逐件替换类名为 P4 token utility(bg-card/text-dim/border-line 等);类合成用 clsx + tailwind-merge + cva，Radix 使用 `radix-ui` 统一包。只安装这些组件实际 import 的依赖，不照搬 ZCodium 整包依赖；图标改用本仓 `Icon`/注册表，缺项经 `.local` 生成脚本补齐，不直接引入 `lucide-react` 图标。
2. 迁移点仅三处:设置页 `SchemaRows.tsx` 的 `.tg→Switch`、`.sel→Select`、`.inp→Input`;`.confirm-mask` 确认弹窗→Dialog;RightPanel tab hover 提示→Tooltip。根组件提供 `TooltipProvider`，包裹现有可点击控件时用 `TooltipTrigger asChild`。三处迁移后视觉与交互等价(Radix 自带 focus trap/键盘导航,样式用我们的 token 换肤)。
3. 既有 `.menu`/`placeMenu()`/`closeAllMenus()` 全局菜单系统本轮不动。

### P6 streamdown 渲染

**目标**:assistant/thinking 消息体换 streamdown,代码高亮跟随主题;文件/diff 视图保留现有 highlighter。

1. assistant/thinking 消息体的 markdown 渲染换 `streamdown` + `@streamdown/cjk`(开启)+ `@streamdown/code`；按插件支持的配置使用 Shiki 与 `dark-plus`/`light-plus`，由 `data-theme` 切换。不要假定插件可注入现有 Shiki 单例；现有 `ui-src/lib/highlighter.ts` 继续供文件和 diff 视图使用。
2. 视觉对齐现有 token:代码块字号 `--code-fs`、底色/圆角沿用 style.css 既有规则；preview 样本消息逐屏比对，并现场切换主题确认代码高亮跟随。

### P7 Lexical composer

**目标**:Composer 切到 Lexical;草稿/附件/补全/快捷键/IME 行为等价。

1. `Composer.tsx` 重写为 Lexical:`LexicalComposer` + RichTextPlugin + HistoryPlugin;`@`/`/` 补全用 `@lexical/react/LexicalTypeaheadMenuPlugin`,选中项插 decorator chip 节点。
2. 序列化与线上格式逐字节一致:chip 序列化为现状同款纯文本(如 `@路径`),WS 发送内容格式不变。
3. 原样保留:附件行与 cbar 九钮(权限/计划胶囊、上下文环明细卡)、!bash 模式、发送⇄停止合一、Ctrl+↵ steer / Ctrl+Q 排队 / Alt+↑ 拉回、Esc 草稿二次确认、高度自适应 ≤120px、补全、输入法组合输入与快捷键行为。当前草稿是**模块级单例**，跨 Composer 挂载保留且不按 `sessionId` 隔离；Lexical `EditorState` 也按同一语义在模块级保存/恢复，发送后清空。
4. 不碰 ApprovalCard/QueueCard/GoalCard(它们在 Composer 之外)。

## Critical files & anchors

- `package.json` — scripts 段(ui:build/ui:watch/check),P1 第 5 步。
- `src-tauri/tauri.conf.json:7` — `frontendDist`,P1 唯一 Rust 侧改动。
- `ui/index.html` — 入口接线(script/link),P1 第 9 步先接 `main.jsx`，P2 改名后更新为 `main.tsx`；全文重读。
- `ui-src/main.tsx`(原 main.jsx:79-129)— preview 注入与 `window.__dbg`,P2 原样保留的锚点。
- `scripts/smoke-react-shell.ts:37` — `await import("../ui/assets/app.js")` 改 `../ui/dist/assets/app.js`,并改为读 `ui/dist/index.html` 解析 CSS href、读文件注入 `<style>`(happy-dom 不吃 link)。
- `ui/style.css:1-78` — token 块(P4 @theme 映射源,变量值不动)。

## 验证矩阵

1. P1 收尾追加 `bun run smoke:react`(smoke 引用的 bundle 路径本阶段即从 `ui/assets/app.js` 切到 `ui/dist/assets/app.js`,必须当场验证,不留到 P7);此后每阶段(P2–P7)收尾依次执行:`bun run ui:typecheck`、`bun run ui:build`，确认产物在 `ui/dist`；不并行启动多个构建。
2. P2 后:`bun run check` 通过；当前基线输出为 86 RPC/29 边界，迁移不应改变 host 检查结果。
3. P7 后:`bun run smoke:react`(happy-dom)全断言绿,含新增:preview 下 composer 挂载、发送按钮存在。
4. 人工(vite dev,`bun run ui:dev` → `http://localhost:5173/?preview=1`):三栏壳渲染、样本消息(编辑组/查阅组/读取行/思考/终端卡)齐全、设置中心 24 页可逐页点开、明暗主题切换 token 生效、streamdown 代码块明暗高亮跟随;控制台零 error。
5. 端到端(真机):先 `bun run ui:build`，再启动 `bun run host` 与 `bunx tauri dev`，确认 Tauri 从 `ui/dist` 加载；新会话发一条消息走完整回路(composer→WS→回复渲染),`!ls` 走 bash 模式;Lexical 交互(@ 面板、输入法组合输入、Ctrl+↵ steer)因 happy-dom 不支持 contenteditable 只做此项人工验证。
6. 视觉回归:P4 完成时按 preview 样本对 P1 截图基线逐屏比对(用户目视),确认 Tailwind 化无色差。

## 假设与回退

- 若基线提交不是 `4cddfbc` 或目标文件有并行改动，先审查差异后再开始迁移。
- P2/P4 只有文件所有权互斥的组件工作可并行；共享入口/store/importer/CSS 和所有构建由唯一负责人收口、顺序执行。
- 若 Streamdown Code 插件不支持复用现有 Shiki 实例，使用插件自己的 Shiki 配置；文件与 diff 视图仍保留现有 highlighter，主题都跟随 `data-theme`。
- ZCodium 只作组件实现参考；按实际 import 补依赖，不引入其设计 token(zai 主题)或额外图标库。
