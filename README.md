# omp desktop（最小 MVP）

omp（oh-my-pi）桌面壳。**库内嵌路线**：单个 Bun 宿主进程内嵌 `@oh-my-pi/pi-coding-agent` SDK 持有全部会话（仿 etower-agent 的 session 池形式），不是每会话一个 `omp --mode rpc` 子进程——后者每会话吃一份 ~210MB 底座，9 会话 ≈3GB；本路线实测 2 会话共 385MB（单进程）。

## 架构

```
┌─ Tauri 壳（src-tauri）──────────┐        ┌─ Bun 宿主（host/host.ts）─────────┐
│ 窗口 + WKWebView 加载 ui/ 静态页 │        │ 库内嵌 omp SDK                     │
│ spawn 宿主、转发 WS 地址          │ ────▶  │ 进程级底座×1（auth/model/settings）│
│ 退出时 kill 宿主                 │        │ Map<sessionId, AgentSession>       │
└─────────────────────────────────┘        │ 每会话私有 AgentRegistry + inMemory│
        ▲ WebSocket（动态端口）             └───────────────────────────────────┘
        └────────────── ui/app.js 直连 ────────┘
```

- 会话 = 宿主进程内一个 `createAgentSession()` 实例，工具在宿主内直接执行，无 host-tool 桥
- 协议：命令 `{create_session|prompt|get_messages}` + 窄事件 `{turn_start|text_delta|tool|turn_end}`（按 sessionId 路由）
- 会话不落盘（`SessionManager.inMemory()`），关进程即丢；持久化/park-revive/审批 UI 均后置

## 跑

```bash
bun install
OMP_DESKTOP_MODEL=deepseek/deepseek-flash bunx tauri dev   # 默认模型是本地慢模型，建议覆盖
```

宿主可独立验证（不经 Tauri）：

```bash
OMP_DESKTOP_MODEL=deepseek/deepseek-flash bun scripts/smoke.ts   # 真模型全链路冒烟
bun scripts/probe-sdk.ts                                          # 仅装配探针
```

## 验证记录（2026-09-19）

- `scripts/smoke.ts`：create_session → prompt → 收到流式 delta → turn_end → transcript 快照，全部断言通过
- GUI（CGEvent 自动化 + 截图）：新建会话 → 发消息「打个招呼并用 bash 执行 ls /tmp | head -3」→ 工具行「⚙ bash」在宿主内执行 → 流式回复列出文件名；再建会话 2 并发对话、切回会话 1 历史完整
- 内存：2 会话（含刚完成的双 turn）单宿主进程 385MB；对照 RPC 子进程路线同规模 ≈660MB+

## 后置（见 docs/handoff-2026-09-19.md 五步路线）

会话落盘与恢复、非活跃会话 park/revive LRU、工具审批 UI、模型切换 UI、打包 sidecar。
