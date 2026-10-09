# ADR-0003: 采用 Tauri updater 插件 + GitHub Releases 静态清单做自动更新

**Status**: Accepted（2026-10-09）
**Decider**: desktop 维护者
**Informed by**: Tauri v2 官方 updater 插件文档、`docs/PITFALLS.md`（bun build --compile / pi-natives 约束）、本仓 `withGlobalTauri` 架构

## Context（背景）

底座 `@oh-my-pi/*` 锁在精确版本（当前 18.8.6），底座升级会改变会话、模型、扩展等用户可感知行为；而用户装的是打包后的 `.app`，改代码不等于用户拿到新代码。此前无任何更新通道（0 个 git tag、0 个 Release、无 CI）。

三条硬约束决定了方案形状：

1. **前端不装 `@tauri-apps/*` npm 包**，走 `withGlobalTauri` 注入的 `window.__TAURI__`（`ui-src/store/ws.ts`）。现成写法是 `invoke("plugin:opener|open_url", …)`（`ui-src/components/chat/parts.tsx`）。
2. **签名分三套，互不相干**：updater 用 minisign（`tauri signer generate`，免费、私钥丢失=永久失去更新能力）；Apple 代码签名与公证决定「别人第一次装会不会被 Gatekeeper 拦」，与 updater 无关。本项目当前只有 ad-hoc 签名（`codesign -dv` → `Signature=adhoc`，无 TeamIdentifier）。
3. **更新包体积大**：`.app` 内含 `omp-host.exe`（bun `--compile` 自包含产物，131 MB），Tauri updater 无增量，每次全量下载。

## Decision（决策）

1. **接官方 `tauri-plugin-updater`，不自造更新协议**。`tauri.conf.json` 开 `bundle.createUpdaterArtifacts`，`plugins.updater.pubkey` 写 minisign 公钥全文（非路径），`endpoints` 指向 `https://github.com/a1398394385/oh-my-pi-desktop/releases/latest/download/latest.json`（tauri-action 生成的静态清单，免自建服务）。
2. **三个自定义命令取代插件 JS 绑定**（`src-tauri/src/update.rs`）：`update_check` / `update_install` / `update_relaunch`。理由：插件的 `download` 命令用 IPC `Channel` 传进度，前端需手工构造；三个普通命令 + 一个进度事件比在 TS 里复刻 Channel 更省。**下载与安装合成一个命令**——插件的 `check()` 返回 `Update` 句柄供 `install()` 消费，拆成两个命令就得把句柄挂在 managed state 上跨越两次往返，而整包字节无论如何都要驻留内存。
3. **进度走事件而非 Channel**：`update-progress` 事件，载荷 `{downloaded, total, finished}`；字节累计在 Rust 侧（插件回调给的是 chunk 增量，TS 逐块重加会漂移）。事件形态与既有 `rail-spectrum`（`src-tauri/src/audio.rs`）一致。
4. **重启用 core Tauri 的 `AppHandle::restart`，不装 `tauri-plugin-process`**：该插件只是包装同一个调用，装它等于为一个函数多开一份 capability。
5. **版本号单源 = `src-tauri/tauri.conf.json#version`**，`scripts/sync-version.ts` 镜像到 `Cargo.toml`，`--check` 模式挂进 `bun run check`。发版 = `bun run version:set x.y.z`。
6. **macOS 只发 arm64**：bun 虽可交叉编译（`--target=bun-darwin-x64`，实测可得 x86_64 Mach-O），但 `scripts/build-host.ts` 按**运行者的 `process.arch`** 解析 pi-natives addon，Intel leg 会把 arm64 `.node` 塞进 x86_64 应用并在启动时崩。要修需把目标架构贯穿 build-host.ts，届时再加 leg，而不是现在发一个坏的。
7. **签名维持 ad-hoc**（`APPLE_SIGNING_IDENTITY: "-"`），不购 Developer ID、不公证。首次安装需用户右键打开或 `xattr -dr com.apple.quarantine`；**更新过程本身不触发 Gatekeeper**（updater 是程序内部替换 `.app`）。
8. **体积治理**：`scripts/build-host.ts` 在编译前清空 `host-dist/`。Tauri 把整个 `host-dist` 映射进 `Contents/Resources`，任何残留文件都会进包——实测两个手工拷入的旧版 `pi_natives.*.node`（各约 160 MB，全仓无引用）把 `.app` 从 148 MB 撑到 465 MB、updater tar.gz 从 79 MB 撑到 153 MB。CI 从干净 clone 构建本就不会带上它们（`host-dist/` 已 gitignore），所以这是本地污染，但发本地包时必踩。

