# oh-my-pi desktop（套壳）· 审阅材料

给 **omp**（`@oh-my-pi/pi-coding-agent`）做桌面套壳的前期材料：一份功能基线文档、一份可交互原型、一个 RPC 探针脚本。
技术栈已定为 **Rust + Tauri**，编码尚未开始。

## 先看什么

| 文件 | 作用 |
|---|---|
| [`docs/zcode-desktop-功能手册.md`](docs/zcode-desktop-功能手册.md) | 主文档：ZCode 功能规格 → omp 对接映射 → 套壳决策与注意事项 |
| [`prototype/index.html`](prototype/index.html) | 可交互原型，单文件、无依赖，双击即开 |
| [`probe/mode-probe.mjs`](probe/mode-probe.mjs) | RPC 探针：实测 rpc / rpc-ui 的行为差异与审批帧格式 |

## 证据分级（读文档前先看这里）

主文档每节都标了来源，请按标记判断可信度：

- **[实测]**：通过 UI / AX 树 / 截图直接验证，或探针脚本实跑得到的结果
- **[源码]**：从 ZCode 的 app.asar 或 omp 包内提取
- **[推断]**：由上下文推出，未经验证
- **[未验证]**：存在但未走通

## 重点审这几处

1. **`rpc` vs `rpc-ui` 的适用范围**：手册 12.2 从源码推断"套壳必须用 rpc-ui"，但 18.6 的实测显示两者在工具执行与审批路径上**行为一致**。两处结论的边界需要判断——目前只在扩展 UI 上下文与交互式 PTY 上找到分叉依据。
2. **审批是工具级判断，不是全局开关**：同样 `--approval-mode=always-ask`，`bash echo` 不询问、`write` 会询问。审批 UI 的设计要按这个事实来（18.6 结论 4）。
3. **思考档位是模型级能力**：`get_state` 返回当前模型的 `thinking.efforts`（实测样本只有 `["high"]`），可选档位应随模型变化，不是固定 8 档；原型里的档位是样式占位（16.2）。
4. **值域不得硬编码**：权限模式只有 `always-ask | write | yolo`；切换模型需要 `provider + modelId` 两个字段；模型、思考级别、权限模式都必须从 omp 读取（§16）。
5. **右栏标签范围为四类**：辅助对话 / 审查 / 终端 / 浏览器（Wiki 引用已移除）。原型中右栏与状态面板是两套独立机制（§14）。

## 跑原型

```bash
open prototype/index.html
```

单文件、无构建步骤；所有数据为合成的演示数据，未接真实 omp。
截图见 `prototype/screenshots/`（1512 桌面三栏、430 窄屏）。

## 跑探针

需要本机已安装 `omp`（bun 全局安装）。脚本会以 `--no-session` 启动 `omp --mode <rpc|rpc-ui>`，
发一个无害 prompt 触发工具与审批，自动应答扩展 UI 帧，跑完即退出：

```bash
cd probe
PATH="$HOME/.bun/bin:$PATH" bun mode-probe.mjs rpc-ui
# 默认模型不调工具/太慢时指定模型（2026-09-19 实测 llama/spark-x2.5 两轮 90s 超时，deepseek 正常）：
PATH="$HOME/.bun/bin:$PATH" bun mode-probe.mjs rpc-ui --model deepseek/deepseek-flash
```

会真实调用一次模型（消耗调用方自己的额度），不写入会话记录。

## 当前状态

- 技术栈：Rust + Tauri（已定）
- **编码：可用版本已实现**（实现与手册的差异见 [docs/IMPLEMENTATION-NOTES.md](docs/IMPLEMENTATION-NOTES.md)）
- 下一步：设置中心 / 右侧边栏四类标签 / steer·followUp / 虚拟滚动

## 怎么跑套壳（可用版本）

要求：本机已装 Rust 工具链、Node/npm、`omp`（bun 全局安装即可，应用会自动探测安装路径）。

```bash
npm install
npm run tauri dev      # 开发模式启动，窗口起来后自动新建一个会话
```

- 会话数据：独立 profile `omp-desktop`（`~/.omp/profiles/omp-desktop/`），与用户 CLI 完全隔离；
  左栏会话列表只读扫描该目录，点击即切换（resume），`⌘N` 新建。
- 子进程参数固定：`omp --mode rpc-ui --approval-mode always-ask --profile omp-desktop --cwd <dir>`。
- 输入区：Enter 发送、生成中变红色停止按钮（或按 Esc 中断）；模型 / 思考档位下拉的值全部来自 omp
  （`get_available_models` / `get_state().model.thinking.efforts`），透传原值。
- 审批：写操作会弹审批卡，Approve / Deny / 取消（Esc）；取消即 fail closed，绝不默认放行。
- 退出：关闭窗口即退出，omp 子进程按"关 stdin → 等退出 → 超时 kill"清理，无孤儿进程。
- 工作目录默认 `HOME`，可用环境变量 `OMP_DESKTOP_CWD` 覆盖。

打包（生成 .app）：

```bash
npm run tauri build
```
