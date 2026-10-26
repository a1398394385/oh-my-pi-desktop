# IDEA 内置 Git 实现逆向分析 → oh-my-pi-desktop 借鉴清单

**调研日期**:2026-10-18
**类型**:外部调研(时点快照)。目标版本 IntelliJ IDEA 2025.3.3 / git4idea。结论不承诺随代码更新。
**方法**:JVM 字节码静态分析(常量池 + 字段/方法表),辅以 git 行为实测。

---

## 0. 证据方法与边界

| 项 | 说明 |
|---|---|
| 目标文件 | `bin/idea64.exe` = 1.4 MB 原生启动器 stub,**不含任何 git 逻辑** |
| 真正实现 | `plugins/vcs-git/lib/`:`vcs-git.jar`(2696 类)、`vcs-git-frontend.jar`(291)、`git4idea-rt.jar`(6) |
| 解析规模 | 自研 `.class` 解析器(`.local/idea-git-analysis/jclass.py`),2961 个类全部解析成功、0 错误 |
| 解析深度 | **仅常量池 + 字段/方法签名**。未反编译方法体 → 看不到控制流与分支条件 |
| REA MCP | `npx rea-agents@6.4.0 mcp doctor` 报 healthy(v6.4.0 / 170 tools),但工具未挂载进本会话 → 改用字节码解析。对 JVM 字节码而言这本是更合适的工具 |
| 置信度标记 | `[观察]`=常量/签名直接可见;`[推断]`=由命名与调用关系推断;`[实测]`=本次真机跑过 |

**边界**:未运行 IDEA,未反编译方法体,不保证控制流正确性。凡是只有常量证据的结论一律标 `[推断]`。

---

## 1. 结论速览

`git-graph.ts`(提交图那侧)**已经做得比想象中好**——`-z`、`--no-color`、`-M`、`%x00` 分隔、for-each-ref 都在用,与 IDEA 高度一致。**差距集中在 `host/rpc/files.ts`**(status / branch / 写操作那一侧)。

| # | 差距 | 风险 | IDEA 做法 | 置信度 |
|---|---|---|---|---|
| 1 | `git status --short` 未用 `-z` | **中文文件名显示成八进制转义,stage/unstage 必失败** | `--porcelain -z --no-renames` | `[实测]` |
| 2 | `switch_git_branch` 用 `includes("/")` 判远程 | **本地含 `/` 分支被静默切成另一个新分支** | `for-each-ref` 按 `refs/heads/` 前缀判定 | `[实测]` |
| 3 | 所有 git 调用**无超时** | 卡死 → 整个 Bun 宿主事件循环冻结 | 独立线程 + 可取消 + `TERMINATION_TIMEOUT_MS` | `[观察]` |
| 4 | 只读命令不设 `GIT_OPTIONAL_LOCKS=0` | 与 agent 自身 git 争 `.git/index.lock` 而失败 | `LockingPolicy{READ, READ_OPTIONAL_LOCKING, WRITE}` 三态 | `[观察]` |
| 5 | 无仓库状态机 | rebase/merge 进行中照常 commit/checkout | `GitOperationState{NORMAL,REBASE,MERGE,CHERRY_PICK,REVERT,DETACHED_HEAD}` | `[观察]` |
| 6 | `git push` 无 upstream 处理 | 新分支必失败且报错不可读 | `--set-upstream-to` / `--unset-upstream` / `@{u}` | `[观察]` |
| 7 | 无 git 可执行文件探测 | 无 git / 版本过旧只能在操作时才炸 | `GitExecutableDetector` + 超时 + 版本比较 | `[观察]` |
| 8 | detached HEAD 与 unborn HEAD 不可分 | 两者都退化成显示短 sha | `HEAD^{commit}` 校验 + `%(HEAD)` 标记 | `[观察]` |

---

## 2. 进程调用层

`git4idea/commands/GitImplBase` `[观察]`

