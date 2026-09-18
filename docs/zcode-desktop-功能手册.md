# ZCode 桌面端功能手册

> 用途：作为 **omp desktop 套壳**的功能规格基线。
> 采集时间：2026-09-18。ZCode 安装路径 `/Applications/ZCode.app`。
> 证据级别标注：**[实测]** = 通过 UI/AX 树/截图直接验证；**[源码]** = 从 app.asar 提取的文案或结构；**[未验证]** = 存在但未实际走通。

---

## 0. 总览与信息架构

ZCode 是 Electron 桌面壳，把"CLI 编码智能体"包装成图形工作台。三层模型：

| 层级 | 概念 | 说明 |
|---|---|---|
| 工作区 | workspace / 项目 | 一个仓库目录，会话挂在项目下 |
| 任务 | task / thread / 会话 | 一次智能体会话，含消息流、变更、状态面板 |
| 会话内部 | turn / 迭代 | 一轮提问-执行，状态面板按轮次折叠 |

[源码] i18n 键命名空间印证了这套模型：`taskList.*`、`chat.*`、`sidebar.*`、`settings.*`、`git.*`、`automations.*`、`bots.*`、`webRemoteControl.*`、`resourceManager.*`。

窗口布局（左到右）：

```
┌──────────────┬──────────────────────────────────────────────┬──────────────┐
│ 左侧栏       │ 会话区（标题栏 + 消息流 + 底部输入区）        │ 侧边面板     │
│ 命令面板     │  ＋右上角浮着状态面板（进程/计划/目标/Git）   │ 辅助对话/审查│
│ 任务/项目树  │                                              │ 终端/浏览器  │
│ 账号+设置    │                                              │ 独立第三栏   │
└──────────────┴──────────────────────────────────────────────┴──────────────┘
```

状态面板浮在会话区右上（可收成胶囊）；侧边面板是与会话区并列的第三栏。两者独立，详见 14。

---

## 1. 左侧栏（任务与项目导航）

### 1.1 顶部命令面板区 [实测]

| 元素 | 行为 | 快捷键 |
|---|---|---|
| 新建任务 | 在当前工作区开新会话 | ⌘N |
| 搜索 | 打开搜索/命令面板 | ⌘K |

[源码] `quickPick.command.*` 定义了 ⌘K 面板可执行的命令全集（见第 10 节）。

### 1.2 视图切换区 [实测]

- **分组 / 项目** 两个图标 tab，切换任务列表的聚合方式：
  - `项目` 视图：按项目分区展开，项目下挂任务。
  - `分组` 视图：扁平任务列表，每条显示所属仓库标签（如 `workspace`、`etower-agent`、`default`）。
- **筛选和排序** 菜单：仅两项排序方式 —— `更新时间` / `创建时间` [实测]。
- **关闭**：收起当前视图面板。
- [源码] `taskList.pinnedSection` = 已置顶、`taskList.recentSection` = 最近任务。

### 1.3 列表区 [实测 + 源码]

分区顺序：`已置顶` → 项目分区 → 任务。

任务项 hover 出现的操作（`taskList.*`）：

```
置顶任务 / 取消置顶任务      taskList.pin / unpin
重命名任务                   taskList.rename
删除任务                     taskList.delete
归档任务（本地 / 远端）      taskList.archive / archiveLocal / archiveRemote
取消归档任务                 taskList.unarchive
标记为未读                   taskList.markAsUnread
在分屏打开                   taskList.openInSplitPane
反馈问题                     taskList.feedback
查看调用轨迹                 taskList.viewModelTrajectory
恢复                         taskList.resume
```

任务状态标签（`taskList.status.*`）：

```
生成中 / 恢复中 / 已就绪 / 已完成 / 失败 / 未就绪
等待确认（权限或用户输入）    taskList.permissionTag / userInputTag
手机正在操作此任务            taskList.mobileActive
```

其他列表细节：`显示更多 / 显示更少` 分页、相对时间（刚刚 / N分 / N小时 / N天）、`选择 Agent`（多 provider 时出现）。

项目分区操作 [实测]：`添加项目`、`移动项目分区`、项目项 hover 的 `更多 / 查看文件 / 新建任务`。

### 1.4 底部账号区 [实测 + 源码]

- 账号下拉（显示用户名 + `Pro` 套餐徽标）。
- **移动端远程控制** 按钮（对应 `webRemoteControl.*`，[未验证] 具体流程）。
- **设置** 齿轮。
- [源码] `sidebar.profile.notLoggedIn` = 连接使用；`sidebar.exportLogs` = 下载日志。

### 1.5 左栏工具条 [实测]

`切换侧边栏`（收起整栏）、`后退`、`前进`（会话历史导航）。

---

## 2. 会话区

### 2.1 会话标题栏 [实测]

| 元素 | 说明 |
|---|---|
| 项目名 · 分支 | 如 `etower-agent · main`，点击可进 Git 操作 |
| 会话标题 | 可编辑重命名 |
| 更多 | 会话级操作菜单 |
| 在 VS Code 中打开 / 选择打开方式 | 用外部编辑器打开工作区 |
| 分享 | 复选框，分享会话 [未验证 具体权限模型] |
| 帮助 | 帮助菜单入口 |
| 切换终端 | 打开/收起底部终端面板 |
| 展开侧边面板 | 右侧状态面板的开关 |

### 2.2 消息流 [实测 + 源码]

每条助手消息的附件操作：`复制`、`编辑`、`赞 / 踩`、`分叉`（fork 会话）、`已工作 N 分 N 秒`（耗时徽标）、`展开 / 收起已更改文件`（`chat.changeSummary.expand`）、`撤销`（回滚该轮文件变更）。

文件变更卡片：`N 个文件已更改 +A -D` + 展开文件列表 + 撤销按钮。

### 2.3 顶部状态条

