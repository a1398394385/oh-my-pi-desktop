# ADR-0002: 用 SDK tab 注册表同实例 + CDP screencast 镜像 Agent 内置浏览器

**Status**: Proposed(2026-10-05)
**Decider**: 桌面端
**Informed by**: VSCode DevTools screencast、puppeteer 25.3.0 CDP 多会话语义、host.ts 库内嵌架构注释

## Context(背景)

桌面端已把 Agent 默认路由到内置浏览器（`host/browser-config.ts` 把 `browser.relay`/`browser.cdpUrl` 固定为关闭，SDK `resolveBrowserKind()` 落到 OMP 拉起的 Chromium）。用户需求：Agent 一用内置浏览器，右栏自动展开，浏览器页实时显示 Agent 的页面操作。

约束：
- 浏览器全部生命周期在 SDK（`@oh-my-pi/pi-coding-agent`）内部，宿主只看得到泛化的 tool 事件；tab 注册表（`tab-supervisor.ts` 的模块级 `tabs` Map）与 puppeteer Browser handle 都活在宿主主线程（浏览器工具经 eval tool-bridge 回到宿主执行）。
- Agent 的 Chromium 是独立进程的页面，Tauri v2 没有 window 内嵌 webview，跨源页面也无法 iframe。
- 页面由 tab worker 线程驱动，宿主侧连接与 worker 连接是同一 Chromium 的两个 CDP 客户端。

## Decision(决策)

1. **零 SDK 改动**：宿主经包的 sub-path export（`@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor`）动态 import 同一模块实例，直接 `listTabs()`/`getTab()` 读活注册表；宿主启动不因此提前加载 puppeteer（运行时才 import）。
2. **镜像通道 = 独立 CDP 会话 + `Page.startScreencast`**：对选中 tab 的 targetId 在宿主侧 puppeteer 连接上 `createCDPSession()`，jpeg 流推给 UI。Chromium 对同一 target 多路 CDP 会话（DevTools 同款语义），不打扰 worker。
3. **协议**：三个 RPC（`browser_mirror_subscribe/unsubscribe/select`，登记进 capabilities.json）+ 两类帧：`browser_tabs`（盖章推送，带 0→n 激活边缘 `active:true`，UI 自动开栏信号；500ms 轮询 diff 后只在有变化/已订阅时发）与 `browser_frame`（不盖章 jpeg stills，走 terminal 式帧总线绕开 zustand）。
4. **UI**：右栏浏览器页双模式——Agent 实时视图（tab pills + URL 行 + 实时画面，未手动 pin 时跟随 Agent 新开的 tab）与原手动 iframe 浏览（`.mcp-type-pill` 切换）；激活边缘一次自动展开右栏并切到浏览器 tab（latch，清零后重置，不与用户手动收起打架）。
5. **带宽治理**：screencast 仅在 UI 订阅时运行（页面可见才流）；帧率下限 90ms；subscribe 携带视口宽度重配 maxWidth；断连/收起即停。

## Consequences(后果)

**正面**:
- Agent 浏览器操作第一次对用户可见，且零底座改动、零 Chromium 嵌入工程。
- 自动开栏信号复用推送帧，无需额外通知通道。
- 外置浏览器开启（relay/connected 形态）时镜像同样工作（同一 CDP 通道）。

**负面**:
- 镜像是低帧率视频流（变化驱动的 jpeg stills），不是可交互嵌入。
- 依赖 puppeteer Target 的私有 `_targetId`（一处具名 cast 读取；puppeteer 大版本升级时是已知检查点）。
- URL/title 走 500ms 轮询投影，非事件级实时。

**风险/不确定性**:
- relay 远端浏览器下 screencast 带宽受远端链路限制（默认路径是本机，不受影响）。
- cmux/tern 形态（桌面不会出现）不可镜像，UI 显式降级为"不支持实时画面"。

## Alternatives Considered(备选方案 — 必填,详细)

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| iframe 嵌入 Agent 页面 | 可交互 | 跨源/跨进程页面无法 iframe；Tauri 无内嵌 webview | 技术不可行 |
| 内嵌 chrome-devtools-frontend | 功能全、可交互 | 体积与集成成本大；DevTools UI 面向调试而非观看 | 过重 |
| 轮询 `Page.captureScreenshot` | 实现最简 | 无变化驱动，恒定轮询浪费；无 ack 背压 | screencast 有变化驱动 + ack 流控 |
| SDK 侧发浏览器生命周期事件 | 事件级实时 | 需改底座（版本耦合），且截图流仍要 CDP | 同实例 import 已拿到全部所需状态 |

### v2（2026-10-05 同日演进）：镜像双向化（交互式）

用户追问「能否直接操控右栏里的浏览器」。结论不变：Tauri v2 无法把外部 Chromium 嵌进右栏、UI webview 也无 CDP 入口，「直接操控右栏」字面不可行；等价形态是把镜像升级为**双向**——DevTools 远程调试/noVNC 同款做法：

- `browser_frame` 帧携带 screencast metadata 的 `w/h/s`（视口设备像素与 page scale），UI 把 contain-fit 画面上的事件坐标换算回页面 CSS 坐标；
- 新 RPC `browser_input`（risk: write）把鼠标按下/抬起/移动（含双击 clickCount、右键/中键）、滚轮、特殊键（Enter/Backspace/Tab/方向键等 13 键 vk 表）、可打印文本（`Input.insertText`）经被镜像 tab 的 CDPSession 走 `Input.dispatchMouseEvent/dispatchKeyEvent` 注入；
- 仅在已订阅且 attachment 匹配该 tab 时转发，其余静默丢弃；ctrl/meta/alt 组合键不拦截（应用快捷键直通）。

效果：右栏画面就是 Agent 那个浏览器本身——你点、Agent 接着操作，同一 DOM/cookie/session。备选的「headed 真窗口」模式（`browser.headless:false`）被否：窗口在 app 外、右栏反而无内容，且 headed 更易被反爬识别。

## Related(关联)
- `host/browser-config.ts`（内置浏览器默认路由，本镜像的前置）
- `scripts/smoke-browser-mirror.ts`（真实 Chromium 端到端冒烟）
- `bun run check` 门禁：capabilities / host-boundaries / omp-imports 均覆盖本特性接线