- **env**:显式 `UTF_8` 字符集;`GIT_OPTIONAL_LOCKS`;调试通道 `GIT_TRACE` / `GIT_TRACE_PACKET` / `GIT_TRACE_PACKET_ACCESS` / `GIT_TRACE_PERFORMANCE` / `GIT_TRACE_SETUP`(对应设置 `git.execution.trace`)
- **认证环境**(`GitCommand` 常量):`GIT_ASKPASS`、`GIT_SSH`、`GIT_SSH_COMMAND`、`SSH_ASKPASS_REQUIRE`、`SSH_ASKPASS`、`GIT_EDITOR`、`GIT_REFLOG_ACTION`、`DISPLAY` —— IDEA 把交互认证做成进程内 handler(`IJ_ASK_PASS_HANDLER_ENV` / `IJ_ASK_PASS_PORT_ENV` / `IJ_EDITOR_HANDLER_ENV`),**从不依赖终端 TTY**
- **进度行前缀**:`Enumerating objects: ` / `Writing objects: ` / `Receiving objects: ` / `Resolving deltas: ` / `Updating files: ` / `Expanding reachable commits in commit graph: `,另有 `remote: ` 前缀归类
- **错误归类**:`warning:` / `error:` / `fatal:` / `remote: error`,外加两个特例检测 `refusing to pull` / `cannot rebase:`
- **Windows**:剥离 MSYS 的 `runnerw:` 行前缀 `[观察]`
- **锁策略**:`GitCommand$LockingPolicy = {READ, READ_OPTIONAL_LOCKING, WRITE}`,`GitCommand.readLockingCommand()` / `writeLockingCommand()` 按枚举常量逐条声明 `GitImplBase` 字符串常量 `READ_OPTIONAL_LOCKING`

> **对我们的意义**:只读命令(status/log/diff/branch)默认会尝试拿 index 锁。我们 UI 频繁轮询 `get_git_diff`,而 agent 自己也可能在同一仓库跑 git —— 这正是 `GIT_OPTIONAL_LOCKS=0` 要解决的问题。

## 3. 仓库状态读取层(最高价值)

`git4idea/repo/GitRepositoryReader` `[观察]`

```
--format=%(refname)\t%(objectname)\t%(HEAD)     ← for-each-ref,一次拿全
--no-color
--show-current
rev-parse --verify HEAD^{commit}                ← HEAD 是否合法
```

一条 `for-each-ref` 同时解决三件事:`refs/heads/` vs `refs/remotes/` 前缀区分本地/远程、第三字段 `*` 标记当前分支、**没有 `*` 即 detached HEAD**。

`GitTagHolder` 用 `--format=%(refname)\t%(objectname)` 同款格式。

**直接读磁盘状态文件**(不等 git 进程,微秒级):`getRebaseMergeDir()` / `getRebaseApplyDir()` / `getShallowFile()` / `getPreCommitHookFile()` / `getCommitMsgHookFile()` / `getPrePushHookFile()` / `getPackedRefsPath()`,并有 `readFromRefsFiles()` / `resolveRefs()` 处理符号引用。设置键 `git.read.branches.from.disk` 可切到纯磁盘读。

两个细节值得抄:
- **`fixCurrentBranchCase`**:对当前分支名做大小写归一 —— Windows/macOS 大小写不敏感文件系统上必需 `[观察]`
- `Unknown repository state in \x01` —— 状态未知时显式报错,不静默降级 `[观察]`

`git4idea/GitUtil` `[观察]`:状态文件名常量 `HEAD_FILE` / `MERGE_HEAD` / `REBASE_HEAD` / `ORIGIN_HEAD` / `REPO_PATH_LINK_PREFIX`(`gitdir:`);提交详情格式串用控制字符分层

```
--pretty=format:%x04%x01%ct%n%H%n%P%n%an%x20%x3C%ae%x3E%n%cn%x20%x3C%ce%x3E%n%s%n%x03%n%b%n%x03
```

`%x01` 分字段、`%x03` 分段、正文 `%b` 放最后 —— 与我们 `DETAIL_FORMAT` 的 `%x00` + `%x1e` 同思路,我们这块做得对。