模型切换中会显示阶段提示（`chat.toolbar.modelSwitch.stage.*`）：`正在切换模型…` → `正在回退配置接口…` → `正在应用自定义模型供应商…` → `正在重启模型运行时…` → `正在同步会话模型…` → `正在写入工作区默认模型…`。任务运行中禁止切换供应商。

---

## 3. 输入区（Composer）

输入框占位符（`chat.placeholder.*`）：

```
新任务：向 ZCode 提问，使用 @ 添加上下文，使用 / 选择命令或能力
追问：  提出后续修改要求
排队：  继续输入以排队后续修改
```

### 3.1 @ 提及分类 [源码]

```
文件      chat.mention.files.*      搜索工作区文件并插入引用
技能      chat.mention.skills.*     引用已安装技能
子智能体  chat.mention.subagents.*  调用子智能体
画板      chat.mention.whiteboards.*
插件      chat.mention.plugins.*    显示 marketplace · 技能数 · MCP 数
会话      chat.mention.sessions.*   引用近期会话
```

### 3.2 底部按钮组 [实测 + 源码]

| 按钮 | 说明 |
|---|---|
| `+` 添加上下文 | 附件 / 文件引用（`chat.composer.actionMenu`） |
| 切换模式 | 权限/执行模式：`自动编辑`、`计划模式`、`完全访问`（`mode.label.glm.*`） |
| 上下文已用 N / 总量 M | 上下文占用，点击看详情 |
| 选择模型 | 模型菜单，含 `管理模型`、`搜索模型…` |
| 推理强度 | `关闭 / 不思考 / 开启 / 低 / 中 / 高 / 极高 / 最高`（`chat.toolbar.thoughtLevel.value.*`） |
| 发送 | 有内容时启用 |
| 电脑操作 | computer use 入口，带权限状态提示（见 11 节） |

后台任务徽标：`运行中的终端 / 打开运行中的智能体`，显示 `Bash N 个，子智能体 M 个`。

### 3.3 附件能力 [源码]

支持拖拽（`chat.attachments.dragHint`）、粘贴图片、工作区文件引用；图片/视频/PDF 有内联预览与体积上限提示。

---

## 4. 右侧状态面板

### 4.1 形态 [实测 + 源码]

- 展开态：浮在会话区右上角的卡片，标题 `状态`（`chat.summaryPanel.title`），例：`进程 5/7`。
- 胶囊态：`收起为胶囊`（`chat.summaryPanel.showMini`）/ `展开状态`（`showPanel`）。
- 展开策略下拉：`自动展开 / 始终展开 / 始终收起`（`chat.summaryPanel.displayMode*`）。

### 4.2 面板分区 [源码 `chat.statusPanel.*`]

```
进程      todo              折叠项：已完成 N 项 / 待处理 N 项 / 前面 N 项 / 后面 N 项
计划      sessionPlans      可打开计划详情（openPlan）
目标      goal              显示迭代轮次（第 N 轮迭代 / 整个会话）
终端      terminals
智能体    agents            N 运行，可停止
更改      changes
Git 工具  environment       分支 / 提交 / 推送 / 干净状态
```

交互：每条进程项可 `跳转到第 N 条问题`（点击定位到消息流对应位置）；`运行中的后台任务` 可 `停止`；`打开子智能体会话`；`钩子` 下拉 [未验证 语义]。

---

## 5. 权限确认流程 [源码 `chat.permission.*`]

触发时消息区出现 `等待确认` 卡片，操作集合：

```
允许 / 仅允许这一次
始终允许 / 允许本会话 / 始终允许本项目（命令前缀 或 仅此命令 两种范围）
拒绝 / 始终拒绝
可选反馈输入：告诉模型接下来应该怎么做...
```

键盘：`Tab / 上下键选择，回车确认`。左侧栏任务项同步显示 `等待确认` 标签。

电脑控制有专门的授权项：`允许本项目中的电脑控制`（本项目后续官方电脑控制操作不再询问）。

---

## 6. Git 集成 [源码 `git.actionMenu.*` / `git.branchSwitcher.*`]

- `提交或推送` 入口：提交对话框（当前分支 / 更改 N 个文件 / 提交消息，可 `生成提交消息`）、`包含未暂存的更改`、动作 `提交` 或 `提交并推送`。
- `推送更改` 对话框：分支 / 远程分支 / 同步状态（领先 N / 落后 M），首次推送自动建立 upstream。
- 分支切换器：搜索分支、`创建并检出新分支`（基于当前 HEAD），脏工作区时引导先提交再切换；覆盖冲突、进行中的 Git 操作、其他 worktree 占用等均有阻断提示。

---

## 7. 设置中心 [实测]

左侧导航结构：

```
基础设置
  常规        主题/平台默认、语言或区域下拉、开关组（增强 Find 与 Grep、
              Chrome 硬件加速、接受预览版更新、自动下载并安装更新、
              保持电脑运行、提问自动继续、完整保留模型 I/O、显示思考过程）
  外观        界面设置（深色/浅色/系统）、代码设置（GitHub Light / GitHub Dark）、代码预览开关
  模型设置    供应商列表（智谱 BigModel、自定义供应商）、连接方式（个人套餐）、
              GLM Coding Pro 套餐、剩余额度、管理/解绑/升级、添加模型
  浏览器控制  开启内置浏览器控制、导入浏览器数据、忽略证书校验、清除缓存 / 清除全部
  电脑控制    启用电脑控制、在输入框显示电脑操作按钮
Agent 能力
  记忆        工作区记忆开关、按项目列出记忆文件
  子智能体    列表（evidence-auditor / oracle / researcher…），每个显示模型、工具数、
              描述，可切换启用/删除，支持新建
  插件        插件/MCP/技能三分栏（已安装、停用开关、详情）
  MCP 服务器  已安装 MCP（如 codegraph stdio），按来源分组，可新建
  技能        已安装技能列表（含描述、启用开关、删除）
  命令        自定义命令（空态 + 新建）
  钩子        生命周期钩子（SessionStart / UserPromptSubmit 等，命令 + 开关）
数据与统计
  索引库      索引相关开关
  使用统计    累计/峰值 Token、最长聊天时长、连续天数、每日/每周/累计曲线、
              模型用量占比（含应用用量 / 个人套餐切换）
  引导        新手引导入口
```

