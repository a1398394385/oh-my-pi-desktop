# 交接：oh-my-pi desktop（库内嵌路线）落地

日期：2026-09-19。上游仓库：`/Users/xys/github/oh-my-pi`（Pi fork，TS 160 万行 + Rust 23.5 万行，bun workspace）。参考成品：`/Volumes/MacApps/Github/omp-gui`（第三方 GUI，走的是另一条路线，见下）。已装 app：`/Applications/omp.app`（就是 omp-gui 打包，v0.9.6，Electron）。

## 任务一句话

给 oh-my-pi 做一个 desktop 应用，架构对标 etower-agent（一个主进程持有多个并发 session + 桌面/网页 UI），**已拍板走库内嵌路线**：单个 Bun 宿主进程 `import { createAgentSession }` + `Map<sessionId, AgentSession>` + WebSocket 桥到 UI 壳。不做独立工作区隔离（用户明确说不需要）。

## 已定决策（不要重开）

1. **库内嵌**，不是 RPC/ACP 子进程路线。理由：工具在宿主进程内直接跑，免掉 host-tool 桥（文件读写/bash client bridge 那套）；底座 210MB 全 session 摊薄。真机对照：omp-gui（子进程路线）9 个会话 ≈3GB，库内嵌同场景估算 ≈400MB。
2. **壳 + Bun 宿主双进程**是被迫的，不是选型偏好：omp 硬绑定 Bun（coding-agent 314/1367 文件、777 处 `Bun.*` 专有 API，`engines` 仅 bun≥1.3.14），Electron/Node 主进程不能直接 import。壳选 Electron/Tauri 皆可（agent 反正在 Bun sidecar 里）。
3. 多顶层并发 session **必须传 private `AgentRegistry`**（`options.agentRegistry`，`packages/coding-agent/src/sdk.ts:609`；默认全局 registry 每 generation 只许一个 "Main" 身份，不传会撞）。
4. **共享底座**：`settings` + `modelRegistry`（auth 挂在它下面）全进程一份，逐 session 只传 `sessionManager` + `agentRegistry`。实测不共享 = 每 session 10–15MB，共享 = 1–2MB。

## 已核实的关键事实（全部带证据，直接信）

- **SDK 入口**：`createAgentSession(options)`（`src/sdk.ts:1335`，JSDoc 有最小用例）；`docs/sdk.md` 是 headless 嵌入官方文档。返回 `{ session }`，`session.subscribe(listener)` 拿事件流（`agent-session.ts:4460`）、`session.dispose()` 收尾。
- **AgentSession 零 TUI 耦合**：1.1 万行的 `agent-session.ts` 对 pi-tui 的 import 数为 0，构造只注入纯数据 host 接口（`agent-session.ts:1295`、`agent-session-types.ts:126`）。
- **单进程多 session 先例**：ACP 模式已是协议服务器——`#sessions = new Map` + new/load/list/fork（`src/modes/acp/acp-agent.ts:614`），照抄它。子代理执行器也是同进程多 `createAgentSession`（`src/task/executor.ts:3763`）。
- **会话持久化**：默认按 cwd 分桶的 per-session JSONL（`~/.omp/agent/sessions/<encoded-cwd>/*.jsonl`，`session-manager.ts:1864`）；有 SQLite/PG/MySQL/Redis 后端（`session/sql-session-storage.ts:12`）和 `SessionManager.inMemory()`。恢复/切换 = `session.switchSession(path)`，fork = `session.fork()`。
- **park/revive 现成**：idle agent 生命周期管理（`src/registry/agent-lifecycle.ts`）——park = dispose 活 session 保 AgentRef+sessionFile，按需 revive。用它做非活跃会话 LRU。
- **内存实测**（bun 1.4.2 单进程，Bun.gc 后）：底座 import 完成 ≈210MB（heap 32 + Rust native 180）；共享底座后 per-session 骨架 ≈1–2MB；**transcript 恢复放大 ≈20x 磁盘体积**（4.6MB jsonl → +90MB，单样本，条目碎的会话放大率高、大 blob 工具结果占比高则低）；**dispose 后 RSS 短窗口内不回落**（未深挖，集成时建议验证 park 是否真还内存）。未量：活跃 turn 瞬态（需真 LLM 花钱）、MCP 挂载增量。
- **RPC/ACP 也有**（如果后续要跨进程形态）：`omp --mode rpc`（stdio NDJSON，`docs/rpc.md`）和 `omp acp`（Agent Client Protocol，多 session）。omp-gui = 前者 + patch 了 RpcClient 补工具审批桥（extension UI 订阅不在原生协议里）——库内嵌不需要这层。

