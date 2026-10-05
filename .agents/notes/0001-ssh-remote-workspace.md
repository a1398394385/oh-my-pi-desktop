# ADR-0001: 采用本地桩目录 + OMP 原生 ssh:// 实现 SSH 远程工作区

**Status**: Accepted（2026-10-05）
**Decider**: desktop 维护者
**Informed by**: oh-my-pi 底座 `packages/coding-agent/src/{ssh,internal-urls/ssh-protocol,discovery/ssh}.ts`（18.5.0 已安装版同构）、`.agents/README.md`

## Context（背景）

桌面端欢迎页项目菜单的「远程连接」此前是占位 toast。需求：像 VS Code Remote-SSH 一样连接远端机器上的工作区。约束：

- 底座 OMP 原生远程模型 = `ssh.json` 主机表（用户级 `~/.omp/agent/ssh.json`、项目级 `.omp/ssh.json`）+ agent 经 `ssh://<host>/<path>` 内部 URL 读写列远端文件（1 MiB 文本上限）+ bash 里 `ssh <alias> '<cmd>'` 执行远端命令；`ssh://` 协议处理器随每个 AgentSession 默认注册（主机在 ssh.json 时可用）。
- 桌面宿主是 Windows 常见环境：无 sshfs、无 ControlMaster，「把远端挂成本地 cwd」的路线在本平台不可行。
- SDK `createAgentSession` 只接受本地 cwd；`SessionManager` 的会话目录由 cwd 派生。

## Decision（决策）

复用 OMP 原生模型，不为桌面另造远程执行通道：

1. **本地桩目录**：每个远程工作区（host + remotePath）映射到确定性本地目录 `<profile remote dir>/workspaces/<host>--<slug>`，内放 `.omp/remote-workspace.json` 标记（host/remotePath）。标记文件是远程身份的唯一事实源（mtime 缓存读取）。
2. **会话照常本地跑，prompt 完全归底座**：桩目录即 cwd，create_session/load_session 全链路复用（会话存储、分支、压缩、项目列表）。**不向 system prompt 注入任何桌面侧「远程工作区」节**（2026-10-05 复审移除首版实现：底座没有该形态，桌面改写提示词属越权分层；agent 对远程工作区的感知与 TUI 一致——底座在 PATH 有 ssh 时自注入 `ssh://` 用法文档，具体 host/path 由用户对话告知）。
3. **主机管理走底座文件**：RPC `ssh_list/save/remove_host` 直接读写用户级 ssh.json（SDK `ssh/config-writer` 深路径导入，经 bootstrap 装载闸门），变更后 reset 底座 capability 缓存（与 `/ssh` 命令一致），在跑会话的 `ssh://` 解析随即重读。
4. **连接校验真实探活**：`add_remote_workspace` 先 `ssh -o BatchMode=yes` 远端 `test -d` 校验路径存在，失败回 `ok:false`（不落桩）；成功落桩并回 cwd，前端接 `add_project` + `setWelcomeProject` 走既有新建任务流。
5. **UI 展示**：`session_list` 项目行追加 `remote:true + remoteLabel("host:/path")`；侧栏/欢迎页/项目菜单显示 cloud 图标与 host:path（ProjGroup 的 ProjectIconSource 前向字段就此启用）。

## Consequences

- 不需要远端装任何 agent/端口转发；权限面 = 本机 ssh 客户端 + 用户自备凭据。
- Windows 远端主机可用 `compat` 标记（OMP 既有语义），桌面不改。
- 桩目录误删后：项目列表仍在（omp-desktop.json 记录 cwd），远程标记随标记文件消失退化为本地目录展示；重连同 host+path 会重建同一桩目录（确定性派生）。
- ssh.json 用户级为桌面管理面（项目级留给 CLI 用户）；改名/删主机不迁移引用它的桩（标记按名引用）。
- 验证：`scripts/smoke-ssh.ts`（OMP_PROFILE=omp-desktop-test）覆盖 CRUD/落盘、探活成败两路、路径校验、桩+标记、create_session、session_list 装饰，并临时拉起 Git-for-Windows sshd 做真实 E2E（无 sshd 环境自动降级为仅基础断言）。

## Alternatives Considered（备选）

1. **sshfs 挂载为 cwd（远端目录本地化）**：POSIX-only，Windows 宿主直接不可行；且 1 MiB 之外的二进制场景 OMP 已建议 sshfs 作为 agent 侧补充而非工作区根。未选。
2. **远端跑 omp 会话（真 Remote Agent）**：底座无此形态（SDK 无远程 cwd/远程执行通道），需自造协议与远端部署，规模远超需求。未选。
3. **桩目录里写项目级 `.omp/ssh.json` 钉住单主机**：自包含但与用户级凭据漂移（改端口/换钥匙后项目副本陈旧且排查困难）。未选，仅用用户级。
4. **omp-desktop.json 里登记远程工作区清单（标记文件之外的第二事实源）**：双源必然漂移；标记文件随目录走，单一事实源。未选。
5. **桌面侧向 system prompt 注入「Remote SSH Workspace」节**（首版实现，后移除）：能让 agent 自动知道工作区 host/path，但底座并无此机制——桌面改写提示词越权且与 TUI 行为分叉；用户对话告知 agent 即可达到同样效果。已移除。
