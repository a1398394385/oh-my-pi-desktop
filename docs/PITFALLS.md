# 踩坑记录（2026-09-19 重做 session）

本 session 从 RPC 子进程路线重做为库内嵌路线过程中踩过的全部坑，附证据位置。新会话接手先读这份，能省掉重复排查。

## 架构与选型

- **RPC 子进程路线内存不可行**：每会话一个 `omp --mode rpc-ui` 子进程，各吃一份 ≈210MB 底座（9 会话实测 ≈3GB）。库内嵌单宿主：2 会话 385MB。这是整个重做的起点。
- **omp 硬绑定 Bun**（314/1367 文件、777 处 `Bun.*`），Electron/Node 主进程不能直接 import——壳+宿主双进程是被迫的。

## SDK 装配（host/host.ts）

- **`setProfile` 必须先于 coding-agent 的 import 执行**：其模块在 import 时读取 agentDir（cli.ts:108 注释）。宿主结构：先 `import "@oh-my-pi/pi-utils"` 调 `setProfile("omp-desktop")`，再动态 `import("@oh-my-pi/pi-coding-agent")`。
- **pi-tui 的 `theme` 是延迟初始化单例**（theme.ts:84 `export var theme` 初始 undefined）：TUI 启动流程才 `ensureThemeSync()`，headless 嵌入没人调 → ask 工具的 `theme.status.success`（ask.ts:121）直接 TypeError 崩。
- **Bun 对命名导入做快照**：`const { theme } = await import(...)` 后再初始化，已解构的绑定不更新（命名空间对象 `m.theme` 才是 live）。所以 `ensureThemeSync()` 必须在 coding-agent（连带 ask.ts）**加载之前**调用，事后初始化救不了。
- **多顶层并发会话必传私有 `AgentRegistry`**（默认全局 registry 每 generation 只许一个 Main 身份）。
- **`SessionManager` 没有公开 cwd getter**：恢复会话的原始 cwd 要从 `getEntries()` 的 `type==="session"` header 条目读（`open()` 内部同源做法）。
- **会话目录名编码不可逆**（`/`→`-`），别自己扫目录解码——`SessionManager.listAll()` 直接返回所有 project 的 `SessionInfo`（含正常 cwd）。
- **JSONL 里被 abort 的 turn 不定稿**：工具崩掉/进程被杀的 turn，其 assistant 消息和 toolResult 不落盘——排查"没看到错误"时别只查 jsonl，看宿主 stderr。
- **模型启用配置是 settings 键 `enabledModels`**（config.yml 顶层），条目可带 `:thinking` 默认级别后缀（如 `kimi-code/k3-256k:max`）；`getAvailable()` 返回全部 93 个，要自己过滤。切模型时按条目应用默认思考级别与 CLI 行为一致。
- **思考级别 getter 返回钳制后生效值**：`setThinkingLevel("medium")` 后 deepseek-flash 读回 `low`（模型能力钳制）。UI 显示生效值；支持档位来自 `getSupportedEfforts(model)`（`model.reasoning ? model.thinking.efforts ?? [] : []`，pi-catalog/model-thinking）。
- **`resolveApprovalFromContext` 是 execute-time 解析**（approval.ts:66）：`settings.override("tools.approvalMode", ...)` 运行中生效，下一个工具调用即按新模式。settings 全进程共享 → 切换影响所有会话。settings 缺失时 fail-closed 到 always-ask。**子代理内部强制 yolo**（executor.ts:1008）。
- **流式中 `prompt()` 不带 `streamingBehavior` 直接抛 `AgentBusyError`**（agent-session.ts prompt 的 isStreaming 分支）：不是排队而是报错。排队转向必须显式传 `streamingBehavior: "steer"`（idle 时该参数被忽略照常开 turn）。未消费 steer 队列操作走 `agent.peekSteeringQueue()` / `replaceQueues()`（连已 claim 进投递准备的都能取消，followUp 必须原样传回否则被清空）；用户消息识别用 `session/queued-messages` 的 `isUserQueuedMessage`（队列里混有图片描述/magic keyword 等隐藏 notice，不能按 index 盲改）。冒烟见 `scripts/steer-smoke.ts`。

## 审批与 ExtensionUIContext