## 落地路线（建议顺序）

1. Bun 宿主最小进程：`createAgentSession` × N（共享 settings/modelRegistry、private registry、inMemory 或磁盘 manager），WebSocket 暴露 create/list/prompt/steer/abort/subscribe。验收：CLI 或浏览器页同时驱动 2+ 会话。
2. 壳：Electron（最省事，renderer 直连宿主 WebSocket）或 Tauri。只做窗口 + 会话侧栏 + transcript 渲染。
3. UI 素材**整包抄 collab-web**（`packages/collab-web`，MIT，运行时零依赖 coding-agent，含 30 个工具渲染器，协议类型用 `@oh-my-pi/pi-wire`，npm 已发布）；omp-gui 的 vendored 版是现成参考。
4. 非活跃会话接 park/revive 做内存 LRU（长会话 transcript 放大 20x 是唯一内存大头）。
5. 后置：工具审批 UI（宿主内实现 host 接口即可，不学 omp-gui 的 patch 桥）、模型切换（`set_model` 类能力参考 RPC 命令面 `rpc-types.ts:30-57`）。

## 坑清单

- 本地源码仓跑 SDK 前：`bun install`（仓库根）+ 把全局安装里的 `pi_natives.darwin-arm64.node` 复制到 `packages/natives/native/`（`/Volumes/MacApps/Home/.bun/install/global/node_modules/@oh-my-pi/pi-natives-darwin-arm64/` 有现成的；bazel 全量编 Rust 太重，没必要）。
- 别从桶文件 `src/index` import 探针类脚本——它 re-export 了 html 导出，需要 `tool-views.generated.js`（要跑 `gen:tool-views`）。从具体模块 import（`./src/sdk`、`./src/session/session-manager`）绕开。
- `createAgentSession` 默认路径会 `refreshInBackground`（模型目录网络刷新）；传共享 `modelRegistry` 时不重复 refresh。想量纯内存先 `disableExtensionDiscovery: true` + 干净 cwd。
- 包目录名 ≠ npm 名：`packages/coding-agent` = `@oh-my-pi/pi-coding-agent`；`packages/agent` = `@oh-my-pi/pi-agent-core`（Agent 类在 `packages/agent/src/agent.ts:373`，`subscribe` 在 `:838`——etower 用的同源 fork）。
- omp 上游活跃（PR 刚开放 trial）；自己 fork 做 desktop 要计划好跟上游节奏，pi-wire/collab-web 按双仓共享设计可以直接用。

## Suggested skills

- `prototype`：宿主进程 + 双会话驱动的最小验证（第 1 步）就是典型 throwaway prototype。
- `grill-with-docs`：如果新项目要正式设计（壳选型、wire 协议、LRU 策略），用它逐决策 grill 并落 ADR。
- `implement` / `tdd`：路线第 1–2 步进入实现时。
- `code-review`：每个里程碑自查。
- `i-have-adhd`：用户输出风格偏好（结论先行、下一步动作结尾）。

## 本会话相关工件

- 内存实测与全部证据细节：etower-agent 项目 memory `oh-my-pi-rust-core-survey.md`（含 09-19 desktop 补充节）——新项目 agent 读不到，需要就回来抄。
- omp 官方文档：`docs/sdk.md`（嵌入）、`docs/rpc.md`（协议）、`docs/cli-reference.md`（全部启动形态）、`docs/session-switching-and-recent-listing.md`（session 目录布局）。
