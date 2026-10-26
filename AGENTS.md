# AGENTS.md

## 项目定位与底座

- 本应用是 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的桌面客户端，采用库内嵌架构：单一 Bun 宿主进程通过 `@oh-my-pi/pi-coding-agent` SDK 持有并驱动所有 AgentSession。
- 底座源码（本机路径）：`D:/Documents/Github/oh-my-pi`；换机时按实际位置调整。涉及底座核心行为、会话生命周期、Agent 运行时、模型目录（catalog）与工具执行机制时直接读该源码，不要猜。

## 项目架构（三区职责）

1. **Tauri 桌面外壳（`src-tauri/`）**：原生窗口、菜单、托盘、单实例锁；启动并管理 Bun 宿主进程，向前端传递动态 WebSocket 端口。
2. **Bun 宿主进程（`host/`）**：共享底座（authStorage / modelRegistry / settings）；会话池 `Map<sessionId, PoolEntry>`；通过 WebSocket 向 UI 提供双向 RPC。
3. **Web 前端（`ui-src/`，构建产物 `ui/dist/`）**：React 19 + TypeScript + Vite + zustand；HTML 入口 `ui/index.html`，样式入口 `ui/style.css`。

模块地图、技术栈、store 与样式约定、图标系统见 [docs/systems/frontend.md](docs/systems/frontend.md)；子系统链路与排障见 [docs/systems/](docs/systems/)。

## 代码注释规范

注释只记录代码表达不了的信息：**why / 约束与不变量 / 否决过的方案 / 外部坑 / 事故或规则编号**。禁止复述代码、注释掉的代码、无主 TODO、与实现不同步的说明。

- 改代码必须在同一次改动内更新相关注释；注释与代码冲突时**以代码为准**，并把不一致当缺陷上报（agent 的验证优先级：运行结果与测试 > 代码 > 注释）。
- 删除注释前先确认它不是唯一记录；唯一信息先迁到 `.agents/BUGS.md` / `docs/PITFALLS.md` / ADR / `docs/systems/`，再删并留指针。
- 注释一律英文；中文只允许出现在 `ui-src/i18n/` 语言包与用户可见文案。
- 判据、删除五问、review checklist、分波治理计划与验收命令见 [docs/comment-style.md](docs/comment-style.md)（SSOT）。

## UI 全站约束

视觉决策以 VSCode 源码为准（深色对齐 Dark+、浅色对齐 Light+）。设置页控件、按钮尺寸、动效、弹出卡片、图标必须复用全站既有语言，禁止页面私有覆盖。

- SSOT：[docs/systems/ui-conventions.md](docs/systems/ui-conventions.md)（设置页一致性 / 动效 / ring-pop 弹卡）与 [docs/systems/frontend.md](docs/systems/frontend.md)（样式域 / 图标系统）。
- 颜色与动效只走 `ui/css/global/tokens.css` 的 token；未导入 Preflight；复合类保留 CSS 定义；`@import` 顺序 = 级联顺序，跨域移动或调整顺序必须验证渲染等价。

## 开发与行为规范

1. **语言**：思考与解释用中文；代码注释用英文；用户可见文案走 `ui-src/i18n/`（规范见 `ui-src/i18n/README.md`），禁止新写硬编码中文文案。
2. **机器资源安全红线**：禁止裸跑 vitest / 多包并发测试，所有测试必须带单 worker 池参数；长跑命令被中断或超时后必须检查并清理残留进程。
3. **Profile 隔离红线（最高优先级）**：测试/冒烟/探针只用 `omp-desktop-test`（统一经 `scripts/smoke-profile.ts` 的 `smokeEnv()`）；开发只用 `omp-desktop-dev`（`dev` 脚本已内置）；严禁任何测试或开发运行污染 `default`。细则见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
4. **真机验证红线**：`?preview=1` 只加载样例、不连 host，不得冒充真机验证；按验证目标选通道（`dev:browser` / CDP 连 Tauri dev 窗口 / 远程控制形态）。细则与并发规则见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
5. **编码红线**：全部文本文件 UTF-8，整文件回写的读写两侧必须显式 UTF-8。规则 SSOT 见 `.agents/rules.md` RULE-009，乱码恢复见 BUG-026；`bun run check` 含编码与注释语言门禁。
6. **交付报告**：任务收尾必须报告五要素——①可观察行为/契约变化；②主要改动文件；③**实际跑过**的测试与检查及结果；④跳过的验证及原因；⑤已知风险、兼容性影响与遗留的用户决策。红线：未实际执行的测试/构建/手工验证，不得声称已通过。

## 文档体系

- 写/改任何 `.md` 前先读 [docs/documentation.md](docs/documentation.md)（类型登记表 / 决策树 / 长度预算 / SSOT / 维护原则）。
- `.agents/` 是 agent 工作文档区：防回归 RULE（`.agents/rules.md`）、事故账本（`.agents/BUGS.md`）、ADR（`.agents/notes/`），入口 [.agents/README.md](.agents/README.md)。
- 外部依赖坑记 `docs/PITFALLS.md`；实施合同与验收矩阵记 `docs/architecture/`；一次性治理计划完成后删除（见各文档头部状态）。

## 本文件维护

内容边界与维护原则见 [docs/documentation.md](docs/documentation.md) §5「AGENTS.md 内容约束」——本文件只放指针与全站硬约束，模块级约束、低频多步流程、可机器化的规则一律下沉到对应文档或脚本。