- **只调 `setToolUIContext(uiCtx, true)` 不够**：审批 gate 的 `runner.hasUI()` 判的是 `#uiContext !== noOpUIContext`（runner.ts:897），而 runner 的 uiContext 由 `extensionRunner.initialize(actions, ctxActions, cmdCtxActions, uiContext, "rpc")` 注入——照抄 ACP（acp-agent.ts:2631-2632）。漏了这步 = 非 yolo 下所有需审批工具报「no interactive UI available」直接失败（write 报错、文件不落盘，turn 却正常结束，极易误判为"没弹审批"）。
- **`initialize` 的 actions / contextActions 不能用空对象占位**：runner.ts:695 `this.#getModel = contextActions.getModel` 是直接赋值（无 `??` 兜底），空对象 → `#getModel` undefined；而每次 customTool 执行都先经 `createCustomToolContext`（sdk.ts:987）求值 `ctx.model` → `getModel is not a function`，**整个 customTools 面不可用**（单元直调 `execute()` 看不出来）。第 3 参 `commandContextActions` 同理：传 `{}` 会让 `#waitForIdleFn` / `#newSessionHandler` 变 undefined（runner.ts:704 有 `if` 守卫，传 undefined 才保留 no-op 默认）。见 BUG-015。
- **`ExtensionUIContext` 至少要实现 `select` + `confirm` + `editor`**：ask.ts:914-920 把 `context.ui` 包成 `{select, editor}` trampoline，缺 `editor` 时 ask 的「Other」自定义输入路径 `undefined is not a function` 崩（表现为"ask 起不来"）。
- **`tool_execution_start` 在审批之前发出**（gate 在 wrapper.execute 内部）：审批冒烟不能用"批准后收到 tool 事件"做断言（时序随模型行为变），用测试文件是否落盘做硬断言。
- **审批帧走 `DialogOptions.signal`（AbortSignal）取消**：监听 abort 时 `resolve(undefined)`（拒绝语义），否则 agent 中止后挂起 Promise 泄漏。

## Subagent 事件

- **AgentEvent 联合类型没有 subagent 事件**（pi-agent-core types.ts:1133-1143）：子代理是同进程独立 AgentSession，事件不冒泡到父 `session.subscribe`。
- **官方通道是根会话的 eventBus**（sdk.ts:1341 创建并传给 executor，整棵 spawn 树共享）：channel `task:subagent:lifecycle`（started/completed/failed/aborted + agent 名 + description + sessionFile）、`task:subagent:event`（payload `{id, event}`，event 是子会话 AgentSessionEvent 原样转发，text_delta 直接可用）。`CreateAgentSessionResult.eventBus` 就是它。
- 实测 deepseek 子代理可能只调 yield 不输出文本 delta（右栏流视图 text 为空属正常，工具行有值）。

## Tauri / WKWebView

- **`kill_on_drop` 是 tokio 专有**；std Command 没有等价物，且 **tauri dev 杀进程树时 `RunEvent::Exit` 回调可能来不及跑**——宿主被两次实测遗留成孤儿。兜底：宿主轮询 `process.kill(ppid, 0)`，父进程消失自杀（2s 间隔）。
- **原生 `<select>` 的弹出菜单不可靠**（一个能开一个点不开，无规律）：全部换自绘 button+浮层。
- **CSS zoom 与 position:fixed 二次缩放**：`body.style.zoom=z` 时 fixed 子菜单的 left/top 被再乘 z（实测偏移 ≈ 二次方），渲染偏移 + 点击命中错位——表现为"选模型没反应"。修法：zoom 只作用于布局容器；菜单设自身 `zoom=z` 且 `left/top = 视觉坐标 / z` 补偿。
- **事件绑定选择器泛选**：`#approval-bar button` 会把后加的下拉按钮圈进审批绑定（点击发 `set_approval_mode undefined` 刷屏宿主错误日志）。选择器带 `[data-mode]` 收窄。
- **改 `ui/` 或 `host/` 不触发 dev watcher**（只 watch src-tauri/）：`touch src-tauri/src/lib.rs` 强制重启。
- **WKWebView 无 console**：`window.onerror` / `unhandledrejection` 写进页面元素才能看到前端错误。
- `invoke` 在 `window.__TAURI__.core` 下（withGlobalTauri 注入的对象没有 ipc 命名空间）。
- **`tauri build` 不监听 `ui/`：改前端后必须 `touch src-tauri/build.rs` 才会重新嵌入资源**。`tauri-build` 只 emit `cargo:rerun-if-changed` 给 `tauri.conf.json` 与 `capabilities`（见 `target/release/build/omp-desktop-*/output`），**不含 `frontendDist` 目录**。后果：只改 `ui/` 后跑 `tauri build` 会报「编译成功 / Finished bundle」，但嵌入的仍是上一次的资源，产出的 app 跑的是旧 UI。更坑的是**二进制字节数可能完全相同**（Mach-O 段对齐吸收了压缩资源的尺寸差），`ls -la` 完全看不出差异——判据必须用 `md5`，或看 `target/release/build/omp-desktop-*/out/tauri-codegen-assets/` 下是否出现了新哈希名的文件。强制重嵌：`touch src-tauri/build.rs && bunx tauri build --bundles app`。只出 .app 不要 dmg：`--bundles app`（`tauri.conf.json` 的 `bundle.targets` 是 `"all"`）。

