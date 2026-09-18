# 完成定义验证记录

8 条逐项验证，2026-09-19 实测。环境：macOS arm64，omp 18.2.5，rustc 1.96.1，tauri 2（CLI 2.x / core 2.11.5）。

## 1. cargo build 与 npm run tauri dev 通过，应用窗口能起来 ✅

```
$ cd src-tauri && cargo build
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.80s   （0 error 0 warning）

$ npm run tauri dev
    Finished `dev` profile ... Running `target/debug/omp-desktop`
```

窗口出现（截图 /tmp/omp-ui-7.png，1440×920，三栏布局 + 状态面板 + composer），
启动即自动 spawn omp 子进程并进入"已就绪"。

## 2. 左栏列出会话，点击可切换 ✅

- 列表来源：只读扫描 `~/.omp/profiles/omp-desktop/agent/sessions/**`（按 cwd 过滤、mtime 倒序）。
- 实测：左栏出现两个历史会话（"未命名会话 · 刚刚 / 4 分前"），点击第二项触发
  `[omp_spawn] called resume=Some("…/sessions/-/2026-09-18T16-11-32….jsonl")`，
  Rust 侧以 `switch_session` 恢复上下文（截图 omp-switch-7.png：标题、模型、上下文占用全部切换）。
- `⌘N` / "新建会话"按钮 → `new_session` 路径（无 resume 参数 spawn）。

## 3. 流式渲染（message_update）+ 工具卡片（tool_execution_*） ✅

- 发送 prompt 后用户气泡立现，右上角"生成中"，agent 期间有思考动画占位。
- deepseek 会话实测：`▸ 思考过程` 折叠块（thinking_delta 渲染）、正文流式追加、
  完成后定稿渲染（截图 omp-e2e-15.png：思考块 + 工具行 + "done" 回复）。
- 工具卡：`write  Creating e2e-desktop.txt file ●`（运行中脉冲点）→ 完成绿 ✓ / 失败红 ✗，
  可展开查看工具输出（tool_execution_end.result）。
- omp 的重复帧（每事件两遍）由前端按 `role:timestamp` / `toolCallId` 幂等去重，无双份渲染。

## 4. 写文件审批：允许后工具成功，拒绝后工具不执行 ✅

允许分支（截图 omp-e2e-13/15.png）：
- UI 弹出审批卡（`extension_ui_request` + `method:"select"`），多行 title 拆分展示：
  `Allow tool: write` / `Path: e2e-desktop.txt` / `Content:` + 代码块 `hello`，按钮 Approve / Deny / 取消。
- 点 Approve → 工具行变绿 ✓，模型回复 done：
  `ls -la /Users/xys/e2e-desktop.txt` → `-rw-r--r-- 1 xys staff 5 … e2e-desktop.txt`，内容 `hello`。

拒绝分支（截图 omp-e2e-18.png）：
- 点"取消"（发 `cancelled:true`）→ 卡片定稿"✓ 已取消（未放行）"、工具行红 ✗
  （`tool_execution_end.isError:true`，"Tool call denied by user"）：
  `ls /Users/xys/e2e-deny.txt` → `No such file or directory`。

## 5. 生成中停止（abort），状态回到可继续 ✅

- 2000 词长文生成中按 Esc → toast "已发送中断"（`abort` 命令）→ 右上角回"已就绪"、
  发送按钮恢复、输入框可继续输入（截图 omp-abort-2.png）。

## 6. 右栏实时状态（get_state） ✅

状态面板四分区（截图 omp-e2e-8/9.png）：
- 进程：`todoPhases` 渲染（✓/◐/○ 状态、完成 N/总数 M）；本验证会话无清单时显示"暂无任务清单"。
- 模型：`deepseek/deepseek-flash`（get_state.model），切换模型后立即更新（524K→1.0M 上下文窗口同步变化）。
- 思考档位：`high`（当前模型的 `thinking.efforts` 之一，档位下拉只列 efforts 数组值，透传原值）。
- 上下文占用：`25K / 1.0M` + 百分比条（contextUsage）。
- 运行中的智能体：`get_subagents` 快照（空时显示"无运行中的智能体"）。
- 值域验证：模型下拉列出 omp 返回的全部 8 个模型（DeepSeek/K3/K2.8/MiniMax×2/spark/bonsai/Big Pickle），
  当前项打勾；`set_model {provider, modelId}` 两字段切换成功。

## 7. 退出无孤儿进程（含异常路径） ✅

正常退出（截图验证，见对话记录）：
```
$ pgrep -f "omp --mode"    → 83513（我的会话子进程）
[关闭窗口]
$ ps -p <app_pid>          → app exited
$ ps -p 83513              → omp 83513 exited
$ pgrep -fl "omp --mode"   → （空；仅剩其他 workspace 应用的进程，与本应用无关）
```
清理链：窗口关闭 → `RunEvent::Exit` → `shutdown_all()` 逐会话
关 stdin → 等 `wait()`（宽限 5s）→ 超时才 `start_kill()`。
异常路径：dev 期间多次 watcher 重启（kill 旧 app），旧 omp 子进程均随 `kill_on_drop` +
优雅关闭被回收，多次重启后 `pgrep` 无累积残留。

## 8. 探针脚本仍是绿的 ✅

```
$ cd probe && PATH="$HOME/.bun/bin:$PATH" bun mode-probe.mjs rpc-ui --model deepseek/deepseek-flash
reason: agent_end
errors: []
uiRequests: select "Allow tool: write\nPath: probe.txt\nContent:\nok"（审批帧，另含 2 次 setWidget）
tools: write start→end isError:false
texts: toolResult "Successfully wrote 3 bytes to probe.txt" / assistant "done"
ready: {protocolVersion:1, supported:[1,2], maxFrameBytes:1048576, maxReassembledFrameBytes:67108864}
$ cat /tmp/omp-probe/probe.txt → ok
```

说明：默认模型 `llama/spark-x2.5` 在 2026-09-18/19 两轮 90s 超时（协议栈正常、模型不发起工具调用，
证据见 docs/IMPLEMENTATION-NOTES.md §2.5）；探针为此增加了可选 `--model` 透传参数（不改协议语义），
用可用模型跑通全链路。本实现未改动 omp 侧任何行为。