---

## 8. 快捷键

[源码] 主进程 menu accelerator：

```
⌘N  新建任务        CmdOrCtrl+N
⌘O  打开            CmdOrCtrl+O
⌘W  关闭窗口        CmdOrCtrl+W
⌘+ / ⌘= / ⌘- / ⌘0  界面缩放
```

[实测] UI 内标注：`⌘K` 搜索（命令面板）。
[未验证] 命令面板中存在 `上一个任务 / 下一个任务 / 返回 / 前进` 等命令，但未确认其默认按键。

---

## 9. 命令面板命令全集 [源码 `quickPick.command.*`]

```
新任务 / 打开工作区 / 搜索文件 / 设置
上一个任务 / 下一个任务 / 查找任务 / 返回 / 前进
切换主题到深色 / 切换主题到浅色
MCP 服务器 / 个性化 / 技能
切换侧边栏 / 切换终端 / 切换预览
添加终端标签 / 添加浏览器标签 / 添加审查标签
切换面板 / 显示/隐藏浏览器面板 / 切换到差异面板
问题上报 / 我的反馈 / 用户社群 / 产品文档
连接 / 断开连接
```

---

## 10. 电脑控制（Computer Use）[实测 + 源码]

- 入口：设置 → 电脑控制（总开关）；输入区工具栏 `电脑操作` 按钮。
- 状态提示：`正在启用电脑操作插件…` / `已就绪` / `缺少 macOS 权限，点击完成授权` / `启用失败`。
- 实现形态：`/Applications/ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app`
  —— 独立辅助 App，内含 `ax_native.node`（原生 Accessibility 模块，约 937KB）与 node_modules。
- 权限模型接入上文 `chat.permission.cua.*`。

---

## 11. 桌面壳工程架构（源码事实，做套壳可直接参考）

app.asar（294MB）内部结构：

```
/out/main       20 文件 2.9MB     Electron 主进程（窗口、菜单、IPC、更新）
/out/preload     6 文件 2.5MB     index.cjs + cuaPermissionPanel.cjs
                                  + embeddedBrowserJavaScriptDialog.cjs
                                  + codingPlanWebview.cjs + resourceManager.cjs
                                  + browserVideoRecorder.cjs
/out/renderer 4081 文件 44.4MB   React 界面（i18n 字典：assets/IntlProvider-*.js，10854 条 key）
/out/host       15 文件 3.7MB     智能体宿主服务
/out/scheduler   1 文件 2.0MB     定时任务调度（自动化用）
```

`Resources/` 下的伴随资产：

```
cua-helper/      电脑控制辅助 App（见第 10 节）
tools/           内置 bfs、ripgrep、ugrep（打包自带检索工具）
glm/             模型相关资源
config/          运行时配置
macos-window-bounds/
```

可复用的三处设计：

1. **i18n 键命名空间即功能边界**：`taskList.*` / `chat.*` / `settings.*` / `git.*` / `bots.*` / `resourceManager.*`，可直接当模块划分。
2. **preload 按能力拆分**：权限面板、内嵌浏览器对话框、资源管理器、录屏各自独立 preload。
3. **检索工具外置**：不依赖宿主环境，随包携带 ripgrep/bfs/ugrep。

---

## 12. omp 对接映射（套壳技术底座）

omp = `@oh-my-pi/pi-coding-agent` v18.2.5，命令入口 `/Volumes/MacApps/Home/.bun/bin/omp` → `dist/cli.js`。

### 12.1 现成能力（无需自研）

```
omp --mode=rpc-ui   ✅ 套壳唯一可用模式（原因见 12.2）
omp --mode=rpc      纯协议模式，无 UI 上下文，不要用于套壳
omp --mode=text / json / acp   其他输出模式（非套壳场景）
omp -c / -r <id>    继续 / 恢复会话
omp --session-dir   指定会话存储目录
omp --profile       隔离 profile（认证、会话、设置、缓存）
omp --model/--smol/--slow/--plan   多档模型角色
omp --thinking      off|minimal|low|medium|high|xhigh|max|auto（对应 ZCode 推理强度）
omp --plan-yolo     计划模式 + 自动批准，对应 ZCode 的计划模式/完全访问
omp --advisor       每轮被动审查并注入提示（对应状态面板"智能体"一类的旁路能力）
```

配置目录：`~/.omp/agent/...`（用户级）、`.omp/...`（项目级）。

### 12.2 rpc 与 rpc-ui 的真实差异（两条独立 UI 通道）

> 本节经源码复核（2026-09-18，`~/github/oh-my-pi` 源码树）与实测（18.6）**重写**。早期版本称"rpc 模式下需要 UI 的扩展/工具直接失败"，该结论**已被源码证伪**，原补丁式注释一并删除。

omp 有**两条互不相干的 UI 通道**，混为一谈会得出相反结论：

| 通道 | 载体 | `rpc` | `rpc-ui` | 谁在依赖它 |
|---|---|---|---|---|
| **Runner 通道** | `RpcExtensionUIContext` → `initializeExtensions(session, { uiContext })` → `runner.initialize(actions, uiContext, mode)` | ✅ 注入 | ✅ 注入 | 全部注册工具的审批（含内置 write，统一经 `ExtensionToolWrapper` 包装）；扩展 UI（select / confirm / input / setWidget …） |
| **工具上下文通道** | `AgentToolContext.ui` 与 `hasUI`，由 `ToolContextStore` 持有 | ❌ 不注入（`setToolUIContext` 传 `undefined`） | ✅ 注入 | eval prelude 审批、ask 工具、custom tool 的 UI hooks、交互式 PTY 的 `ctx.hasUI` 判定 |