## macOS GUI 自动化

- macOS **无 `timeout` 命令**（zsh；用工具超时参数兜底）。
- 系统 python3 无 Quartz 模块；CGEvent 用 swift：`CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, ...)`（老的 `CGEventCreateMouseEvent` 已被 Swift 废弃）。
- 点击前必须先激活窗口（`System Events` set frontmost），否则首次点击被当激活吞掉。
- CGEvent 坐标是屏幕绝对坐标；screencapture 的窗口截图是 2x Retina 且含标题栏——换算：屏幕 y = 窗口 bounds y + 图y/2。
- zsh 把 `====`、`(+` 这类词当 glob 解析会炸命令——分隔符用 `---`。
- 杀进程/找窗口都先按 cwd 归属区分（多 workspace 并行同名应用）：`lsof -p PID | awk '/cwd/'`。

## 验证方法论

- 三冒烟分层：`smoke.ts`（建会话→prompt→落盘→load 恢复历史）、`smoke-approval.ts`（always-ask→审批帧→批准→文件落盘硬断言）、`smoke-subagent.ts`（诱导 task 工具→lifecycle/event 帧）；后加 `smoke-model.ts`（切换+钳制回执）。真模型跑 `OMP_DESKTOP_MODEL=deepseek/deepseek-flash`（默认模型本地 spark 慢到拖死验证）。
- 冒烟脚本结束要清理测试产生的会话文件和测试产物（fail 路径也要）。
- GUI 验证用"截图实测"而不是心算坐标：坐标点击失败时先裁剪截图测量元素实际像素位置再重试。

## GUI 自动化验证（2026-09-19 UI 原型重写轮）

- **双 tauri dev 并存会互相污染**：压缩前遗留的后台 dev 与用户新开的 dev 共享同一 src-tauri/target，重编译互相踩踏、两个应用实例并存，用户看到的窗口可能是旧前端/新宿主的混合体（表现为"下拉菜单不见了"）。验证前 `ps` 确认只有一个 dev、一个应用、一个宿主，多余实例按 cwd 区分归属后逐个清掉。
- **用户环境 Stage Manager 会吞窗口**：窗口被收纳后 CGWindowList 里 bounds 变成屏外负坐标迷你值（如 -307,1010,118×119）、`screencapture -l` 报 could not create image、System Events 的 `count of windows` 恒为 0（AX 树不列收纳窗口）、`set_position/set_size` 返回 Ok 但 bounds 不动。三者同时出现基本可断定是 Stage Manager/屏归属问题，不要在窗口坐标上死磕。
- **osascript 按应用名匹配会撞同名进程**：`tell application "omp-desktop"` 匹配的是 LaunchServices 注册的 bundle（kimi28 打包版同名），dev 裸二进制（target/debug/omp-desktop）不受影响。要精确操作 dev 实例必须 `first process whose unix id is <pid>`。
- **CGEvent 合成点击对 Stage Manager 缩略图/App Exposé 无效**：鼠标事件能 post 到普通窗口，但唤回收纳窗口这类窗口管理操作不被响应；临时出路是 `defaults write com.apple.WindowManager GloballyEnabled -bool false && killall WindowManager`（可逆，用完问用户是否恢复）。
- **窗口启动复位写进壳里**（lib.rs setup：unminimize + set_position(300,130) + set_size(1280×820) + show + set_focus；conf 同值 + minWidth/minHeight）：用户有把窗口缩到极小拖到角落的习惯，复位保证每次 dev 重启窗口可见可截。Stage Manager 开启期间这些调用会被压制但退出后位置仍正确。
- **前端错误上报通道**：WKWebView 无 console，`window.onerror`/`unhandledrejection` 除显示到状态栏 + toast 外，再经 WS 发 `ui_error` 给宿主打到 stderr（dev 日志可见），是从外界断言"前端零 JS 错误"的唯一手段。
- **冒烟脚本默认模型是本地慢模型**：`bun run scripts/smoke*.ts` 不带环境变量会在 prompt 断言上超时（90s/120s 不够）；带 `OMP_DESKTOP_MODEL=deepseek/deepseek-flash` 跑即全绿。
- **CDN 上传缓存串图**：连续 Read 多张 /tmp 截图可能返回同一 URL（缓存命中错误），换全新文件名再传。

