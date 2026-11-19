# 新会话受管 Worktree · 实施 Spec

> **Status**: Draft(2026-11-19) · 未实施
> **审阅结论**: 已复审（2026-11-19）：`--path-format=absolute` 改为既有 `resolve(cwd, commonDir)` 手法（git < 2.31 会把未知 flag 回显成路径）；失败回滚补清理契约（`worktree list` 无残留 + bucket 目录不存在）；`info/exclude` 追加声明不查重；bucket 耗尽归入 `worktree_create_failed`、detach 帧不发送 `branch` 字段。
> **Triage**: `ready-for-agent`
> **决策 SSOT**: 无 ADR；路径布局（仓库内 `<primaryRoot>/.omp/worktrees/<4hex>/<name>`）由用户 2026-11-19 拍板，其余决策为本 Spec 首次定义，验收闭环后收敛进 ADR。
> **实测**: 2026-11-19 在本机 git（macOS）上用临时仓库跑过 11 组断言，结论见「实测结论」；文档中标 `[实测]` 的条目均有命令级证据，标 `[推断]` 的仅由代码阅读得出。
> **参考实现**: ZCode `managedWorktree`（`packages/services/src/git/managed-worktree/`、`packages/ui/src/managed-worktrees/`）。本 Spec 只取其创建语义与目录规则，不做其创建记录 / phase 状态机 / CLI 命令信封。

## Problem Statement

用户在一个 git 仓库里想并行追问、跑一条隔离的实验性任务时，今天的 omp-desktop 只有两条路：

1. 直接在项目 cwd 里开会话——agent 的改动、临时文件、未提交状态与用户自己手上的工作互相污染，两个会话同时跑同一目录还会互相看到对方的中间态。
2. 侧栏「Worktree 会话」入口——必须先想一个名字、弹对话框、选基线、等创建，再回到欢迎页手打第一条消息。对一个「顺手隔离一下」的念头来说，这个成本超过收益。

用户想要的是 ZCode 那种一次点击：新会话输入框右上角一个 `worktree` 开关，勾上，直接说话，这次的会话就长在仓库里的一个隔离副本上，且不需要用户关心副本叫什么、放哪、怎么删。

## Solution

在新会话页输入框上方的胶囊行右端提供一个 `worktree` 开关（默认关闭，仅在当前项目是 git 仓库时出现）。

勾选后发第一条消息时，宿主先在该仓库的 `.omp/worktrees/` 下创建一份受管副本（detach 检出当前 HEAD，不带未提交改动），再以该副本为 cwd 创建会话。副本自动出现在既有 worktree 胶囊的候选列表和侧栏仓库分组里，用既有入口即可移除。

开关是一次性意图：会话建好后它不再显示，下一次新建会话恢复为关闭。

## User Stories