源码位置：`packages/coding-agent/src/modes/rpc/rpc-mode.ts:1068`（`runRpcMode` 内部**无条件**构造 `RpcExtensionUIContext` 并注入 runner）；`cli/main.ts` 只在 `rpc-ui` 分支传 `setToolUIContext`。另注意 `sessionOptions.hasUI` 是 **session 级**标志，不控制审批，早期版本把它当成了审批开关。

因此真实边界是：

- **审批不是 rpc 的失败点**：runner 通道两种模式都在，所以 `rpc` 下审批照样弹 `extension_ui_request`（18.6 实测一致即由此而来）。
- **只在 `rpc-ui` 下可用的**：工具上下文通道。eval prelude 审批读的是 `ctx.ui`，`rpc` 下为 undefined，必然抛 `requires approval but no interactive UI is available`（该文案出自 `wrapper.ts`，但普通工具审批走 runner 通道，rpc 下恒为真、不会触发）。
- 另有一条独立副作用：`--mode=rpc-ui` 强制 `PI_NO_PTY=1`（bash 不走 PTY）；`PI_NO_TITLE=1` 两种模式都设。

结论：**选 `rpc-ui`**（两条通道都具备），但要清楚 `rpc` 的问题不是"审批会坏"，而是少一条通道、且 PTY 可用性不同。

#### 交互式 PTY 的三条件（套壳必读）

`dist/types/tools/bash-pty-selection.d.ts` 与 `cli.js` 里的判定函数：

```js
function canUseInteractiveBashPty(pty, ctx) {
  if (!pty) return false;                              // ① bash 调用带 pty: true
  if (process.env.PI_NO_PTY === "1") return false;      // ② 未被禁用
  return ctx?.hasUI === true && ctx?.ui !== undefined;  // ③ 有 UI 上下文
}
```

| 运行形态 | ① | ② | ③ | 交互式 PTY |
|---|---|---|---|---|
| TUI（终端直接跑 omp） | 满足 | 满足 | 满足 | 可用（`runInteractiveBashPty` 覆盖层，可从 PTY 原始输出提取终端图形） |
| `--mode=rpc` | 满足 | 满足 | **不满足**（hasUI=false） | 不可用 |
| `--mode=rpc-ui` | 满足 | **不满足**（强制 `PI_NO_PTY="1"`） | 满足 | 不可用 |

两个结论：

1. **RPC 通道（rpc 与 rpc-ui）都拿不到 omp 内置的交互式 PTY bash**，两条路各缺一个条件，不存在"切到 rpc 就有 PTY"的选项。
2. 不能靠环境变量绕：rpc-ui 分支是无条件赋值 `Bun.env.PI_NO_PTY="1"`，会覆盖你在外部传入的值。

对套壳的影响与本方案：

```
影响 1  agent 侧：需要 TTY 的命令会降级或失败（交互式脚手架、ssh 密码提示、vim/top 之类）
影响 2  套壳侧：若要做终端面板（对应 ZCode 的"切换终端"），必须自建 PTY 子系统
        （如 xterm.js + node-pty），它与 omp 的 bash 工具是两条独立通道
对策    用 set_host_tools 把自建 PTY 注册成工具注入 agent：
        agent 调用 → host_tool_call 回到客户端 → 客户端用真 PTY 执行 → host_tool_result 回传
        即套壳自己补上交互式终端能力，不依赖 omp 内置 PTY
```

### 12.3 RPC 协议面（`dist/types/modes/rpc/*.d.ts`）

传输：换行分隔 JSONL 帧；协议 v1/v2，v2 支持分块（`rpc_chunk`）与重组；单帧与重组后都有字节上限（`MAX_RPC_FRAME_BYTES` / `MAX_RPC_REASSEMBLED_BYTES`），编码解码由 `RpcFrameEncoder` / `RpcFrameDecoder` 负责，输出侧 `RpcOutputWriter` 处理背压（同步生产者可落盘）。

客户端 → 服务端的命令全集（`RpcCommand` 联合共 **42 个** type，源码逐项核对）：

```
协议：negotiate_protocol
对话：prompt steer follow_up abort abort_and_prompt abort_retry
会话：new_session switch_session branch handoff compact
状态：get_state get_session_stats set_todos get_messages get_messages_page
      get_branch_messages get_last_assistant_text set_session_name
模型与思考：get_available_models set_model cycle_model
      set_thinking_level cycle_thinking_level
      set_steering_mode set_follow_up_mode set_interrupt_mode
      set_auto_compaction set_auto_retry set_fast_mode
子智能体：get_subagents get_subagent_messages set_subagent_subscription
命令与登录：get_available_commands get_login_providers login export_html
终端：bash abort_bash
宿主能力：set_host_tools set_host_uri_schemes
```

出站帧（服务端 → 客户端）**另计**，不属于上述命令集：`ready`、`response`、`rpc_chunk`、`prompt_result`、扩展 UI 请求与回执、宿主能力请求/回执（`host_tool_call` / `host_tool_result` …）、事件帧（`subagent_lifecycle` / `subagent_progress` / `subagent_event` / `available_commands_update` 等）。

⚠️ **`get_todos` 不存在**：源码与 `docs/rpc.md` 均无此命令（早期版本的本手册曾把它写进清单，属虚构）。todos 通过 `get_state` 返回的 `todoPhases` 读取、通过 `set_todos` 写入。

扩展 UI 请求：方法 `select`（带 `options` / `optionDetails` / `timeout`）、`confirm`；响应形态 `{value}` / `{confirmed}` / `{cancelled, timedOut}`。

宿主工具桥 `RpcHostToolBridge`：客户端通过 `set_host_tools` 把自己实现的工具注入 agent；agent 调用时发 `host_tool_call`，客户端回 `host_tool_result` / `host_tool_update`，可 `host_tool_cancel`。这是套壳做原生能力工具的官方通道（对应 ZCode 的电脑控制一类扩展）。

### 12.4 RPC 客户端 API（`dist/types/modes/rpc/rpc-client.d.ts`）

