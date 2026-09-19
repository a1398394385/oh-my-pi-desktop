# AGENTS.md

## 底层源码引用

- **底座 oh-my-pi 源码位置**：`/Users/xys/Github/oh-my-pi`
- **角色定位**：本应用是基于 oh-my-pi 的桌面客户端，采用库内嵌架构，在单一 Bun 宿主进程内通过 `@oh-my-pi/pi-coding-agent` SDK 持有和驱动所有 AgentSession。涉及底座核心行为、会话生命周期、Agent 运行时、模型目录（catalog）及工具执行机制时，请直接参考 `/Users/xys/Github/oh-my-pi` 源码。

## 项目架构

1. **Tauri 桌面外壳 (`src-tauri/`)**：
   - 管理原生窗口、原生菜单、macOS 交通灯（titleBarStyle: Overlay, x: 16, y: 18）。
   - 负责启动和管理 Bun 宿主进程（`host/host.ts`），并向前端传递 WebSocket 动态端口。
2. **Bun 宿主进程 (`host/host.ts`)**：
   - 共享底座（authStorage / modelRegistry / settings）。
   - 管理会话池 `Map<sessionId, PoolEntry>`，对接 `@oh-my-pi/pi-coding-agent` SDK。
   - 通过 WebSocket 向 UI 提供双向 RPC 协议（会话创建/加载、模型切换、分支查询与切换、权限模式、Git diff 等）。
3. **Web 前端 (`ui/`)**：
   - `ui/index.html`、`ui/style.css`、`ui/app.js`。
   - 纯原生现代 Web 技术栈，不依赖繁重前端打包框架。

## 开发与行为规范

1. **中文规范**：所有思考、分析、解释和代码注释均使用中文。
2. **机器资源安全红线**：禁止裸跑 vitest / 多包并发测试；所有测试必须带单 worker 池参数。
3. **输出风格 (ADHD Mode)**：
   - 第一行必须是可直接执行的命令、路径或代码片段。
   - 多步任务清晰编号，结尾给出 2 分钟内可完成的单一具体操作。
   - 严禁空话、客套话与无意义的铺垫。
4. **外科手术式修改**：只做解决当前问题所必需的修改，不做过度推测性设计，保持既有代码风格。
