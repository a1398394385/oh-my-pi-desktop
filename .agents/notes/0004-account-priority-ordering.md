# ADR-0004: 账号优先级排序——desktop 侧凭据行 id 置换，不改底座

**Status**: Proposed(2026-10-11)
**Decider**: 用户(要求"在 desktop 中实现，不改底座")
**Informed by**: 本次会话对底座 `CredentialPool` / `SqliteAuthCredentialStore` 的源码查证

## Context(背景)

- MiniMax 等供应商可配置多个账号(多个 api_key / OAuth 行)，用户要求可调整"账号使用优先级"。
- 底座事实(源码实测)：
  - `CredentialPool.get(provider)` 返回 `credentials(provider)[0]`(`packages/ai/src/auth/pool.ts:562`)，无轮询、无权重。
  - active 行查询恒为 `ORDER BY id ASC`(`sqlite-credential-store.ts:436`)，即**最早写入的账号恒为生效账号**。
  - 无 priority 列、无 reorder API、`replaceAuthCredentials`/`upsertAuthCredential` 均按 identity_key 匹配保留原行 id，无法靠重放凭据改序。
  - host 已直接只读打开 agent.db(`provider_enable_account` 墓碑恢复)，写侧无既有路径。
- 用户明确要求：**不动底座 repo**，在 omp-desktop 内实现。

## Decision(决策)

1. 排序 = 对 provider 的 active 凭据行做 **id 物理置换**：目标序第 i 位的行取当前第 i 小的 id。新 id 多重集合 ≡ 旧集合 → 永不与其他 provider 行冲突；底座 reload 后 `list()`/`get()`/限额账号枚举天然等于用户顺序。
2. 实现为纯函数 `host/account-order.ts: reorderProviderAccounts(dbPath, provider, orderedIds)`：
   - 事务内两步(先全部 id 取负避开中间态主键冲突，再逐行归位)；
   - 附属表 `auth_credential_blocks` / `auth_credential_refresh_leases` / `auth_credential_block_mirror_guard` 按 credential_id 同步置换；
   - `auth_credentials` 的 UPDATE 触发器自动 bump `auth_change_revision`，其他进程 poll 时 reload，多进程无需额外同步代码；
   - orderedIds 必须是 active id 集合的排列，否则返回 false(RPC 层抛可见错误)。
3. 新 RPC `provider_reorder_account { provider, ids }`(host/rpc/login.ts)：校验覆盖全部 active id → 调置换函数 → `credentials.reload()` → 重推 `provider_accounts` 帧。已登记 host/capabilities.json。
4. UI(ui-src/components/settings/pages/ModelPage.tsx)：多账号时每张配额卡头部渲染序号徽标(`#1 · 生效中` / `#N`)与上移/下移钮(.icon-btn 语言)，上移即与上位 swap 后发帧；随后重查 `get_provider_limits` 刷新卡片顺序。

## Consequences(后果)

**正面**:

- 零底座改动、零 patch 负担(与既有 pi-coding-agent patch 无关)；升级底座不受影响。
- 持久化：顺序落在 agent.db 行序上，重启/新进程 `discoverAuthStorage` 后一致。
- 用户可感知目标完整覆盖：首位=生效账号；停用的账号恢复后排到队尾(既有 upsert 语义，天然=最低优先级)。

**负面**:

- 行 id 变化 → usage-limit block / refresh lease 的归属随行迁移(数据不丢，但同 id 旧 block 需重新探测)。
- 每次排序触发全 provider 行重写 + 一次 limits 重查(60s 缓存按 id 命中失败，多一次 vendors 请求)。
- 单账号或仅剩一个 active 账号时不显示排序控件(无意义)，不是缺陷。

**风险/不确定性**:

- 底座若未来改 active 行排序 SQL(如引入 ORDER BY priority)，本方案自动失效(`reorderProviderAccounts` 的读序断言仍成立但顺序不再由 id 决定)。届时删除本文件、改调底座新 API。
- 直接写库绕过 store 写入路径：若底座未来新增 credential_id 外键约束或级联删除，需评估(当前 DDL 无 FK 声明)。

## Alternatives Considered(备选方案 — 必填,详细)

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 给底座加 priority 列 + ORDER BY + reorder API(bun patch pi-ai) | 语义最干净，id 不变 | 需改 /Users/xys/Github/oh-my-pi 源码 + patch 双轨维护，升级底座必冲突 | 用户明确要求不改底座 |
| host 层用 `credentials.set(provider, 重放数组)` 改序 | 只用公开 API | 实测：`replaceAuthCredentials` 按 identity_key 匹配**保留原行 id**，内存序=数组序但磁盘序仍 id 序 → **重启即回退**，不可交付 | 冒烟验证内存/磁盘分叉，不选 |
| disable 非目标账号(单选) | 实现最简，现有 RPC 即可 | 语义退化为单选，无法表达完整优先序；且 api_key tombstone 在同型 active 替补存在时会被 `#purgeSupersededDisabledRows` 硬删，凭据恢复链有既有缺陷 | 用户要"排序"，不是二选一 |
| 改 node_modules 运行时副本(patch 落 desktop) | 持久生效 | 仍是底座行为变更，patch 冲突成本转移到升级时；用户已拒绝底座方向 | 不改底座 |

## Related(关联)

- host/account-order.ts(置换函数)、host/rpc/login.ts(RPC)、scripts/smoke-provider-order.ts(后端冒烟)、scripts/smoke-model-page-order.tsx(UI 冒烟)
- 冒烟入口：`bun run smoke:provider-order` / `bun run smoke:provider-order-ui`