```
start / stop
prompt(message, images?)      发起一轮
steer(message, images?)       运行中插话
followUp(message, images?)    排队后续消息
abort / abortAndPrompt        中断
newSession(parentSession?)    新建会话（可 fork）
getState()                    会话状态
getAvailableModels() / setModel(provider, modelId) / cycleModel()
setFastMode(enabled)
getSubagents() / getSubagentMessages() / setSubagentSubscription(level)
事件：onEvent / onSessionEvent / onSubagentLifecycle / onSubagentProgress
      / onSubagentEvent / onAvailableCommandsUpdate
```

消息分页：`pageRpcMessages`（`get_messages_page`，带 `nextCursor`、`totalMessages`，错误码 `session_busy` / `stale_cursor`）。

### 12.5 功能映射建议

| ZCode 功能 | omp 对应 |
|---|---|
| 左侧任务列表 | `--session-dir` 下的会话存储 + `newSession` / `getState` |
| 消息流 | `onEvent` + `get_messages_page` 分页 |
| 运行中插话 / 排队 | `steer` / `followUp` |
| 停止生成 | `abort` |
| 模型选择 | `getAvailableModels` + `setModel` |
| 推理强度 | `--thinking` 档位 |
| 计划模式 / 完全访问 | `--plan-yolo` 系列开关 |
| 状态面板-智能体 | `getSubagents` + `onSubagentProgress` |
| 自动编辑权限 | 权限事件（待确认 omp 侧对应 hook） |
| 设置-记忆/技能/命令/钩子/MCP | `~/.omp/agent/{memory,skills,commands,hooks,mcp}` 目录（同名概念） |

---

## 13. 未验证 / 待确认

1. ZCode 自身主进程 ↔ renderer 的 IPC 契约（preload 暴露面未解析成功，格式与常见 `exposeInMainWorld("x", {...})` 不同）。
2. `移动端远程控制`（`webRemoteControl.*`）的完整流程与协议。
3. `分享` 会话的权限模型（[源码] 存在 `conversationShare.*` 键，含 `issue` / `error` 子域）。
4. 状态面板中 `钩子` 下拉的确切含义。
5. 机器人（`bots.*`）：Telegram / 飞书 / 微信 / Webhook 接入，属另一条产品线，未纳入本手册范围。
6. 本手册明确排除：**插件市场**、**自动化（定时/闲时任务）**——按你的要求不纳入套壳范围。

---

## 14. 右侧边栏（侧边面板）

会话区右侧的常驻第三栏，宽约 320–380px，底色与左侧栏同为"第二中性层"，比会话区暗一档。

### 14.1 空态

标题 `打开标签页` + 说明 `选择要在侧边面板中打开的标签。` + 标签类型卡片网格（3 列）。点击卡片即在该栏打开对应标签。

### 14.2 标签类型（裁剪后范围）

| 标签 | 作用 | 关联入口 |
|---|---|---|
| 辅助对话 | 与主会话并行的侧边问答，不写入主线记忆链 | 输入区 / 命令面板 |
| 审查 | 变更文件列表 + diff 预览 | 命令面板「切换到差异面板」 |
| 终端 | 会话内 shell 输出 | 顶栏「切换终端」 |
| 浏览器 | 内嵌浏览器 / 本地预览 | 命令面板「显示/隐藏浏览器面板」 |

范围裁剪：**Wiki 引用已移除**（用户确认不需要）。

### 14.3 行为

- 多标签：可同时打开多个，顶部标签栏切换，单个可关闭，全部关掉回到空态。
- 顶栏面板按钮开关整栏；≤1080px 宽度下退化为右侧抽屉（点遮罩关闭）。
- 与状态面板相互独立：状态面板是会话区内的浮动卡片（进程/计划/目标/Git），侧边面板是并列的第三栏。

---

## 15. 套壳需求补记（用户确认，超出 ZCode 原有行为）

### 15.1 字体与字号可配置

| 项 | 需求 | 落地位置 |
|---|---|---|
| 字体族 | 用户可在设置中更换界面字体 | 设置 → 外观 |
| 字号 | 用户可在设置中调整界面字号（覆盖正文与 UI 标签） | 设置 → 外观 |

实现提示：

- 字号集中在 token 层：界面用 `--fs-2xs / --fs-xs / --fs-sm / --fs-base / --fs-md / --fs-lg / --fs-xl` 一套固定值，设置项只需覆盖基准值并按比例推导，不必逐元素改。
- 字体族建议给「系统默认 + 指定字体」两档；用户指定的字体不可用时要能回退，且回退不得导致布局溢出。
- 两项都是纯客户端设置，不经过 omp RPC。

**状态**：HTML 原型（`prototype/index.html`）按要求不实现，仅在本文档记录。

---

## 16. 值域必须来自 omp（原型里的值仅为样式示意）

`prototype/index.html` 中的**权限模式、模型名、思考级别全部是占位样式**，不代表 omp 的真实数据。套壳实现时必须从 omp 读取，不得硬编码本手册或原型里出现的字面值。

### 16.1 权限模式（approvalMode）

omp 真实值域只有三个（源码 `dist/types/tools/approval.d.ts`，CLI 参数 `--approval-mode`，设置项 `tools.approvalMode`）：

| omp 真实值 | 含义 | 原型里的示意文案 |
|---|---|---|
| `always-ask` | 只对解析为 prompt 层级的调用询问；免审 tier 不问（实测：`bash echo` 不询问、`write` 询问） | （原型未展示） |
| `write` | 自动批准写入类工具，危险命令仍询问 | 「自动编辑」 |
| `yolo` | 全部自动批准 | 「完全访问」 |

相关开关：`--auto-approve`（全自动批准，跳过审批）、`--plan-yolo`（先只读计划模式 → 模型首次 resolve 后自动批准 → 切实现模型），后者可对应原型里的「计划模式」。

### 16.2 思考级别（thinking）

omp 真实值域（`--thinking=<value>`）：

