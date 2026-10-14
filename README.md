# omp desktop

omp（oh-my-pi）桌面壳。**库内嵌路线**：单个 Bun 宿主进程内嵌 `@oh-my-pi/pi-coding-agent` SDK 持有全部会话（仿 etower-agent 的 session 池形式），不是每会话一个 `omp --mode rpc` 子进程——后者每会话吃一份 ~210MB 底座，9 会话 ≈3GB；本路线实测 2 会话共 385MB（单进程）。

## 架构

```
┌─ Tauri 壳（src-tauri）──────────┐        ┌─ Bun 宿主（host/）────────────────┐
│ 窗口 + WKWebView 加载 ui/dist   │        │ 库内嵌 omp SDK                     │
│ spawn 宿主、转发 WS 动态端口     │ ────▶  │ 进程级底座×1（auth/model/settings）│
│ 退出时 kill 宿主 + 看门狗限频重启 │        │ Map<sessionId, PoolEntry>          │
└─────────────────────────────────┘        │ 会话落盘 ~/.omp/agent/sessions/    │
        ▲ WebSocket（动态端口）             └───────────────────────────────────┘
        └────── ui/dist 静态产物直连 ────────────┘
```

- 会话 = 宿主进程内一个 `createAgentSession()` 实例，工具在宿主内直接执行，无 host-tool 桥；transcript 按 cwd 分桶持久化（JSONL），重启可恢复
- 前端 `ui-src/`（React 19 + TypeScript + Vite + Tailwind v4 + zustand + streamdown + Lexical），构建产物 `ui/dist/`
- `host/limits/`：供应商套餐限额查询（21 家供应商、34 个 omp provider id），凭证优先经 authStorage 解析（OAuth 自动续期）
- 画像（profile）隔离：`OMP_PROFILE` 指定，默认 `default`；测试强制用 `omp-desktop-test`

## 跑

```bash
bun install
bun run ui:build            # 先出前端产物（桌面端无 HMR，tauri dev 加载预构建产物）
OMP_DESKTOP_MODEL=deepseek/deepseek-flash bunx tauri dev   # 默认模型是本地慢模型，建议覆盖
```

宿主可独立验证（不经 Tauri）：

```bash
bun scripts/smoke.ts               # 真模型全链路冒烟（建会话→prompt→落盘→load 恢复）
bun scripts/probe-sdk.ts           # 仅装配探针
bun scripts/probe-asset-sources.ts # 来源开关对资产列表的约束
```

全仓检查：`bun run check`（编码门禁 / host 边界 / 架构棘轮 / 样式 token 门禁 / 版本号一致性 / typecheck）。冒烟脚本清单见 `scripts/`。

## 发版

```bash
bun run version:set 0.2.0        # 版本号单源在 src-tauri/tauri.conf.json，自动镜像 Cargo.toml
git commit -am "release: 0.2.0"
git tag v0.2.0 && git push origin main --tags
```

tag 触发 `.github/workflows/release.yml`：校验 tag 与版本号一致 → 各平台构建 → 发 draft Release（含 updater 产物与 `latest.json`）。**检查 draft 后手动 publish**——草稿状态下的 `releases/latest/download/` 不可用。

前置条件（一次性）：

- GitHub secret `TAURI_SIGNING_PRIVATE_KEY` = `~/.tauri/omp-desktop.key` 的**内容**（不是路径）。**这把私钥丢了，已安装的用户将永久收不到更新。**
- 客户端签名走 ad-hoc（`APPLE_SIGNING_IDENTITY: "-"`）。别人首次安装需右键打开，或 `xattr -dr com.apple.quarantine /Applications/omp\ desktop.app`。要消除这一步需购 Apple Developer ID（$99/年）并公证，见 [ADR-0003](.agents/notes/0003-tauri-updater-auto-update.md)。

本地出包（不走 CI 时）同样要私钥，`createUpdaterArtifacts: true` 下缺私钥会直接报错、不产任何 bundle：

```bash
# Windows（git-bash 里 ~/.tauri 即用户目录下的 .tauri）
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/omp-desktop.key)"
bun x tauri build --config src-tauri/tauri.windows.conf.json

# macOS
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/omp-desktop.key)"
APPLE_SIGNING_IDENTITY="-" bun x tauri build
```

macOS 上生成的那把 key 在 Windows 上同样能用（密钥本身与平台无关，密码为空）；换机时把 `~/.tauri/omp-desktop.key` + `.pub` 拷到新机器的 `~/.tauri/` 即可。

用户侧入口：设置 → 通用 → 应用 →「检查更新」。

## 文档

- 开发约束与全站规范：[AGENTS.md](AGENTS.md)
- 文档写作与生命周期：[docs/documentation.md](docs/documentation.md)
- 外部依赖踩坑（omp SDK / Tauri / macOS）：[docs/PITFALLS.md](docs/PITFALLS.md)
- 本仓 bug 事故账本 / 防回归规则 / ADR：`.agents/`（入口 [.agents/README.md](.agents/README.md)）
