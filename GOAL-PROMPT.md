# Goal Prompt · omp desktop 可用版本

把下面代码块里的内容整段粘进 goal 模式的新对话即可。

---

```text
用 Rust + Tauri 在 /Users/xys/Github/oh-my-pi-desktop 实现 omp 桌面套壳的「可用版本」。
目标是一次性交付：能起会话、能流式看输出、能应答审批、能中断、退出无残留进程。

## 必读（先读再动手，不要凭记忆）
1. README.md —— 材料说明与证据分级
2. docs/zcode-desktop-功能手册.md —— 功能规格与已知坑。重点：§12（RPC 协议，命令数 42、无 get_todos）、
   §14（右侧边栏四类标签）、§16（值域必须来自 omp，不得硬编码）、§18（Rust+Tauri 实施方案与进程模型）
3. prototype/index.html —— 目标 UI（单文件，浏览器直接打开就能看；视觉 token 与交互逻辑照它来）
4. probe/mode-probe.mjs —— 已验证的 RPC 交互样例（起进程 → ready → prompt → 审批应答）

## 硬约束（违反即返工，这些都有实测/源码依据）
1. 只允许 `omp --mode=rpc-ui`。启动参数必须显式带 `--approval-mode=always-ask`：
   omp 的 `tools.approvalMode` 默认是 `yolo`（全自动放行），不传等于关掉人工确认。
2. 子进程必须用独立 profile：`--profile omp-desktop`（避免与用户 CLI 抢认证/会话/设置）。
3. stdout 只走协议。任何日志、调试输出、子进程继承的 fd 都不得写 stdout；stderr 用独立 task 持续消费
   （不读会填满管道，子进程写日志时阻塞——这是最典型的死锁）。
4. 启动后先读 `ready` 帧，发 `negotiate_protocol {protocolVersion: 2}`，再发业务命令。
   v2 下超大对象会以 `rpc_chunk`（base64 分片）到达，必须实现重组，并按 `maxReassembledFrameBytes`（64 MiB）设上限保护。
5. 审批帧是 `extension_ui_request` + `method:"select"`，工具名/路径/内容塞在**多行 title** 里，UI 自行拆分展示。
   应答 `{type:"extension_ui_response", id, value}`；另有 `{confirmed}` / `{cancelled, timedOut?}` 两种形态。
   永远不要默认放行：UI 不可用、窗口关闭、用户未答 → 一律回 cancelled（fail closed）。
6. 值域一律从 omp 读：模型列表 `get_available_models`；思考档位取 `get_state().model.thinking.efforts`
   （档位随模型变化，不是固定 8 档）；权限模式只有 `always-ask | write | yolo`。
   切换模型用 `set_model {provider, modelId}` 两个字段。
7. 不要调用 `get_todos`（不存在）。todos 读 `get_state().todoPhases`，写 `set_todos`。
8. 会话数据只读：不写 omp 的 session 存储；新会话用 `new_session`。

## 完成定义（逐条给出可复现验证，不接受"看起来对"）
1. `cargo build` 与 `npm run tauri dev` 通过，应用窗口能起来。
2. 左栏列出会话（首版可从 omp 会话存储读取或先做"新建会话"），点击可切换。
3. 发一句 prompt 后，消息流**流式**渲染（消费 `message_update`），工具调用显示为卡片
   （消费 `tool_execution_start/update/end`）。
4. 让 agent 执行一次写文件操作，UI 弹出审批卡片；点"允许"后工具成功，点"拒绝"后工具不执行。
5. 生成中点"停止"能中断（`abort`），状态回到可继续。
6. 右栏显示来自 `get_state` 的实时状态：进程（todoPhases）/ 模型 / 思考档位 / 上下文占用 / 运行中的智能体。
7. 退出应用后 `pgrep -f "omp --mode"` 为空（无孤儿进程）；异常退出路径也要清理。
8. 手册 §18.6 的探针脚本仍是绿的（改动若涉及协议，先跑它）。

## 范围
做：左栏会话列表/新建、会话消息流（含工具卡片与文件变更摘要）、输入区（发送/停止、模型与思考档位下拉）、
右栏状态面板、审批卡片、深色主题（视觉对齐 prototype/index.html）。
不做（明确后置）：设置中心、插件市场、自动化、会话分享、移动端远程控制、右栏四类标签页、Diff 语法高亮。

## 工程纪律
- 本机 32GB/10 核：不裸跑测试；任何测试命令带单 worker 限制，长命令中断后检查残留进程并按 PID 清理。
- Rust 侧：一个会话一个 tokio task 持有子进程；命令走 mpsc，不共享可变状态。
- 关闭顺序：关 stdin → 等退出码 → 超时才 kill（先 kill 会丢掉最后的落盘与 dispose）。
- 不硬编码任何模型名、档位、权限模式字面值到逻辑里（UI 文案映射可以，透传值必须原样）。
- 每完成一个可验收阶段就 commit，message 说明"为什么"。

## 交付物
1. 可运行代码（Rust + Tauri），含 README 的"怎么跑"更新。
2. 一份 `docs/IMPLEMENTATION-NOTES.md`：记录了实现与本手册不一致的地方（如有）、以及为什么。
3. 完成定义 8 条的验证记录（每条给出命令与输出摘要）。

如果某个硬约束与实际情况冲突（例如 omp 行为与手册描述不符），停下来在对话里说明证据，不要静默绕过。
```