## Consequences

**正面**：

- 底座升级可直达用户；发版只需打 tag。
- 客户端零新 npm 依赖，与既有 `invoke("plugin:…")` 写法同构。
- 更新包 79 MB（Tauri 自动 tar.gz + gzip level 9），比清理前的 153 MB 减半。
- 版本漂移由 `bun run check` 机器化拦截，不靠记性。

**负面**：

- 每次更新全量下载 79 MB，无增量（插件限制）。
- 私钥 `~/.tauri/omp-desktop.key` 丢失 = 已装用户永久收不到更新，且无法降级补救。**已备份一份 `~/.tauri/omp-desktop.key.bak-20261009`；CI 侧需配 `TAURI_SIGNING_PRIVATE_KEY` secret**。
- 应用装在系统级目录（如 `/Applications` 由安装器写入）时，普通用户 updater 替换可能 `Permission denied (os error 13)`（上游 issue #8104）。用户手动拖入的 app 通常有权限。
- 首次安装仍需右键打开，直到升级到 Developer ID + 公证。

**风险/不确定性**：

- Windows leg 未在本机验证（需 Windows runner）：NSIS 安装器 + `installMode: passive` 默认值未实测；且 Windows 上安装器无法替换运行中的 exe，插件会在 install 期间退出进程，此时 `update-installed` 事件到不了前端（`progress.finished` 是最后一个可见事件，UI 已按此设计）。
- tauri-action 多平台并发写 `latest.json` 的合并行为未实跑验证（需真实 push tag）。

## Alternatives Considered（备选方案）

1. **装 `@tauri-apps/plugin-updater` npm 包走标准 JS API**：写法最直白，但与本仓「不装 npm 包、统一走 `withGlobalTauri`」的既有约定冲突，且 Channel 抽象仍需理解才能画进度条。未选。
2. **自建更新服务（动态 endpoint + 自定义协议）**：可做灰度、按渠道分流、强制回滚。代价是运维一个长在线服务 + 鉴权 + 监控。当前单人项目、无 release，不值。未选；若将来需要 beta 通道，插件支持运行时改 endpoints，届时再加。
3. **只做「检查更新 + 跳转下载页」，不做自动安装**：最省事，绕开签名与体积的全部问题，也不需要 CI。但底座升级是本仓最高频的变更来源，用户手动下载 DMG 的体验差距明显。未选。
4. **买 Developer ID + 公证（$99/年）**：消除首次安装的 Gatekeeper 拦截。链路代码与 ad-hoc 完全一致，只差 `signingIdentity` 一行 + CI 三个 secret。当前无外部用户，等真要公开发布再花这笔钱。
5. **用 `tauri-plugin-process` 做重启**：更「标准」。但 core `AppHandle::restart` 就是它内部调用的东西，多一个插件只为包装一个函数，还要多一条 capability。未选。
6. **让 `Cargo.toml` 当版本单源**：Cargo 是构建的真正入口。但 Tauri bundler 读的是 `tauri.conf.json#version`，updater 比对的也是它——让 SSOT 落在被读取的一侧，改一处少一处漂移源。未选。

## Spec 收敛（2026-10-09）

- 客户端契约：`update_check` → `{version, currentVersion, body, date, available}`；`update_install` → 下载并安装，途中发 `update-progress`（`{downloaded, total, finished}`），成功后发 `update-installed`；`update_relaunch` → 不返回。
- 权限：`capabilities/default.json` 仅需 `updater:default`。
- UI 契约：设置页「应用」分组的 `.srow.set-row`，状态机 idle → checking → available/uptodate → downloading → installed；样式见 `ui/css/settings/update.css`。
- 验收：`scripts/sync-version.ts --check` 归入 `bun run check`；产物结构与签名链见 PITFALLS 的验证法。

## Related

- `docs/PITFALLS.md`：Tauri updater / minisign / macOS 签名章节
- `scripts/sync-version.ts`、`src-tauri/src/update.rs`、`.github/workflows/release.yml`