```
off | minimal | low | medium | high | xhigh | max | auto
```

原型里的 `关闭 / 低 / 中 / 高 / 极高 / 最高` 只是示意，缺少 `minimal`、`auto`，命名也与 omp 不一致。

**注意**：档位不是常量表。`get_available_models()` 返回的每项模型都带 `thinking` 与 `reasoning` 能力字段，可选档位应随当前模型变化。

### 16.3 可用模型（providers × models）

模型列表动态来自用户配置与 provider，结构如下（`dist/types/modes/rpc/rpc-client.d.ts`）：

```ts
type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;
getAvailableModels(): Promise<ModelInfo[]>;
```

- 切换模型用 `set_model { provider, modelId }` —— **两个字段**，不是单个模型名。
- CLI 侧的模型角色：`--model`（主）、`--smol`（快/轻）、`--slow`（推理）、`--plan`（规划），另有 `--models` 作为 Ctrl+P 循环候选。
- 原型里的 `GLM-5.3 / GLM-5.3-Flash / deepseek-flash / MiniMax-M3` 只是示意。

### 16.4 实现要求

1. 三者的取值与列表一律从 omp 读取：模型走 `get_available_models`，思考级别走当前模型的 `thinking` 能力（或 RPC 状态），权限模式走 `tools.approvalMode` 的三值。
2. UI 文案映射（如把 `yolo` 显示成「完全访问」）允许，但**传给 omp 的值必须原样透传**，前端不得自造枚举值。
3. 模型项要保留 `provider` 与 `id` 两个字段，显示名可与 `id` 不同；`contextWindow` 可直接用于上下文占用条的百分比。

---

## 17. 来自 DeepSeek Harness 的可借鉴决策

参考仓库：`~/github/deepseek-harness`（→ `/Volumes/MacApps/Github/deepseek-harness`，DeepSeek 官方开源 agent harness + Web/Electron 客户端）。它和 omp desktop 是同一类问题：把 coding agent 包成图形工作台。以下条目按"直接适用"排序。

> **版本说明（2026-09-18 复核）**：以下 17.1 基于 DSH 0.1.5 时期的 `apps/desktop/README.md`。仓库当天已 pull 到 **0.1.6-alpha.2**，桌面架构发生反转——从"私有协议 + 绝不开端口"改为**共享 Web 应用的薄包装**：Electron 加载打包的 Web 入口（`dsh-app://app/`），Host 以 `ELECTRON_RUN_AS_NODE=1` 启动，**Desktop 默认监听 19387**（Web 是 3080，可用 `webserver.config.port` patch 覆盖）；同时携带独立的 Python / Node / pnpm 发行版（Office 技能离线可用），插件管理与恢复走 Web 的 HTTP API 与原生对话框。
>
> 结论：DSH 走完"自建私有传输"后，最终选择复用现有 Web 客户端 + 本地端口。下文 17.1 关于 **omp 的 stdio 约束**仍然成立且更重要，但不要把"绝不开端口"当成 DSH 的当前立场。

来源：`apps/desktop/README.md`（Electron 壳决策表）、`docs/architecture.md`、`docs/defensive-patterns.md`、`docs/tool-execution-pipeline.md`、`SAFETY.md`。

### 17.1 通道架构：omp 用 stdio，比 DSH 更苛刻

DSH Desktop 明确**不开任何监听端口**：Electron 里跑自带 upstream Node 子进程，用 framed byte pipes 传请求/流式响应（带背压），Node IPC 只做生命周期控制，`dsh-app://` 供客户端资源。

omp 的 `--mode=rpc-ui` 走 **stdin/stdout 上的 JSONL 帧**，因此多两条硬约束：

| 约束 | 说明 |
|---|---|
| stdout 必须干净 | 任何非协议内容写进 stdout（工具日志、调试打印、子进程继承的 fd）都会破坏帧流。启动参数、日志与进度必须把 stdout 留给协议 |
| 帧有上限，会分块 | 单帧与重组后各有字节上限，协议 v2 用 `rpc_chunk` 分片；客户端必须实现重组与背压，否则大结果（长 diff、大文件）会丢帧或撑爆内存 |

另外：`--mode=rpc-ui` 会强制 `PI_NO_PTY=1`（见 12.2），shell 面板必须自建 PTY 或走 `set_host_tools`。

### 17.2 运行时自带，版本绑定为一个发布单元

DSH 的决策值得直接照抄：

- **自带运行时**：dsh 跑在打包的 upstream Node 与打包的 pnpm 上，系统 Node/pnpm 与用户包管理器配置"不在执行路径内"。
- **版本绑定**：shell、Web 客户端、后端、插件图作为**一个组合**一起发布；"独立版本会造出未经测试的组合"。
- **单实例锁 + profile 独占**：Electron 在任何 profile 访问前先拿进程级单实例锁，独占自己的 profile 与包管理器状态；CLI 与 Desktop 共享产品数据，但不共享可执行包。

对 omp desktop 的推论：**自带一份确定版本的 omp**（不依赖用户 `~/.bun` 里那份），并用 `--profile` 给套壳独立 profile，避免与用户 CLI 互相污染认证/会话/设置/缓存。

### 17.3 会话数据是 omp 的，套壳只读

DSH 的会话日志是 append-only 事件日志，格式版本化（`session.vN.jsonl[.zstd]`）、带相邻迁移链，且**已提交的 generation 永不改名/替换/删除**；配套不变量是 "model-visible means logged"——任何进入模型请求的东西都必须能从日志重建。

对套壳：

- omp 的 session 存储（`--session-dir`）归 omp，套壳不要直接写；要新会话就用 `new_session`。
- 面板状态（进程 / 计划 / 目标 / 终端 / 智能体）应来自**投影接口**（`get_state` 的 `todoPhases`、`get_subagents` 等），不要从消息文本里正则解析。
- 同理：UI 想声称"改了 X 文件"，就必须有对应的工具结果事件支撑，不能凭模型自述展示成事实。

