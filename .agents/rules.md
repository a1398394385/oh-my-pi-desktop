# 防回归铁律 (RULEs)

> 本文件列出本仓库"被破坏过"或"绕过代价极大"的规则。AI 改代码前**必须**先读本文件;review 时**必须**检查是否违反。
>
> 当前 10 条:体系随 [documentation.md §8](../docs/documentation.md) 建立于 2026-09-20,新 RULE 待真实事故或 Accepted ADR 背书后立入(判据:背书真实 + 可执行,见 §8「何时新增 RULE」)。

## 规则总览

| 编号 | 规则 | 影响范围 |
|------|------|---------|
| RULE-001 | 新增/修改工具标签必须同步扩展 host/translate.ts 的参数白名单与结果摘要 | 前端渲染 + 宿主转发 |
| RULE-002 | 新增内嵌滚动容器必须 `overscroll-behavior: contain`,装饰元素不得放进滚动节点内 | 全部 UI 样式 |
| RULE-003 | 渲染函数必须纯渲染,RPC 请求只能由视图入口/事件处理器发起 | 全部 UI 渲染 + RPC |
| RULE-004 | 改动 import 区块禁止整行替换相邻 import;删改符号后必须核对本文件使用点 | host/ 与全部 TS 模块 |
| RULE-005 | 组件内的条件早退必须位于全部 hooks 之后 | 全部 UI 组件 |
| RULE-006 | 展开/详情渲染体不得无条件解引用异步到达的内容；整树必须包在 ErrorBoundary 内 | 全部 UI 渲染 |
| RULE-007 | 键盘上下导航切换选择的滚动列表必须绑定激活项 scrollIntoView 视口跟随 | 全部交互式列表与下拉浮层 |
| RULE-008 | 列出外部来源资产的宿主扫描必须复用底座来源判定,禁止自建目录枚举绕过来源开关 | host/ 资产发现层 |
| RULE-009 | 整文件回写源码必须显式 UTF-8,回写后必须核对非 ASCII 内容未变 | 全部脚本/生成器/批量改写 |
| RULE-010 | 升级 @oh-my-pi/* 底座版本后必须实跑 check 与 host:build,禁止只改 pin + install 就交付 | 依赖升级流程 |

---

## 规则详情

### RULE-001: 新增/修改工具标签必须同步扩展 host/translate.ts 的两处转发白名单

**规则**:在 `ui-src/components/chat/ToolRow.tsx` 给新工具加标签行(或改既有标签的摘要字段)时,必须同步检查并扩展 `host/translate.ts`:
1. `toolArgsForUi()` —— 按工具白名单放行参数,新工具不加分支则前端只收到 `{}/path/files/content`;
2. `summarizeResult()` —— 按工具提取 `output/details`,新工具不加分支则展开卡永远「(无输出)」。

**Why**:UI 标签三层数据链路「底座事件 → translate.ts 过滤 → 前端渲染」中,行能渲染 ≠ 有数据。BUG-001:新标签行渲染正常但展开卡全是 `{}` 与「(无输出)」,根因就是只改了渲染层。

**How to apply**:改 `ui-src/components/chat/ToolRow.tsx` 时 grep `toolArgsForUi` 与 `summarizeResult`,确认新工具名在两处都有分支且字段与 UI 摘要一致;大参数(questions/memories 等)过 `capValue()`。review  checklist:标签行出现新工具名 ↔ translate.ts 同名词条成对出现。

**关联**:BUG-001

### RULE-002: 新增内嵌滚动容器必须 `overscroll-behavior: contain`,装饰元素不得放进滚动节点内

**规则**:给任何元素加 `overflow: auto/scroll` 使其可滚动时,必须同时判定它是否「内嵌」——祖先链上存在另一个滚动容器(本仓:`#stream`/`#rightBody`/`#setBody`/`#tasklist`/`#setNav`/`.welcome-screen` 等)即为内嵌,必须加 `overscroll-behavior: contain`。同时,装饰性元素(区域竖线、角标、装饰背景)必须用绝对定位伪元素等手段放在**外层非滚动节点**上,不得直接挂在滚动容器内。

**Why**:BUG-002 真实踩过两个坑,根因都是把滚动容器当成普通盒子:
1. scroll chaining——内嵌容器滚到顶/底后,剩余滚轮量与触控板惯性继续传给外层滚动区,用户滚一个小卡片却带动了整个会话流;
2. 绝对定位装饰(`.think-body::before` 竖线)属于滚动内容,随内容一起滚出视口。

**How to apply**:写 `overflow-y: auto` 时自问一句「它的祖先里有谁会滚?」——有 → 同行加 `overscroll-behavior: contain`;需要伪元素装饰 → 拆内层滚动节点,装饰留外层。豁免(不加):顶层滚动区(自身即区域唯一滚动层)、fixed 定位浮层菜单(无滚动祖先)、纯横向溢出容器(横向手势不会纵向传递)。review checklist:新增 `overflow(-y)?: auto|scroll` ↔ 相邻可见 `overscroll-behavior: contain` 或明确豁免理由。

**关联**:BUG-002

### RULE-003: 渲染函数必须纯渲染,RPC 请求只能由视图入口/事件处理器发起

**规则**:`render*()` 渲染函数体内禁止 `send(...)` 发 RPC 请求;数据拉取只能放在视图入口(按钮点击、页面激活、相关 done 消息处理器)发起。判据:若某消息 type 的响应处理器会调用渲染函数 R,则 R 体内不得发出触发该消息的请求——否则形成「渲染 → 请求 → 响应 → 再渲染」无限循环。

**Why**:BUG-003 真实事故——为让「已配置」徽标在登出后收敛,把 `send(get_all_providers)` 放进 `renderAddProviderView()`,而 `all_providers` 响应处理器也调用它,形成无限重绘:DOM 不断重建,hover 高亮闪烁、点击被吞。

**How to apply**:给渲染函数加请求前,先在 core.js grep 该消息 type 的响应处理器——若会调回本渲染函数,请求必须上移到入口。症状识别:UI hover 闪烁 + 点击无反应 ≈ 无限重绘。review checklist:渲染函数体内出现 `send(` ↔ 该消息的响应处理器不调回同一渲染函数。

**关联**:BUG-003

### RULE-004: 改动 import 区块禁止整行替换相邻 import;删改符号后必须核对本文件使用点

**规则**:在 `host/*.ts` 或任何 TS 模块的 import 区块插入新 import 时,只能**插入**——不得用「选中相邻既有 import 行 + 替换」的写法。任何被删除/被替换掉的 import 名(以及被替换的函数调用参数块中的每一行),必须立刻 grep 该符号在本文件的使用点,确认无残留引用。

**Why**:BUG-004(调用未 import 的函数 → ReferenceError 中断消息处理)与 BUG-011(ACP 提交插入 import 时整行吞掉 pty import → 前端断开即崩宿主进程)是同一根因的两次事故。本仓无 tsc/eslint 门禁,import 缺失只在运行期暴露,且暴露点常常是低频路径(WS close),启动冒烟看不见。

**How to apply**:改完 import 区块后跑 `grep -n "<被删符号>" host/host.ts`,逐个确认要么仍被 import、要么已无引用;host 改动后额外跑一次「连接 → 断开」存活冒烟(连一次 WS、收到 ready 后 close,断言进程仍在),覆盖 `close` 处理器路径。review checklist:diff 里出现 `-import ... from` ↔ 该行符号在本文件已无使用,或已被同文件其他 import 覆盖。

**关联**:BUG-004 / BUG-011

### RULE-005: 组件内的条件早退必须位于全部 hooks 之后

**规则**:函数组件里任何 `if (cond) return ...`（折叠态、空态、未就绪态）必须写在所有 `useState/useRef/useEffect/useLayoutEffect/useMemo/useCallback/useStore` 调用之后。组件已有早退分支时,新增 hook 只能插在早退**之前**。

**Why**:BUG-014 真实事故——`Sidebar` 的 `manageSnap` ref 落在 `if (collapsed) return` 之后,展开→折叠时 hooks 从 9 个变 8 个,React 抛 #300 并卸载整棵组件树(整界面白屏)。该早退分支长期无入口(⌘B 只在设置页登记未绑定),所以一直静默存在,直到快捷键把它接上才引爆。

**How to apply**:改组件前先扫 `return` 早退的位置,把 hooks 收拢到它上方;折叠/空态早退尤其要查(只在状态切换那一刻炸)。review checklist:diff 里新增 `use*(` 行 ↔ 该行位于其上方最近的 `if (...) return` 之前。

**关联**:BUG-014

### RULE-006: 展开/详情渲染体不得无条件解引用异步到达的内容

**规则**:凡「展开态由某个 `item.*Expanded` 标志驱动、展开体读取工具回包内容」的组件，`open` 判定必须同时校验内容对象存在（`open = item.xxxExpanded && !closing && !!内容`），展开体内不得对可能为 undefined 的嵌套对象直接取属性（`a.b.c`）。同时，React 根渲染必须始终包在 ErrorBoundary 内，禁止无边界裸 `root.render(<App/>)`。

**Why**:BUG-016——`ReadRow` 的 `open = item.readExpanded && !closing` 不看 `details.displayContent`，而「工具运行中默认展开」在 `tool` 帧就置位、内容要等 `tool_update`；目录读取则永远没有 `displayContent`。渲染异常无边界 → 整窗口黑屏。BUG-014 是同症状的第二次（hooks 顺序），两次都因缺边界而丢现场。

**How to apply**:写/改 `*Row.jsx`、`ExpandableRow`、`ReadRow` 这类展开组件时，检查展开体里每一处属性链——内容来自 `tool`/`tool_update`/RPC 异步帧的一律加 `?.` 或把存在性并入 `open`。review checklist:diff 里出现 `Expanded && <` ↔ 同行或上方有内容存在性判定。全站同类点已审计（BashRow/CmdCard/ContentCard/EditBrief 均有 `||` 兜底，仅 ReadRow 曾漏）。

**关联**:BUG-016 / BUG-014

### RULE-007: 键盘上下导航切换选择的滚动列表必须绑定激活项 scrollIntoView 视口跟随

**规则**:凡支持通过键盘上下箭头（ArrowUp / ArrowDown）在子项间切换选中态的滚动列表或下拉浮层（搜索框下拉、命令面板、自动补全、下拉菜单等），必须实现选中项自动滚动进可视区域（`scrollIntoView({ block: "nearest" })`），且筛选关键词变更重置选中项时必须复位滚动容器至顶部（`scrollTo({ top: 0 })`）。

**Why**:BUG-018 多次踩坑。内嵌滚动容器（`overflow-y: auto`）不会自动随 state 里的 `selectedIndex` 或 class 变化而滚动，仅更新索引导致可视区外的选中项对用户不可见，体验严重降级。

**How to apply**:给滚动容器绑定 `listRef`，以 `useEffect` 监听 `selectedIndex`（或通过键盘导航标记区分鼠标 hover 与按键），对激活元素执行 `el.scrollIntoView({ block: "nearest" })`；搜索词改变重设为 0 时调用 `listRef.current?.scrollTo({ top: 0 })`。review checklist:出现 `ArrowDown`/`ArrowUp` 修改选中 index ↔ 必有 `listRef` / `scrollIntoView` 联动。

**关联**:BUG-018

### RULE-008: 列出外部来源资产的宿主扫描必须复用底座来源判定,禁止自建目录枚举绕过来源开关

**规则**:宿主侧任何「枚举外部工具目录/配置并列表展示」的资产发现(技能、MCP 等)必须复用底座的来源判定:项级 `disabledExtensions` 之外,还要过来源主开关(底座 `isProviderEnabled`,设置键 `disabledProviders`)与用户级 opt-in(底座 `isUserSourceEnabled`,设置键 `enabledProviders`);用户级 claude/codex 目录另有技能级兼容开关 `skills.enableClaudeUser` / `enableCodexUser`。项目级目录只受主开关约束。禁止用 `loadCapability(..., { includeDisabled: true })` 让页面看到比运行时更多的外部来源(该选项等于 `includeOptOutUserSources`,会绕过 opt-in)。

**Why**:BUG-025——`host/assets.ts` 自建目录扫描硬编码 `~/.claude/skills` 等外部目录,只查项级开关不查来源开关,于是扩展页关掉来源后技能/MCP 页仍列出该来源资产(会话侧实际不加载),页面与现实不一致;底座 `filterProviders` 本来已按 `disabledProviders` 过滤,自建扫描等于把判定复制了一份并丢掉。

**How to apply**:新增/修改 `host/assets.ts` 内任何 `{ dir, provider }` 源列表时,列表循环里必须有 `isAssetSourceOn(provider, level)`(或等效的来源判定)在扫描前 continue;给 `loadCapability` 传参时不要带 `includeDisabled`,除非该调用专门为扩展中心这类「管理面板」服务。review checklist:diff 里出现新的 `path.join(os.homedir(), ".xxx"...)` 外部目录 ↔ 同一路径集合上有来源判定;出现 `includeDisabled: true` ↔ 该函数不是管理面板。回归验证:`bun scripts/probe-asset-sources.ts`(四组来源开关断言,改前红)。

**关联**:BUG-025

### RULE-009: 整文件回写源码必须显式 UTF-8,回写后必须核对非 ASCII 内容未变

**规则**:任何「读出全文 → 改写 → 写回」的操作(脚本批量替换、格式化、生成器、编辑器之外的文本通道)必须两个方向都显式 UTF-8:Node `fs.readFile(f, "utf8")` / `Buffer` + `TextDecoder`(默认 UTF-8);Python `open(f, encoding="utf-8", newline="")`;PowerShell 必须 `-Encoding utf8`,禁止依赖 `Get-Content`/`Set-Content`/`Out-File` 的 ANSI 默认值。回写后**必须**核对:diff 只命中预期行,且非 ASCII 文本零变化(乱码标记字符 `鈹 锛 銆 鈥` 与 U+20AC 计数为 0、抽查一段中文、`--numstat` 行数合理)。

**Why**:BUG-026——`9b077bd` 一次整文件回写把 `ui/style.css` 504 行中文注释变成 `鈹€鈹€ 涓诲璇濆尯鍩熸秷鎭竷灞€...` 这类双重编码乱码:UTF-8 字节被按中文 ANSI(CP936) 解码后重新以 UTF-8 写出,非法字节对按 `?` 兜底还吃掉了 ASCII 字节。文件仍是合法 UTF-8(grep/`file`/agent 读到的都是乱码但没有任何报错),坏点混在正常 diff 里直接提交,恢复不可逆(`?` 处字节已丢)。同批回写还夹带了真实代码改动,使「整份取父版本」的粗暴恢复方式失效。

**How to apply**:写批量改写脚本前先确认读/写两侧都显式 UTF-8;写回后立刻跑门禁 `bun run check:encoding`(或 `node scripts/check-encoding.mjs`;给未跟踪文件用 `node scripts/check-encoding.mjs <file>`)。门禁三项:非法 UTF-8 字节、乱码特征字符(GBK 误读 UTF-8 的标点/外来字母/PUA 残片)、双重编码指纹(阈值经 67455 行干净语料校准:0 误报、对坏版本召回 493/507 行)。提交侧由 `.githooks/pre-commit` 拦暂存区(`git config core.hooksPath .githooks`;`--no-verify` 绕过需在 commit 描述写明理由)。确需在文档里引用乱码做证据,把该文件加进 `scripts/check-encoding.mjs` 的 `EVIDENCE_DOCS`(仅豁免乱码指纹,编码合法性仍查)。给 agent 的整文件改写任务(含 `scripts/`、`host/` 里的生成器)同样适用。review checklist:diff 里出现大段非 ASCII 中文改动 ↔ 是否预期;出现无 `encoding=` 的 `open(`、无 `-Encoding utf8` 的 `Set-Content`、`toString("latin1"/"binary")` ↔ 该处是否真的在处理非 UTF-8 数据源。真出事时的恢复顺序:先用「引入该次改动的提交 diff 的 `-`/`+` 行对」逐 hunk 精确回填,不要反解乱码(本例反推会漏 2/3 的行)。

**关联**:BUG-026

### RULE-010: 升级 @oh-my-pi/* 底座版本后必须实跑 check 与 host:build,禁止只改版本号就交付

**规则**:改动 package.json 里任何 `@oh-my-pi/*` 版本 pin(或重装 node_modules)后,必须依次实跑 `bun run check` 与 `bun run host:build`,两者全绿才算升级完成。check 内含 `check-omp-imports`(`scripts/check-omp-imports.mjs`):对 `host/host.ts` 与 `scripts/build-host.ts` 干跑 `bun build --target=bun`(打包不执行、链接期校验命名导出),底座导出改名或子路径 exports 删除会在此显式报错。

**Why**:BUG-036——底座 18.5.0 把版本哨兵方案重构为版本戳,`build-host.ts` 深路径 import 的导出名消失,`host:build` 加载期即炸;本仓 tsconfig 只覆盖 ui-src,`host/` 与 `scripts/` 对底座的子路径(`pi-tui/chat/transcript-entry` 等)与深路径(`pi-natives/native/...`)依赖零静态门禁,不实跑无从发现。上游对这两类取用路径不承诺稳定。

**How to apply**:升级流程固定为:改 pin → `bun install` → `bun run check` → `bun run host:build` → 需要发版再走 ui:build + tauri build。check 报 `No matching export` / `Could not resolve` 时按报错同步调用点(深路径参照 BUG-036 的内联处理)。注意守卫的 tree-shake 边界:干跑只对「真实调用点」的漂移可靠,升级后仍须实跑 host:build 兜底。review checklist:diff 含 `@oh-my-pi/*` 版本变化 ↔ 同一改动内出现过 check 与 host:build 的执行记录。

**关联**:BUG-036