1. 作为在 git 仓库里工作的用户，我希望新会话页有一个 worktree 开关，这样我不用记命令、不用弹窗就能把一个会话隔离到副本里。
2. 作为用户，我希望这个开关只在我当前选中的项目是 git 仓库时出现，这样非 git 目录不会出现一个点了就报错的控件。
3. 作为用户，我希望开关默认关闭，这样日常会话不会莫名多出一份 checkout 和一份磁盘占用。
4. 作为用户，我希望开关状态是「这一次新建会话」的意图，这样我勾过一次之后不会被永久带进下一条会话。
5. 作为用户，我希望切换项目时开关自动回到关闭，这样我不会在上一个项目的意图下为另一个仓库建副本。
6. 作为用户，我希望勾选开关后输入框提示我「这一次会建副本」，这样我能在发出前知道即将发生的副作用。
7. 作为用户，我希望副本从当前 HEAD 检出，这样副本内容与我此刻看到的代码一致。
8. 作为用户，我希望副本不带入我未提交的改动，这样我的实验不会误删或误带上手上的工作。
9. 作为用户，我希望创建副本期间输入框处于明确的等待状态，这样我能区分「在克隆」和「卡住了」。
10. 作为用户，我希望副本建好后会话直接开始、不需要我再点一次发送，这样勾选的成本只有一次点击。
11. 作为用户，我希望副本建在仓库内一个可预期、可清理的位置，这样我能在项目目录里就看到它。
12. 作为用户，我希望副本不会污染我的 git status，这样我不用为每次勾选去写 gitignore 或手工忽略噪声。
13. 作为用户，我希望同一仓库可以同时存在多个副本而不互相覆盖，这样我能并行开两条隔离任务。
14. 作为用户，我希望我的项目是仓库子目录时，副本里仍落在同样的子目录路径上，这样相对路径、脚本和配置都能照旧工作。
15. 作为用户，我希望创建失败时看到说清原因的错误（不是 git 原文一大坨），并且我刚才打的字还在输入框里。
16. 作为用户，我希望创建失败不会在磁盘上留下半成品副本，这样我重试时不会遇到「目录已存在」。
17. 作为用户，我希望副本里发生的提交不会被我随手删副本时无声丢掉，这样我知道 detach 状态下需要自己迁出提交。
18. 作为用户，我希望新副本自动出现在欢迎页的 worktree 胶囊候选里，这样我下次可以直接选它继续。
19. 作为用户，我希望副本里开的会话出现在侧栏该仓库那一行下面，这样我能从侧栏回到它。
20. 作为用户，我希望副本能用既有的 worktree 移除入口删掉（含脏状态确认），这样我不用记新命令。
21. 作为用户，我希望这个开关在 LAN 远程（手机）连接下不出现在新会话页，这样别的设备不能在桌面机上写目录。
22. 作为用户，我希望开关行为不依赖「Worktree 会话」对话框那条命名+分支的流程，这样两条入口各自保持清晰：一个自动、一个可选名字。
23. 作为用户，我希望开关在仓库 HEAD 指向游离 commit 时依然可用（以该 commit 为起点），这样临时检出状态不会挡住我。
24. 作为用户，我希望开关在仓库为空（无 commit）时不可用并给出提示，这样我不会看到一个必然失败的按钮。
25. 作为用户，我希望创建期间重复发送不会建出两份副本，这样手快不会浪费一次完整 checkout。
26. 作为用户，我希望测试与本机多 profile 不会共用同一份副本目录，这样并行跑测试不会撞在一起。

> 26 关于 profile 隔离 [推断]：受管根在仓库内，故**不随 profile 隔离**（ZCode 放数据根目录才有隔离）。替代保障是测试用临时仓库、不碰真实项目；此条与本 Spec 其余部分不冲突，但用户须知道「测试 profile 与默认 profile 看同一份副本」。

## Implementation Decisions

### 命名与协商面

- 新 RPC `worktree_create_session`，与既有 `worktree_create` / `worktree_status` / `worktree_remove` 同属 host 的 worktree 域（`kind: "git"`，`risk: "write"`）。**不复用** `worktree_create`：后者要求用户命名、建 `omp/desktop/<slug>` 分支、冲突时给后缀，参数与错误码组合都不同，合并只会产生参数爆炸。
- 请求字段：`reqId`（回传相关）、`baseCwd`（用户当前项目 cwd，允许是仓库子目录）。**没有名字、没有起点 ref**——名字由目录规则决定，起点固定 HEAD。
- 回复复用既有 `worktree_created` 帧，新增两个可选字段：`cwd`（本次会话应使用的目录）、`head`（起点 commit sha）；`path` 为副本根，`baseCwd` 为解析出的主 checkout。帧字段语义写死：detach 场景**不发送** `branch` 字段（既不空字符串也不省略后由前端兜底，就是缺省）；`cwd` 仅在 `baseCwd` 是仓库子目录时与 `path` 不同，其余情况 `cwd === path`。
- bucket 分配耗尽不新增错误码，归入 `worktree_create_failed`（附「bucket 分配耗尽」摘要）；Further Notes 中的 `bucket-exhausted` 仅是内部断言名，不进帧、不进 i18n。
- 错误码（全部同时进宿主联合类型与前端本地化映射表）：

| code | 含义 |
|---|---|
| `missing_base` | 未提供 `baseCwd` |
| `not_a_repo` | 无法解析出普通仓库（common dir 不是 `<root>/.git`：bare、子模块、非仓库） |
| `start_ref_unresolvable` | HEAD 无法解析成 commit（空仓库） |
| `start_ref_missing_subdir` | 子目录项目在该 commit 中不存在 |
| `worktree_root_tracked` | `.omp/worktrees` 下存在被跟踪文件 |
| `worktree_create_failed` | bucket 分配耗尽，或 `git worktree add` 失败（附 git 摘要） |

### 目录布局（用户拍板）

