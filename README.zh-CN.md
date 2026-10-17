# omp desktop

[English](README.md) | [简体中文](README.zh-CN.md)

omp desktop 是 AI coding agent——omp（oh-my-pi）的跨平台桌面客户端。它把 agent 装进一个原生窗口：与模型对话、看着它改文件跑命令，随时查看上下文、diff 与子代理。agent 运行时内置于应用，无需单独安装 omp CLI。

## 为什么是单进程

给 CLI agent 套桌面壳的常见做法是每个会话起一个子进程，而 omp 运行时每份底座开销约 210MB，开九个会话就逼近 3GB。

omp desktop 换了一条路：把 omp SDK 作为库内嵌进单个 Bun 宿主进程，用会话池持有全部会话，auth／模型／设置底座全进程共享一份。实测单进程跑 2 个会话总共 385MB。

会话按工作目录以 JSONL 落盘，重启后可恢复。

## 功能

- 多会话并行管理与侧栏，每个会话自带条目树
- 流式 markdown 渲染：代码高亮、中文换行优化、mermaid 图表
- 多供应商模型接入：OAuth 登录（凭证自动续期）或配置 API key 与 base URL；应用内套餐限额查询覆盖 21 家供应商
- 模型角色（按角色分配不同模型）与思考档位（Minimal 到 Max，含 auto）
- 消息队列——agent 工作时可以继续排队追问，中途随时 steer
- Git 集成：分支切换与 diff 查看
- 详情面板：上下文明细、文件查看、子代理检查器、终端、浏览器镜像
- 截图直接粘贴、文件拖入输入框
- macOS 通知、系统托盘（关窗隐藏到托盘）、单实例锁
- 应用内自动更新（设置 → 通用 → 应用 → 检查更新）
- 六套主题（dark、light、midnight、warm-paper、deep-think、coral），支持跟随系统
- 界面支持英文与简体中文
- 长任务场景：ACP 上下文自动压缩与会话保活
- 设置页内管理 MCP 服务器、技能、记忆、插件与 hooks

## 安装

从 [Releases](https://github.com/a1398394385/oh-my-pi-desktop/releases/latest) 下载安装包。

**macOS（Apple Silicon）**——打开 `.dmg` 把应用拖进「应用程序」。安装包是 ad-hoc 签名，首次打开需要任选其一：

- 右键应用 →「打开」→「打开」，或
- 执行 `xattr -dr com.apple.quarantine /Applications/omp\ desktop.app`

**Windows（x64）**——运行 `-setup.exe`（NSIS 安装器）或 `.msi`。

更新走应用内推送；也可以在 设置 → 通用 → 应用 →「检查更新」手动触发。

## 快速上手

1. 启动应用，打开 设置 → 模型 添加供应商——向导会带你走 OAuth 登录或「API key + base URL」配置。
2. 新建会话，选择项目目录和模型，开始对话。
3. agent 会读写文件、执行命令，并在对话里汇报结果；它做了什么，用详情面板查看。

## 文档

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)——架构、源码运行、发版流程
- [AGENTS.md](AGENTS.md)——贡献者与 agent 的仓库约定
- [docs/PITFALLS.md](docs/PITFALLS.md)——外部依赖踩坑（omp SDK / Tauri / macOS）

## 许可证

All rights reserved.