## 4. 命令面

`git4idea/commands/GitCommand` 枚举常量,45 个子命令 `[观察]`:

```
ADD BLAME BRANCH FOR_EACH_REF CAT_FILE CHECKOUT SPARSE_CHECKOUT CHECK_ATTR CHECK_IGNORE
COMMIT COMMIT_TREE CONFIG CHERRY CHERRY_PICK CLONE DIFF FETCH INIT LOG SHORTLOG
LS_FILES LS_TREE LS_REMOTE MERGE MERGE_BASE MERGE_TREE MV PULL PUSH REBASE REMOTE
RESET RESTORE REVERT REV_LIST REV_PARSE REF_LOG RM SHOW STASH STATUS SUBMODULE TAG
UPDATE_INDEX UPDATE_REF HASH_OBJECT VERSION WORKTREE
```

属性 / 端点类:`GitRepositoryReader$HeadInfo{DetachedHead}`、`GitOperationState`、`GitRebaseProcess$GitRebaseProgressListener`(进度用正则 `^Rebasing \((\d+)/(\d+)\)$` 提取)、`GitStandardProgressAnalyzer$Operation`、`GitUntrackedFilesOverwrittenByOperationDetector`、`GitLocalChangesWouldBeOverwrittenDetector`。

## 5. 实测验证(本机 git,非推断)

### P0-1 `git status --short` 破坏中文文件名

```
$ git status --short
R  plain.txt -> renamed.txt
 M "\344\270\255\346\226\207\346\226\207\344\273\266\345\220\215.txt"
?? "untracked \346\226\260\346\226\207\344\273\266.txt"

$ git status --porcelain -z --no-renames        ← IDEA 的写法
D  plain.txt<NUL>A  renamed.txt<NUL> M 中文文件名.txt<NUL>?? untracked 新文件.txt<NUL>
```

`host/rpc/files.ts:289` 做 `line.slice(3)`,拿到的是**带引号的八进制串**。后果:Git 页显示乱码路径;对该路径 `git add -- <octal>` 必然失败。**与 RULE-009(编码红线)直接相关**,现有冒烟用例未覆盖非 ASCII 文件名。

### P0-2 本地含 `/` 的分支被静默切错

```
$ git checkout -b feat/login-flow        # 本地分支
$ git checkout --track feat/login-flow    # 我们 switch_git_branch 会执行的
Switched to a new branch 'login-flow'
Branch 'login-flow' set up to track local branch 'feat/login-flow'.
exit=0
```

**exit=0,不报错**,但用户被放到了一个新建的 `login-flow` 上,原分支未切换。触发条件:`feat/*`、`feature/*`、`fix/*` —— 几乎所有团队分支命名规范。

### P1 `for-each-ref` 一次拿全(实测 D 组)

```
$ git for-each-ref --format='%(refname)%09%(objectname)%09%(HEAD)' refs/heads refs/remotes
refs/heads/feat/login-flow  22e5dbe…  
refs/heads/login-flow      22e5dbe…  *
refs/heads/main            22e5dbe…  
```

## 6. 落地状态（2026-10-18 已实施）

**第一批 — 纯修复**
1. ✅ `get_git_diff` 改 `status --porcelain -z --no-renames`,按 `\0` 切记录,记录过短按硬错误处理;冲突态(`UU`/`AA`/`DD`/`AU`/`UD`/`UA`/`DU`)带 `conflict` 标记 → **BUG-085**
2. ✅ `switch_git_branch` 改用 `forEachRef` 的 `refs/heads/` 前缀判定,远程走 DWIM(本地同名已存在就直接切,不重建) → **BUG-086**
3. ✅ `get_git_branches` 合并成一次 `for-each-ref`,顺带拿到 detached 标记;无 `%(HEAD)` 时用 `symbolic-ref -q` 区分 **detached** 与 **unborn**(前者报短 oid,后者仍报分支名)
4. ✅ `git push` 前查 upstream,无 upstream / 无提交时给可执行提示