### 17.4 审批必须 fail closed

DSH 的工具执行管线：`tools/pre-execute`（hooks / permission / sandbox）→ 单调 guards → `ctx.approval` 一次性询问 → `tools/execute` → `tools/post-execute` → 冻结结果。

关键规则：**approval 缺失或无法回答 = 拒绝**（`absent or unanswerable: deny`）；被拒绝/取消/不可用都会跳过工具主体。

对套壳：当 UI 不可用、窗口关闭、或用户没回答时，权限卡片必须走"拒绝"分支，绝不允许默认放行。对应 omp 的 `always-ask` 语义。

### 17.5 生命周期与进程卫生（血泪清单）

`docs/defensive-patterns.md` 里的规则直接适用于 Electron 壳管 agent 子进程：

1. **Dispose 必须到达静止**：kill 之后要 await 子进程退出；先关闭监听器/通知注册表再杀，避免晚到的完成事件复活已销毁的状态。
2. **异步状态不是同步状态**：`followUp` 没有逐条完成语义；`running` 区间可能被多条消息共享。不要用 `whenIdle` 当某一条消息的结果；并显式处理"根本没有可等待的事"这一分支（否则永久挂起）。
3. **正交结果分开上报**：`timedOut` / `signal` / `exitCode` 各自独立字段，别把一个嵌进另一个的分支里——否则被杀掉的运行会被读成"干净成功"。
4. **回调异常隔离**：用户监听器抛错不能拖垮调度循环，dispatch 里 try/catch 并记录。
5. **不给不可信输出环境变量与可预测路径**：给 agent 跑的子进程洗掉 `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*` 环境变量；临时/溢出文件用 0700 目录 + 随机名 + `wx` 独占打开，避免符号链接竞态与泄露。
6. **删除链接形状的路径**：先 `lstat().isSymbolicLink()` 再 `unlink`，不要对大目录用递归删除（会顺着链接删进目标）。

### 17.6 术语与事件分层

- **step** = 一次模型请求及其工具调用；**turn** = 0..n 个 step（从首个输入被认领到不再有欠账）。界面上说"第 N 轮"应对齐 turn，而不是 step。
- DSH 把事件分三域：**session events**（持久事实，重载后仍在）、**agent events**（`agent/*` 实时观测/拦截）、**capability events**（策略与适配器挂载点）。套壳订阅 omp 事件时同样要区分"可持久化的事实"与"瞬时流"，前者才能拿去渲染历史。

### 17.7 安全预期管理

`SAFETY.md` 的口径值得照抄到产品文案里：这类工具能执行模型生成的代码、加载第三方插件、访问网络/进程/凭证/文件；沙箱与审批**降低**风险但不保证隔离。建议最小权限运行、优先用一次性环境、备份可被访问的文件、审查后再放行命令。

---

## 18. Rust + Tauri 实施方案

技术栈已定为 **Rust + Tauri**。本节是与 DSH / omp-gui 对照后的落地建议。

### 18.1 权威依据：omp 自带 888 行 RPC 文档

`~/github/oh-my-pi/docs/rpc.md` 是协议权威来源（随源码分发），覆盖启动、帧传输、命令/响应 schema、事件流、并发与排队语义、扩展 UI 子协议、host tool 子协议。**实现客户端前先读它**，不要从类型定义反推。

关键约束（文档原文）：

- stdin 收命令与 UI / host-tool 回执；stdout 出 ready 帧、命令响应、会话/agent 事件、UI 请求、host-tool 请求。
- 协议 v1 单帧上限 **1 MiB**；客户端应主动发 `negotiate_protocol` 升到 **v2**，超大对象以 `rpc_chunk`（base64 分片）无损发送，重组上限 **64 MiB**。
- 启动先写 `ready` 帧（含 `protocolVersion` / `supportedProtocolVersions` / `maxFrameBytes` / `maxReassembledFrameBytes`）。
- 畸形 JSON 只产生 `command:"parse"` 失败帧，**不终止循环**——客户端不能靠"没断连"判断无错。
- stdin 关闭 → 拒绝挂起的 UI / host-tool 请求 → 排空命令 → dispose → 退出码 0。
- `@file` 参数在 RPC 模式被拒；RPC 模式默认关闭会话标题自动生成（省一次模型调用）。

### 18.2 进程模型

对照 omp-gui 的实证架构（daemon 拥有会话，而不是附着在 TUI 上：browser ← WebSocket → Bun daemon → 每会话一个 `omp --mode rpc` 子进程）：

```
Tauri 前端（React/Vue/Svelte）
   │  Tauri commands（请求/响应） + ipc::Channel（流式事件）
Rust 侧 daemon：每个会话一个 tokio task + 一个 omp 子进程
   │  stdin/stdout：JSONL 帧        stderr：独立消费
omp --mode rpc-ui
```

Rust 侧要点：

1. **会话即 actor**：一个会话一个 tokio task 持有子进程句柄，命令走 `mpsc` 投递，避免共享可变状态与锁争用。
2. **stdout 逐行解析**：`BufReader::lines()` + serde，不要 `read_to_string`（流式场景会一直等 EOF）。
3. **stderr 必须持续消费**：不读会填满管道，子进程写日志时阻塞——这是最典型的死锁。
4. **帧重组**：实现 v2 `rpc_chunk` 累积，并按 `maxReassembledFrameBytes` 设上限保护。
5. **优雅关闭**：关闭 stdin → 等退出码 → 超时才 kill；不要先 kill（会丢掉最后的落盘与 dispose）。

### 18.3 前端通信

- **commands** 用于一次性请求：`prompt`、`get_state`、`set_model`、`get_messages_page`、`set_thinking_level`。
- **`ipc::Channel`** 用于高频流式：assistant 流、工具进度、子智能体事件。Tauri 的全局 event 通道不适合高频流量。
- **不必开本地端口**：Tauri IPC 本身就是无端口通道，比 DSH 0.1.6 的 19387 更干净；只有确实需要浏览器直连时才考虑端口或 WebSocket。
- 大 transcript 必须分页（`get_messages_page` + cursor），不要把整段会话读进前端。