## Windows MSI 打包 / native addon（2026-09-26 测试机启动崩溃）

- **`bun build --compile` 出来的 omp-host.exe 不含 pi_natives，npm 装的依赖里没有提取来源**：官方编译流程要先跑 `gen:native`（`packages/natives/scripts/embed-native.ts` 把 `.node` 打成 `embedded-addons.<platform>.tar.gz`，生成带 `import ... with { type: "file" }` 的 `embedded-addon.js`，bun 编译时嵌成 asset），但该脚本**只存在于上游源码仓**——npm 包 `files` 字段不含 `scripts/`，发布时 `embedded-addon.js` 已被 reset 成 `embeddedAddon = null` 的 stub。直接编译出的 exe 在干净机器上启动即崩 `Failed to load pi_natives native addon`（loader-state.js `maybeExtractEmbeddedAddon` 对 null 直接跳过，候选路径全空）。**假象**：目标机上 `~/.omp/natives/18.2.6/` 若有历史残留 `.node` 就能正常跑（测试机 21:47 成功 22:13 崩溃即残留被清掉），开发机上永远复现不了。
- **修复**：`scripts/build-host.ts` 编排 embed → compile → reset（照搬上游 `ci-release-build-binaries.ts`）。**reset 必须放 finally**：非 stub 的 `embedded-addon.js` 会让 dev 模式误判成 compiled——`detectCompiledBinary` 第一条就是 `if (embeddedAddon) return true`（loader-state.js），误判后 leaf 包目录不进候选、dev 直接崩。
- **哨兵校验必须用 Node Buffer**：`containsVersionSentinel`（version-sentinel.js）依赖 `Buffer.indexOf(字符串)` 的子串搜索；传 `Uint8Array` 时其 `indexOf` 只查单字节恒返回 -1，哨兵明明在文件里也报"版本不一致"。
- **npm 的 win32-x64 leaf 包只有 baseline 变体**（无 `-modern`）：AVX2 机器 `selectCpuVariant` 选 modern 后 loader 自动回落 baseline（候选序列 modern→baseline→default），功能等价性能略降，不是 bug。
- **报错信息里的 GitHub latest 下载链接对旧版本是坑**：`buildHelpMessage` 生成的是 `releases/latest/download/...`，latest 已是 18.3.x，哨兵 `__piNativesV18_3_2` ≠ 18.2.6，`validateLoadedBindings` 会拒之门外（报 "reinstall to re-sync"）。救急要拷本机 `node_modules/@oh-my-pi/pi-natives-win32-x64/` 里同版本 `.node` 到目标机 `~/.omp/natives/18.2.6/`。
- **验证法**：把本机 `~/.omp/natives/18.2.6` 改名模拟干净机器 + exe 拷独立目录跑，`PI_DEBUG_STARTUP=1` 看 stderr 依次出现 `[startup] native:extractEmbeddedAddon:start` → `native:loadNative:done`，且 `18.2.6/` 被自动重建。产物判据：exe 从 ~112MB 涨到 ~151MB（内嵌 tar.gz ≈37.6MB）。
- **git-bash 里没有 `bunx`**：用 `bun x tauri build --bundles msi --config src-tauri/tauri.windows.conf.json`。
