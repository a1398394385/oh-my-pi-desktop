# 实现笔记（IMPLEMENTATION NOTES）

记录本实现与《zcode-desktop-功能手册》（下称"手册"）/ `docs/rpc.md` 不一致的地方，以及偏离原因。
采集基准：omp 18.2.5，2026-09-19 实测。

## 1. 与手册 / RPC 文档不符的实测事实

### 1.1 `get_available_models` 的 data 是 `{models: [...]}`，不是裸数组

- `docs/rpc.md` 与手册 §16.3 写的是 `getAvailableModels(): Promise<ModelInfo[]>`（裸数组）。
- 实测响应：`{"type":"response","command":"get_available_models","success":true,"data":{"models":[...]}}`。
- 处理：前端读 `data.models`。**原因**：以实测为准；文档滞后。

### 1.2 omp 会把部分事件帧重复发送两遍（手册未记载）

- 实测同一帧 `turn_start` / `message_start` / `message_end` / `tool_execution_start` / `tool_execution_end` /
  `extension_ui_request(select)` 各到达两次（内容完全相同）；`response` / `agent_start` / `agent_end` / `ready` 不重复。
- 已核对 `rpc-mode.ts` 只有一次 `session.subscribe`，重复发生在 omp 内部（未继续深挖根因）。
- 处理：**渲染层按 key 幂等去重**——`message_end` 按 `role:timestamp`、工具行按 `toolCallId`、审批按请求 `id`。
  不去重会出现双份工具卡/双份审批按钮。

### 1.3 `get_messages_page` 只包含已"定稿"的消息

- 被 abort 的 turn、或进程被杀时未完成的 turn，其 assistant 消息**不落盘**，resume 后
  `get_messages_page` 的 `totalMessages` 只统计已定稿消息（实测一个只有 user 消息的会话返回 `total: 1`）。
- 处理：历史渲染如实反映存储内容，不做补齐。**这不是 bug**：与手册 §17.3 "model-visible means logged"
  的存储语义一致（未完成的内容对模型也不可见）。

### 1.4 `prompt` 成功响应可能不带 `data.agentInvoked`

- `docs/rpc.md` 说 prompt ack 带 `data.agentInvoked`；实测（omp 18.2.5）响应为
  `{"command":"prompt","success":true}`，无 `data` 字段。
- 处理：完成信号只依赖 `agent_end`（`isTerminal !== false`），与文档对旧运行时的建议一致。

## 2. 实现决策与手册的偏离

### 2.1 工作目录默认值：HOME，而不是进程 cwd

- 手册 §18 未约定默认 cwd。Tauri dev 下 app 进程 cwd 是 `src-tauri`、打包后是 `/`，都不能用。
- 处理：`omp_spawn` 的 cwd 解析顺序 = 显式参数 > 环境变量 `OMP_DESKTOP_CWD` > `HOME`。
  MVP 不做目录选择器（范围后置），左栏底部显示当前 cwd。

### 2.2 每会话一个 omp 子进程，切换会话 = 关旧进程 + resume 新进程

- 手册 §18.2 的 actor 模型（每会话一个 tokio task 持有子进程）已照做。
- 与"daemon 常驻多会话"的差异：MVP 同一时刻只保留当前会话的子进程，切换会话时
  `omp_close`（关 stdin → 等退出 → 超时 kill）旧进程、用 `--resume`（Rust 侧 `switch_session`）拉起新进程。
  **原因**：控制进程数量（omp 是 bun 进程，单个数百 MB），退出清理路径只有一条，进程卫生最简单。
  代价：非活跃会话不保活（生成中禁止切换会话，UI 有提示）。

### 2.3 审批的 fail-closed 落点

- UI：审批卡总是提供"取消"按钮（发 `cancelled: true`），Esc 也触发取消；未知的 `extension_ui_request`
  method 一律自动取消，绝不默认放行。
- 退出：关闭窗口 → `RunEvent::Exit` → 逐会话关 stdin。按 `docs/rpc.md`，stdin 关闭后 omp 拒绝所有挂起的
  UI/宿主请求（omp 侧 fail closed），实测退出后无孤儿进程。
- 已验证：approve → 文件创建；cancel → 文件不存在，工具以 `isError:true` 结束。

### 2.4 Tauri 2 全局 API 的命名空间

- `withGlobalTauri` 注入的 `window.__TAURI__` **没有 `ipc` 命名空间**；`Channel` 与 `invoke` 都在
  `__TAURI__.core` 下（tauri-2.11.5 `scripts/bundle.global.js` 实测）。
- 前端按 `T.core.invoke` / `T.core.Channel` 取用。

### 2.5 探针脚本增加了可选 `--model` 参数

- 背景：默认模型角色（`llama/spark-x2.5`，本地 llama 服务）在 2026-09-18/19 实测中两轮 90s 超时——
  协议栈正常（ready/negotiate/prompt ack/事件全到、0 错误响应），卡在模型不发起工具调用。
  手册 §18.6 当天实测是绿的，差异来自模型行为而非协议。
- 处理：`probe/mode-probe.mjs` 增加 `--model provider/model`（仅透传 omp CLI 参数，不改协议语义）。
  `bun mode-probe.mjs rpc-ui --model deepseek/deepseek-flash` 实测绿：
  `agent_end` 正常结束、write 审批弹出且执行成功、`probe.txt` 内容正确、0 错误响应。

### 2.6omp 二进制的定位

- 手册 §18.4 建议 sidecar 随包分发；MVP 未做（明确后置项之外的成本）。
- 现状：按 `~/.bun/bin/omp` → `/Volumes/MacApps/Home/.bun/bin/omp` → `/opt/homebrew/bin/omp` →
  `/usr/local/bin/omp` → PATH 的顺序探测。GUI 启动时 PATH 不含 `~/.bun`，所以前两项是必须的。

### 2.7 会话切换期间禁止再次切换

- 实测踩坑：`onReady`（get_state + 拉历史）完成前 `S.sessionFile` 尚未更新，
  此时点击列表会重复 spawn 同一 resume 目标。
- 处理：`S.loading` 期间 `switchSession` 直接提示"会话加载中"；旧 channel 的迟到事件
  （`desktop_exit` 等）按 key 过滤，避免污染新会话 UI / 弹错误 toast。

## 3. 已知限制（范围内取舍）

- 前端无框架、无虚拟滚动：千条消息以上的会话渲染性能未优化（手册 §18.7 待确认项）。
- `steer` / `follow_up` / `compact` / `handoff` / 宿主工具桥（`set_host_tools`）未接：属后续能力。
- 右侧边栏四类标签（辅助对话/审查/终端/浏览器）、Diff 语法高亮、设置中心：任务明确后置。
- 上下文占用条取自 `get_state().contextUsage`，事件间隙不实时刷新（agent_end/tool 结束时刷新）。
- 流式渲染按 `message_update` 的 `text_delta` / `thinking_delta` 增量追加；`toolcall_delta` 不渲染
  （等 `message_end` 的完整 toolCall，由 `tool_execution_start` 呈现）。