- 受管根 = `<primaryRoot>/.omp/worktrees`，`primaryRoot` 是**源仓库主 checkout 的 toplevel**，由 `git rev-parse --git-common-dir` 反推（不是用户 cwd，也不是当前副本的 toplevel）。`[实测]` 从副本内执行该命令得到的仍是主 checkout 的 `.git`。
- 目录 = `<受管根>/<bucket>/<name>`：`bucket` 4 位小写十六进制，非递归 `mkdir` 原子占位，`EEXIST` 重试，上限 32 次；`name` = 源仓库 toplevel 的 basename。
- bucket 分层的三个作用：并发唯一分配、与既有的「名字可预测」流程区分、为后续归属判定留路径结构判据。`[实测]` git 自身能用父目录自动创建目标路径，所以 mkdir 的目的**只是**原子占位唯一性，不是创建父目录。
- `[实测]` 两个不同 bucket 下同名副本共存时，git 在 `.git/worktrees/` 里自动命名为 `repo` / `repo1`，父目录名恒为 `worktrees` —— 侧栏 `repoRootOf` 的判定（`.git` 是文件且 gitdir 的父目录名为 `worktrees`）对任意副本数都成立。

### 忽略规则（仓库内布局的必需前置）

- 创建前 `git check-ignore -q <受管根>`：命中则无需动作（用户 `.gitignore` 里已有 `.omp/` 时即此情形，`[实测]` exit 0）。
- 未命中时向 `<gitCommonDir>/info/exclude` 追加 `.omp/worktrees/`（本地排除，不改仓库 `.gitignore`、不产生用户可见的仓库改动）。**追加前不查重、不做并发互斥**：重复行无害（exclude 语义是逐行或），并发追加最坏产生重复行；引入查重/锁只会增加实现面。`[实测]` 未写排除时主仓库 `status` 出现 `?? .omp/`；写入后干净。
- 拒绝条件收窄为「`.omp/worktrees` 下存在被跟踪文件」（`git ls-files -- .omp/worktrees` 非空）→ `worktree_root_tracked`。`[实测]` `.omp/` 下的其它被跟踪文件（如 `.omp/config.yml`）**不会**使 exclude 失效，主仓库 `status` 仍干净，因此不必也不应因此拒绝。
- macOS 上在受管根写入一次 `.metadata_never_index`，避免 Spotlight 索引完整副本。

### 创建流程

1. 解析源仓库：`rev-parse --show-toplevel` 与 `rev-parse --git-common-dir`（common dir 可能回相对路径，用 `resolve(cwd, commonDir)` 归一，与 `host/rpc/worktree.ts` 的 `primaryRootOf` 同一手法）；common dir 的 basename 必须是 `.git`。**禁止**用 `--path-format=absolute`：git < 2.31 不报错，会把未知 flag 原样回显成路径，primaryRoot 静默变成字面量 `"--path-format=absolute"`（既有注释记录的坑）。`[实测]`
2. 起点固定 HEAD：`rev-parse --verify --end-of-options 'HEAD^{commit}'`，取 commit 而非 ref 名，游离 HEAD 同样可用。`[实测]`
3. 用户 cwd 是子目录时：`cat-file -t <commit>:<relative>` 必须为 `tree`；不存在时 git 返回 128。`[实测]` 实现注意：`rev-parse --show-toplevel` 回的是物理路径（macOS 上 `/tmp` → `/private/tmp`），与可能是符号链接的 `baseCwd` 直接 `path.relative` 会得到垃圾相对路径——两侧先 `realpath` 再差分。（实现期实测发现，已按此修正。）
4. 原子分配 bucket 目录，计算绝对路径 `<受管根>/<bucket>/<name>`。
5. `git worktree add --detach <绝对路径> <commit>`，超时放宽到 10 分钟（完整 checkout；默认 60 秒写超时会误判失败）。`[实测]` 目标目录已存在且非空时 git 退出码为 128 并输出 `already exists`，因此创建前的占位目录必须为空。
6. 失败回滚：递归删除 bucket 目录（占位时它为空，add 中途失败时里面的内容也只可能来自本次 add，递归删除安全——`[实测]` git 会先在 bucket 里建出检出内容、再失败于管理目录写入），然后无条件 `git worktree prune`（best-effort）。回滚的验收判据不是「执行了哪些命令」而是清理契约：**失败后 `git worktree list` 不得包含该路径，bucket 目录不得存在**。`[实测]` 直接删除副本目录后 `worktree list` 会留下带 `prunable` 标记的残留登记，`prune` 后干净。
7. `git worktree remove` 只删副本目录、**留下空 bucket 目录** `[实测]`。因此本流程的创建失败回滚与后续移除都要 `rmdir` bucket；既有 `worktree_remove` 目前会留空 bucket，属既有行为，本 Spec 只记录不自作修改。
8. 返回 `cwd` = 子目录项目时 `<path>/<relative>`，否则 `<path>`。`[实测]` 副本内该子目录存在。

