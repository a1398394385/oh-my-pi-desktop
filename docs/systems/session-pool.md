# 会话驻留内存池子系统手册

> 活文档：跨文件链路地图 + 排障 runbook，随代码同步更新（登记见 [documentation.md](../documentation.md) §2「子系统手册」）。

## 1. 一句话机制

宿主为每个被打开的会话保留一个内存条目（`PoolEntry`：AgentSession + 事件订阅 + MCP 挂载 + keepalive/goal 等状态）。`host/state.ts` 的 `sessions: Map<poolKey, PoolEntry>` 即"内存池"；`pushPoolSnapshot` 每次遍历它生成侧栏「活跃任务」列表的 `pool_sessions` 帧。关闭 UI、切换标签页都不会释放条目 —— 只有 §3 的几条路径会把它移出池。

## 2. 身份：pool key ≠ 磁盘会话 id

- 池的 key 是 `createSessionCore` 里现造的 `crypto.randomUUID()`（前端拿到的 `sessionId`），与磁盘 `SessionInfo.id` 永不相等；SDK 还会随文件改名重铸磁盘 id。
- **任何"池 ↔ 磁盘"的匹配一律按 `path`**：`sessionEntryMatchesPath(entry, p)`（`host/rpc/session.ts`）兼容 SDK 移动文件产生的 `previousPaths`。用 id 匹配会在改名/落盘后指向错误的条目。
- 远程控制端（`host/remote.ts`）是只读席：`REMOTE_WRITE_DENYLIST` 覆盖归档、移出池、删除等写操作，直接回 `{type:"error", message:"remote read-only"}`。

## 3. 出池路径

| 路径 | 触发 | 前置条件 |
|---|---|---|
| `session_unload` RPC | 侧栏行的 eject 钮 | 会话空闲，否则报 `unloadBusy` |
| `archive_session(archived:true)` | 归档（侧栏 / 右键菜单） | 会话空闲；归档后立刻出池（§4） |
| 空闲 LRU sweep | `host/rpc/session.ts` 模块加载即启动的 60s 定时器 | 无 UI 观察者 + 30min 无活动 + 空闲 |
| `delete_session` / `reload_session` | 删除 / 重新加载 | 会话空闲 |

出池序列统一走 `evictPoolEntry(key, e)`：`releaseMcpForSession` → `unsubscribe` → `sessions.delete` → `session.dispose()`（SDK 幂等，追加一条 `session_exit` 行），随后按 `[e.path, ...e.previousPaths]` 广播 `session_unloaded`，让**两个通道**（本机 + 远程）各自的 `openSessions` 槽位落地清除；磁盘文件不动，点击会话重新 `load_session` 即重新入池。

## 4. 归档即退役

归档语义已扩展为"退役该会话"：池内会话在归档的同一请求内被逐出（`archive_session` → `evictPoolEntry` → `eachUiWs(pushPoolSnapshot)`）。两条边界：

- **未落盘的懒创建会话先 `ensureOnDisk()` 再驱逐**：它唯一的内容副本在内存里，直接驱逐会让会话从列表彻底消失（底座只在首条 assistant 消息时才写文件）。落盘失败则保留在池内并写 stderr，归档记录本身已生效。
- **池 key 随之失效**：驱逐后取消归档必须用刷新后列表里的**磁盘 id**（真实客户端在 `session_archived` 后会重拉 `session_list`，与该路径一致）。

## 5. 运行中的会话不可归档、不可移出

`sessionBusy(entry)`（generating / 排队消息 / 后台 job）非空时：

- host：`archive_session` 直接抛 `errors.session.archiveBusy`，**不落任何持久状态**；`session_unload` 抛 `unloadBusy`。
- 前端：`SessionRow` 的归档 / eject 钮与右键菜单归档项一律 `disabled`（`poolLocked = streaming || poolBusy`），确认态按钮同步禁用；样式见 `ui/css/main/sidebar.css` 的 `.tarchive:disabled` / `.tarchive-confirm:disabled`。前端门只是预判，host 仍是权威。

## 6. 前端联动

| 帧 | 作用 |
|---|---|
| `pool_sessions` | 重算侧栏「活跃任务」与 `busyPaths`（`landPoolSessions`） |
| `session_unloaded` | 按 path 删 `openSessions` 槽；若正是当前视图则回欢迎页；toast `sidebar.unloadedToast` |
| `session_archived` | toast 后重拉 `session_list`；`session_list` 把 `archived` 行从 `diskProjects` 拆到归档视图 |

前端 `openSessions` 的 LRU（上限 8）只摘前端槽位、发 `mcp_detach`，**不会**释放宿主池条目。

## 7. 排障

- **会话还挂在「活跃任务」里但已归档**：`archivedSessions` 按 path 记账（`omp-desktop.json`）。确认 `pushPoolSnapshot` 帧已推送；归档后仍出现说明驱逐被跳过（未落盘且 `ensureOnDisk` 失败）——查宿主日志里 `errors.session.archiveEvictSkipped`。
- **点归档没有反应**：会话在运行，按钮应为置灰态；RPC 直连时错误帧落在该会话的消息流里（与 `unloadBusy` 同一路径）。
- **会话 id 查不到**：先按 path 查（§2）。
- 冒烟：`bun run smoke:features`（断言 6/6b/6c：归档落盘记录、池外会话归档、归档即出池）、`bun run smoke:react`（按钮置灰）。
