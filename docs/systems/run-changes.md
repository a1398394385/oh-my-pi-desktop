# Run 文件变更卡片子系统手册（run-changes）

> 活文档：run 结尾「N 个文件已更改」卡片的跨区链路地图 + 排障。登记见 [documentation.md](../documentation.md) §2。
> 事实以代码为 SSOT；前端通用约定见 [frontend.md](frontend.md)。

## 1. 行为契约

- 每个 agent run 结束（terminal `agent_end`）时，对本 run 内 `edit`/`write`/`apply_patch` 工具触碰的文件算**净 diff**；无净变化的文件不进卡片。
- 卡片锚定在该 run 最后一条 assistant 消息之后、TurnActs 之前；折叠头显示文件数与 `+a −r`，每文件行提供 审查 / 打开 / 撤销。
- **无整批撤销**。单文件撤销只允许「最后一次修改本文件且尚未被撤销的 run」；该文件之后有新 run 修改、已撤销、或快照不可用（>2MB / 含 `\0`）时按钮禁用。
- 撤销前校验当前磁盘内容 == 该 run 的 after 快照（用户或外部进程又改过则拒绝，报 `errors.runChanges.*`）；新建文件撤销 = 删除，其余写回 before。支持按 run 倒序链式撤销。
- 审查打开右栏 `rundiff` tab（快照 diff，撤销后仍可审查）；打开走既有 file tab + `read_file`。`rundiff` 是上下文 tab，不进加号菜单，diff 视图状态不持久化。

## 2. 链路地图

```
工具执行                host/run-changes.ts（追踪 before/after，edit 以 details.oldText/newText 为权威）
  ↓ agent_end
finalizeRunChanges     净 diff → 快照写 <session artifacts>/run-changes/<changeId>/<idx>.before|.after
                       → appendCustomEntry("desktopRunChanges", {changeId, anchor, files})
  ↓
settleRunChanges       session-entry-core.ts 调用：transcript findLast assistant entryId 取锚点
                       → entryBus 发 run_changes 帧
  ↓
UI store/session.ts    run_changes 分支：findLast 顶层 assistant → 原地赋 changes + refreshGitDiff
  ↓
items.tsx TurnGroup    currentTurn.flowNodes 插入 <RunChanges>（TurnActs 前）
```

- **历史回放**：`translate-history.ts` 末尾 `readRunChanges`（journal 重放，`desktopRunRevert` 条目标记 reverted）把记录挂到锚点 assistant 的 `item.changes`。
- **RPC**：`host/rpc/run-changes.ts` 提供 `get_run_file_diff`（快照 → sign|line 格式）与 `revert_run_file`；capabilities.json 各一条（kind file，read/write），`revert_run_file` 在 remote.ts denylist（远程只读）。
- **runtime sessionId ≠ jsonl id**：RPC 用的 sessionId 由 host 重生成，从 `session_created` 帧取，不能用文件名。
- **UI 组件**：`RunChanges.tsx`（卡片 + `lastLiveOwner` 撤销资格判定）、`RunDiffPage.tsx`（LightweightDiff）、`store/right.ts` runDiffView（per-session 内存）；样式 `ui/css/main/chat/run-changes.css`；`MessagePage` INLINE_CARD_SELECTOR 与 messages.css 镜像列表含 `.rchg`。

## 3. 排障

| 症状 | 检查点 |
|---|---|
| run 结束无卡片 | 该 run 是否只有无净变化的写入；`readRunChanges` 是否读到 desktopRunChanges 条目；锚点 assistant 是否为顶层（嵌套 pfx 不挂） |
| 撤销按钮禁用 | `lastLiveOwner`：同 path 之后是否有未撤销 run；`noSnapshot`（>2MB/二进制）；`reverted` |
| 撤销报「文件已被外部修改」 | 当前磁盘 != after 快照；属预期守卫，让用户先审查 diff |
| 历史会话无卡片 | 旧会话无 desktopRunChanges journal 条目，功能只对新 run 生效 |

## 4. 验证入口

```bash
OMP_PROFILE=omp-desktop-test bun test scripts/run-changes.test.ts --pool=forks --poolOptions.forks.singleFork
```

覆盖 created/edit/链式撤销/after 守卫/无净变化/多次 write 净统计/历史挂接/live translateEvent+settleRunChanges 集成。