### 分支策略

- detach 检出，不创建分支。开关语义是隔离副本，不是分支工作流；删除副本不会留下孤儿 ref。命名+绑定分支的需求由既有「Worktree 会话」对话框承担。
- 代价：副本内产生的提交是游离 commit，会被 `git gc` 回收。此代价在 tooltip 与文档中明示，不提供自动保护。

### 前端编排

- 新会话状态新增一个意图位（`newSessionWorktree`），在切换项目与进入新建会话时重置为关闭。
- 开关控件放在新会话页胶囊行右端，与胶囊同高；文案与 tooltip 走 i18n，中英成对。新增键：`worktree.toggle.label`、`worktree.toggle.tooltip`、`worktree.create.waiting`、`worktree.toggle.unavailable`，错误码文案走既有 `worktree.code.<code>` 命名。
- 可见性 =「当前项目是 git 仓库」，数据来自既有分支信息帧，不新增探测 RPC；远程连接下不渲染（与远程写拒绝清单双保险）。
- 触发点是「第一次发送」而非「勾选瞬间」：勾选只是意图，避免建出没人使用的副本。
- 发送链路：暂存草稿 → 调 `worktree_create_session` → 成功后以返回的 `cwd` 作为新会话 cwd 继续既有建会话流程 → 失败则本地化 toast + 用既有草稿回填通道把文字放回输入框 + 清除发送中状态。
- 等待态复用既有「建会话中」状态位，不新增 UI 状态机；该状态位同时承担「重复发送不建两份副本」的守卫。
- 创建成功后补发 `add_project`，登记**副本根**（不是子目录 cwd），否则该会话不会进入侧栏的仓库分组（分组只合并已注册目录）。`[推断]` 依据：分组成员来自已注册项目列表，未注册 cwd 的会话不进合并行。

### 门禁登记

- 新 RPC 必须同时出现在：能力清单（`kind: git` / `risk: write` / 一行说明）、请求方法联合、远程写拒绝清单。
- 宿主错误码联合、前端错误码文案映射表、宿主帧的可选字段三处同步。

## 实测结论（2026-11-19，临时仓库）

| # | 断言 | 结果 |
|---|---|---|
| 1 | 未 ignore 时建 `.omp/worktrees/` → 主仓库 `status` | `?? .omp/`，必须处理 |
| 2 | `git check-ignore -q .omp/worktrees`：未忽略 / 已 ignore / 已写 info/exclude | 1 / 0 / 0 |
| 3 | 写 `.git/info/exclude` 后主仓库 `status` | 干净 |
| 4 | `worktree add --detach .omp/worktrees/<4hex>/<name> HEAD` 于仓库内未跟踪目录 | 成功（exit 0） |
| 5 | `worktree list --porcelain` | 含副本，`detached`，path 为绝对路径 |
| 6 | 副本内 `status` 与主仓库 `status` | 均干净 |
| 7 | 副本内 common-dir / toplevel | 主 checkout 的 `.git` / 副本自身 |
| 8 | 从副本内以主 checkout 为 cwd 再建副本（嵌套） | 成功，`worktree list` 三条 |
| 9 | `--end-of-options 'HEAD^{commit}'` | 可用 |
| 10 | `.omp/config.yml` 被跟踪后，exclude 是否仍屏蔽 `.omp/worktrees` | 仍屏蔽，`status` 干净 |
| 11 | 目标目录已存在非空 / 外部删除副本后 `worktree remove` | 128 并 `already exists` / 静默 exit 0 |

## Testing Decisions