### 18.4 打包与运行时

- omp 走 Tauri **sidecar（`externalBin`）**随包分发，锁定版本；不要依赖用户 `~/.bun` 里那份（理由见 17.2）。
- 启动时传 `--profile <omp-desktop>`，给套壳独立 profile，避免和用户 CLI 抢认证 / 会话 / 设置 / 缓存。
- **必须显式传 `--approval-mode`**：omp 的 `tools.approvalMode` 默认值是 **`yolo`**（全自动放行），不传参数起子进程等于关掉人工确认。套壳默认应传 `--approval-mode=always-ask`，再由 UI 的审批能力决定是否放宽。
- 用 `tauri-plugin-single-instance` 防两个窗口争同一 profile。
- macOS 需要签名 + 公证；DSH 文档里的 App Store Connect API key 流程同样适用。
- 会话存储只读（见 17.3）。

### 18.5 可复用资产

| 资产 | 位置 | 用途 |
|---|---|---|
| RPC 协议文档 | `~/github/oh-my-pi/docs/rpc.md`（888 行） | 客户端实现的唯一权威 |
| 事件类型 | `@oh-my-pi/pi-wire`（npm 已发布） | 前端事件 shape；Rust 侧可照它写 serde 类型 |
| 工具渲染器 | `packages/collab-web`（MIT，omp-gui 已 vendored） | 30 个工具调用 / 结果的现成 UI |
| 参考实现 | `~/github/omp-gui`（第三方：Bun daemon + WebSocket + React） | 进程模型、多会话并发、会话列表的实证 |

### 18.6 实测结果（2026-09-18）

探针脚本：`probe/mode-probe.mjs`。每个模式各起一次
`omp --mode <x> --cwd /tmp/omp-probe --no-session --approval-mode=always-ask`，自动应答扩展 UI 帧，跑完即杀。

| 观察项 | `--mode rpc` | `--mode rpc-ui` |
|---|---|---|
| 启动 ready 帧 | `protocolVersion 1`，`supportedProtocolVersions [1,2]`，`maxFrameBytes 1048576`，`maxReassembledFrameBytes 67108864` | 同左 |
| bash 工具 | ✅ 执行成功 | ✅ 执行成功 |
| write 工具（always-ask） | ✅ 执行成功，且弹出审批 | ✅ 执行成功，且弹出审批 |
| 审批帧形态 | `extension_ui_request` + `method:"select"` | 同左 |
| 扩展 UI（setWidget） | 出现（2 次） | 出现（2 次） |
| 错误响应 | 0 | 0 |

**结论 1 — 修正 12.2 的推论**：普通工具与审批路径上两种模式**行为一致**，"必须 rpc-ui"在该路径不成立；`hasUI` / `PI_NO_PTY` 的差异只在用到扩展 UI 高级能力或交互式 PTY 时才显现。

**结论 2 — 审批的真实帧格式**（套壳必须照此实现）：

```json
{
  "type": "extension_ui_request",
  "id": "…",
  "method": "select",
  "title": "Allow tool: write\nPath: /tmp/omp-probe/probe.txt\nContent:\nok"
}
```

应答：`{ "type": "extension_ui_response", "id": "…", "value": "<选中选项>" }`（另有 `{ confirmed }`、`{ cancelled, timedOut? }` 两种形态）。
注意工具名 / 路径 / 内容都塞在**多行 title** 里，UI 需要自行拆分展示。

**结论 3 — `get_state` 是面板与工具栏的数据源**，返回字段：

```
model（含 thinking 能力 { mode:"effort", efforts:["high"], defaultLevel:"high", requiresEffort:false }
       以及 contextWindow / maxTokens / reasoning / cost / compat）
thinkingLevel   contextUsage   todoPhases        isStreaming      isCompacting
fastModeEnabled fastModeActive tokensPerSecond   messageCount     queuedMessageCount
steeringMode    followUpMode   interruptMode     autoCompactionEnabled
sessionId       systemPrompt   dumpTools
```

这直接证实 16.2：**思考档位来自模型的 `efforts` 数组**（实测模型只有 `["high"]`，不是固定 8 档），`contextWindow` 可直接用于上下文占用条。

**结论 4 — 审批是工具级判断**：`always-ask` 下 `bash echo` 未触发审批，`write` 触发了。套壳不能假设"always-ask = 每次都问"。

**限制**：每个场景只跑一次（存在模型随机性）；未覆盖 eval prelude / 自定义工具审批、交互式 PTY、多会话并发。

### 18.7 仍待确认

1. ~~eval prelude / custom tool 报 "requires approval but no interactive UI is available" 的触发条件~~ → **已由源码复核解答（见 12.2）**：触发点是工具上下文通道的 `ctx.ui` 为空，即 `rpc` 模式下的 eval prelude / ask 工具 / custom tool UI hooks；普通工具审批走 runner 通道，不受影响。
2. 千条消息 + 工具卡片的前端渲染基线（虚拟滚动阈值）。

---

## 附：最小可跑验证清单

套壳 MVP 打通以下闭环即可确认底座可用：

```bash
omp --mode=rpc-ui --cwd <repo>  # 1. 起 rpc-ui 会话（不要用 rpc）
# 2. prompt("做个自检")，观察事件流式返回（onEvent）
# 3. get_messages_page 拉消息，渲染左栏会话 + 消息流
# 4. setModel / cycleModel 切模型，对应底部工具栏
# 5. abort 中断，对应"停止生成"
# 6. getSubagents + onSubagentProgress 渲染右侧状态面板"智能体"分区
# 7. 回一条 extension_ui_response（审批是 method:"select" 帧，见 18.6），确认扩展 UI 往返正常
```

七步全绿 = 套壳底座成立，其余按左侧栏 → 状态面板 → 设置 的顺序补齐。