**第二批 — 进程层加固**(收敛到新模块 `host/git.ts`,即 IDEA `GitImplBase` 的对应物)
5. ✅ 全部只读命令注入 `GIT_OPTIONAL_LOCKS=0`
6. ✅ 每次调用都有硬超时(读 20s / 写 60s / 网络 180s),且全部改异步 —— 原先的 `Bun.spawnSync` 会阻塞宿主整个事件循环
7. ✅ 写操作注入 `GIT_TERMINAL_PROMPT=0`;全局 `-c core.quotepath=false -c color.ui=false`;`GIT_PAGER=cat`
8. ✅ `rpc/files.ts` / `rpc/git-graph.ts` / `rpc/worktree.ts` / `session-lifecycle.ts` 四个调用点全部迁到共享层,并登记进 `scripts/check-host-boundaries.mjs` 的 ALLOWED_EDGES(新增模块必须过边界门禁)

**第三批 — 状态机**
9. ✅ `operationState()` 按 `MERGE_HEAD` / `REBASE_HEAD` / `rebase-merge` / `rebase-apply` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` 判定,并用 `rev-parse --absolute-git-dir` 跟随 worktree 的 `gitdir:` 指针。守卫语义:`stage` 与 `commit` **不拦**(标记冲突已解决、完成 rebase/merge 正需要它们),`unstage` / `discard` / `checkout` 拦并给出本地化原因;UI 侧同步隐藏按钮 + 顶部横幅

**顺带修掉的一个存量缺陷**:`rpc/worktree.ts` 的 `rev-parse --path-format=absolute` 需要 git ≥ 2.31,本机 git 2.28 会把它原样回显,导致 `primaryRoot` 变成字面量 `--path-format=absolute`,worktree 全链路失败。改为不依赖该 flag → 记 [PITFALLS.md](PITFALLS.md) 的「git CLI 的静默失败面」

**回归测试**:`scripts/smoke-git-refs.ts`(10 条断言,覆盖中文文件名、stage 落盘核对、含 `/` 本地分支无幽灵分支、远程 DWIM、detached vs unborn、无上游 push 提示),已挂 `bun run smoke:git-refs`;`smoke-git-files.ts` 的 `code` 契约随 porcelain 原始两列同步更新。

## 7. 我们已经做对的(不要动)

- `git-graph.ts` 的 `%x00` / `%x1e` 分隔格式、`-z`、`--no-color`、`-M -m --first-parent` 处理 merge commit diff、`rev-list --count`
- `git-graph.ts` 已用 `for-each-ref` 按 `refs/heads` / `refs/remotes` / `refs/tags` 分组
- 写操作一律参数数组直传 + `--` 分隔(`files.ts:210`),无 shell 拼接,注入面已闭合
- `scope` 拒绝以 `-` 开头的 ref(`git-graph.ts:218`),防选项注入
- 提交图 TTL 缓存 + `force` 绕过

## 8. 遗留与未知

- **未验证**:`GIT_TERMINAL_PROMPT=0` 的挂起场景、lock 竞争的实际发生率、WSL git 支持(本机 Windows + git 2.28)
- **未做(本轮明确不做)**:IDEA 的 git 可执行文件探测与版本门禁(差距 #7)。目前是「按能力规避」而非「按版本选择」,见 PITFALLS 的静默失败面一节
- **IDEA 未做的事**(别误以为我们漏了):全仓无 `safe.directory` / `dubious ownership` 处理 `[观察:0 命中]` —— 这块两边都交给用户 `git config`
- **未覆盖**:git4idea 的冲突三方合并 UI、shelve 模型(`GitShelveChangesSaver`)、GPG/SSH agent 集成、fsmonitor daemon、大仓的 index 刷新节流
- 分析脚本在 `.local/idea-git-analysis/`(不入库)。规则沉淀见 [BUGS.md](../.agents/BUGS.md) BUG-085/086 与 [PITFALLS.md](PITFALLS.md)