- 好的测试判据：只断言 RPC 的可观察结果——回发帧的 `ok` / `code` / `path` / `cwd` / `head`，以及**磁盘与 git 的真实状态**（目录存在、`worktree list` 含该路径、两侧 `status --porcelain` 为空、`.omp/worktrees` 被 ignore）。不断言内部函数、路径拼接细节或调用顺序。
- 接缝：`worktreeHandlers.worktree_create_session` + 伪 ws（收帧）+ 临时真实 git 仓库。这是本域最高的既有接缝，且是外部行为接缝；不新增只为本功能存在的导出函数。
- 仓库 fixture：`mkdtempSync` + `git init` + 一次提交；子目录用例用 nested 目录提交后在其下调用。
- 先例：`scripts/git-patch-oracle.test.ts`（真实 git + 临时目录）、`scripts/approval-fanout.test.ts`（伪 socket + 真 handler）。
- 覆盖用例：
  1. 根项目创建成功：帧 ok、目录存在、`cwd` = `path`、`head` 与源仓库 HEAD 一致、副本 `status` 干净、主仓库 `status` 不出现 `.omp/worktrees`。
  2. 子目录项目：`cwd` = `<path>/<relative>`，该目录存在。
  3. 同仓库连续两次创建得到两个不同 bucket 目录，且 `worktree list` 同时含两者。
  4. 非 git 目录：`not_a_repo`，磁盘无残留。
  5. 空仓库（无 commit）：`start_ref_unresolvable`。
  6. 子目录在起点 commit 中不存在：`start_ref_missing_subdir`。
  7. 失败回滚：让 `worktree add` 失败（预先占满目标路径）后，bucket 目录不存在、`worktree list` 无残留。
- 不测 UI 编排（zustand + ws 的发送链路），由 `bun run dev:browser` 真机实测覆盖：出现/隐藏、勾选、等待态、成功落到副本、失败回填草稿。
- 命令走仓库红线：单文件测试必须带 `--pool=forks --poolOptions.forks.singleFork` 且 `OMP_PROFILE=omp-desktop-test`；合并门禁 `bun run check`。

### 验收矩阵

- [ ] 钩选开关 → 发消息 → 会话 cwd = 副本路径，副本 `git status` 干净，主仓库 `status` 无噪声
- [ ] 子目录项目：会话 cwd = `<副本>/<子目录>`
- [ ] 非 git 项目：开关不出现；远程连接：开关不出现
- [ ] 创建失败（人为让 `git worktree add` 失败）：toast 显示本地化原因，输入框文字被回填，磁盘无残留
- [ ] 连点发送两次只产生一个副本
- [ ] 会话建好后侧栏仓库行下能看到该会话；欢迎页 worktree 胶囊能选到该副本
- [ ] 用既有移除入口删除副本成功；脏副本触发确认框
- [ ] 切换项目后开关回到关闭
- [ ] `bun run check` 全绿

## Out of Scope

- 携带未提交改动进入副本（ZCode 的 carry/staged/unstaged patch、未跟踪文件拷贝）。
- `.worktreeinclude` 一类忽略文件拷贝清单。
- 创建记录持久化、创建失败的 retry / dismiss、逐行 git 输出面板、`creating → starting-session → done` 阶段展示。
- 把已有会话 fork 到新副本。
- 起点分支/远端分支选择器（起点固定 HEAD）。
- 会话内展示「当前会话在副本里」的标识。
- 副本的自动清理、闲置回收、合并回主 checkout 的辅助。
- 修复既有 `worktree_remove` 留下的空 bucket 目录（只记录，不在本次改）。

## Further Notes

- **既有入口的可见性缺口**：既有「Worktree 会话」对话框创建后不调 `add_project`，而仓库分组只合并已注册目录，其会话很可能不在侧栏出现。本 Spec 的流程显式补 `add_project`；旧入口是否存在同样问题需真机实测后才能动，未确认前不改。`[推断]`
- **仓库内布局的固有代价**：`.omp/worktrees/` 下是完整 checkout，会被 IDE 索引、被未读 `.gitignore` 的搜索工具扫到、被备份工具复制。ZCode 把副本放在用户数据根目录，没有这个问题；选择仓库内布局换取了「在项目目录里就地可见」。若实测代价过高，回退点是把受管根改为 profile 内的 wt 目录，只影响一处路径计算。
- **`add_project` 的持久化副作用**：每次勾选都会把一个副本路径写进 profile 的项目列表，删掉副本后条目残留（历史合并只跳过不存在的路径，不清理已注册项）。可接受，不在本 Spec 处理。
- **4 位 bucket 的碰撞概率**：同一仓库副本数量级远低于 65536，32 次重试实际上不会耗尽；`bucket-exhausted` 只作为断言存在。
- **开关组件的视觉先例缺口**：仓库里现有的开关基础组件目前没有被任何页面使用，因此「它和新会话页胶囊行放一起是否和谐」没有现成先例可对照。实施前应在 dev 实例里确认它和胶囊同高、同一 hover 语言；若不合，改用胶囊式的勾选框而不是给它加页面私有覆盖。
- 创建耗时与仓库体积成正比（完整 checkout）。等待态文案应说明「正在创建副本」，而不是给人群发式的进度百分比。
