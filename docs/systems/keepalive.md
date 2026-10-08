# 缓存保活(cache keepalive)子系统手册

> 活文档:跨文件链路地图 + 排障 runbook,随代码同步更新(登记见 [documentation.md](../documentation.md) §2)。
> 机制事实以 `host/keepalive.ts` 头部注释与代码为 SSOT,本手册只画链路与排障路径。
> 上游 SDK 坑见 [PITFALLS.md](../PITFALLS.md)「SDK 装配」;历史事故见 `.agents/BUGS.md` BUG-043 / BUG-050。

## 1. 一句话机制

turn 结束后,按 cadence 向 vendor 重放捕获的请求前缀(max_tokens=16、无流式、tool_choice:none),让厂商前缀缓存按 cache-read 价格续 TTL;探测不进会话流,只有聚合计数与 probe-log 落盘。移植自 [pi-kimi-keepalive](https://github.com/realOliverSama/pi-kimi-keepalive) v0.3.8,上游差异清单见 `host/keepalive.ts:21-29`。

## 2. 文件地图

| 层 | 文件 | 职责 |
|---|---|---|
| 扩展本体(状态机) | `host/keepalive.ts` | 闭包单实例:config 加载、capture、布防/探测/重排/熔断 |
| 配置域 | `host/keepalive-config.ts` | omp-desktop.json keepalive 段原子读写、默认值、smart 双 TTL 存储 |
| 探测协议库 | `host/keepalive-lib.ts` | probe body/headers 组装、usage 解析、花费估算 |
| 注入与事件泵 | `host/session-lifecycle.ts` | 实验开关注入、`session_start` emit(BUG-050 修复点)、keepaliveWanted 翻转 |
| 会话池状态 | `host/state.ts` | `PoolEntry`:keepaliveWanted / keepaliveState / extSessionStarted / keepaliveSid |
| RPC | `host/rpc/session.ts`、`host/rpc/settings.ts` | get_keepalive_status / mark_seen;set_keepalive_enabled / set_keepalive_config |
| UI | `ui-src/components/chat/CtxCard.tsx` KaSection | 上下文明细卡保活段(probes/next/spend/saved 四格) |

## 3. 全链路(事件驱动,每会话独立 timer,无任何轮询)

### 3.1 布防前置——两步缺一不可

1. **`session_start`** → 从 omp-desktop.json keepalive 段加载 config(targets 等)。SDK 不会替嵌入式宿主派发此事件:宿主在 attachEntry 的 `runner.initialize(...)` 之后自己 emit,`PoolEntry.extSessionStarted` 守卫防重(attach 在池复用/前端重连时重跑;重复派发会重置扩展状态、丢 capture)。漏发 = config 恒为默认空靶标,扩展静默半死——BUG-050。
2. **`before_provider_request`**(每次真实模型请求,带该请求实际使用的 model)→ `isTargetModel`(catalog id ∈ targets 且 baseUrl 非空)→ structuredClone 捕获 payload 快照(capture)。

布防判定 `armed()` = 有 capture && 无 pause && 无在途探测。

### 3.2 事件入口

| 事件 | 动作 |
|---|---|
| `session_start` | 加载 config;清 capture/timer/suspended/爬升值 |
| `before_provider_request` | 靶标判定→capture;smart 重解 cadence;清 sticky pause;标记 targetRequestThisTurn |
| `agent_start`(turn 开始) | deadline 暂存 `suspendedProbeAt`,清 timer(UI 此刻显示「已暂停」) |
| `agent_end`(`willContinue !== true` 才算真收尾) | armed → schedule:本轮有靶标请求则 cadence 全额重排,否则恢复暂存 deadline(已过则立刻) |
| `session_shutdown` | 清 timer |

### 3.3 到点 onTick:三道闸 + 重排决策(顺序)

1. `ctx.isIdle()` → agent 忙则保住 deadline 不动,agent_end 恢复。
2. `maxIdleMs`(默认 1h,0=不限)→ 空闲超限 pause。
3. `runProbe()` → 探测。
4. **重排决策**:`isWanted()` true → `schedule()` 下一跳;false(用户已读)→ **不再重排,到此为止**(farewell probe 语义)。

**已读会话 = 最后一跳(farewell probe)**:布防只发生在 agent_end(宿主此刻刚置 wanted=true),已读翻转发生在布防之后——到点时已读的会话仍按原 cadence 时刻探测这一次,探测完停止;下一次 turn 收尾产生新未读才恢复循环。不存在已读会话反复自我重排的路径。

### 3.4 探测结果分支

| 结果 | 动作 |
|---|---|
| hit(cache_read ≥ minPromptTokens) | missStreak/errorStreak 清零;smart 爬升 +30s/次(上下文 >200k 不爬并回落基础档) |
| miss | default 模式:cadence 高于 5min 安全档则退到 5min 继续探测;已在安全档才 missStreak++,达 maxMissStreak(默认 1)pause。smart 模式:确认或清除该模型 max TTL,不轻易 pause |
| error | 401/403 立即 pause(凭据死,等下次真实请求重捕获);其余连续 maxErrorStreak(默认 3)次 pause |
| spendCapUsd(每会话,默认 $1,null=不限) | 超限 pause |

**pause 是 sticky 的,唯一解除路径 = 下一次真实靶标请求**(before_provider_request 清 pause 并重捕获)。

### 3.5 探测端点守卫

`probeEndpoint` 只认 `https://` 基址(anthropic 方言拼 `/v1/messages`,openai 方言拼 `/chat/completions`);凭据由宿主现场解析(OAuth token 会过期,不用 capture 时冻结的),解析失败回落捕获 headers。

## 4. keepaliveWanted(未读语义,宿主侧维护)

| 置 true | 置 false |
|---|---|
| turn 真收尾(`agent_end && isTerminal !== false`,session-lifecycle.ts) | 会话创建初始 false;发消息(rpc/prompt.ts);mark_seen 切回该会话(rpc/session.ts,按 path 匹配);load_session |

即:**用户没在看的会话循环探测**;已读翻转后,已布防的最后一跳按原 cadence 时刻照常执行,跑完即停(见 §3.3 farewell probe)。

## 5. 配置 SSOT:omp-desktop.json keepalive 段(per-profile)

| 字段 | 默认 | 语义 |
|---|---|---|
| `enabled` | false | 注入开关,**只影响此后创建的会话**;探测计费 |
| `targets` | `[]` | 靶标 catalog id(`provider/model`);**空 = 任何模型都不建立 capture** |
| `intervalMs` | 8min | default 模式 cadence(下限 30s;miss 回写 5min) |
| `mode` | `default` | `smart` = 自适应爬升 |
| `maxIdleMs` | 1h | 空闲熔断,0=不限 |
| `spendCapUsd` | 1.0 | 每会话探测花费上限,null=不限 |
| `maxMissStreak` | 1 | 连续 miss 熔断阈值 |
| `maxErrorStreak` | 3 | 连续 error 熔断阈值 |
| `minPromptTokens` | 512 | miss 判定门限(partial hit 不算 miss) |
| `maxOutputTokens` | 16 | 探测 max_tokens 钳制 |
| `modelTtlMs` | `{}` | smart 确认的每模型 max TTL(权威,记入即按它探测) |

磁盘布局:`~/.omp/cache-keepalive/probe-log.jsonl`(每次探测一行审计:命中比/花费)、`model-ttl.json`(smart 爬升中 TTL)。**probe-log 零行 = 一次探测都没跑过**——BUG-050 的第一信号。

## 6. UI 契约与陷阱

- KaSection 渲染条件:回复已落地 && `enabled`;`enabled` = 全局开关开 && 注入成功(entry.keepaliveState 存在)。
- **陷阱:`enabled:true` 不代表扩展初始化过**——注入时宿主写入的零值快照就带 enabled,BUG-050 全程 enabled:true 而扩展从未收到任何事件。`active` 字段状态帧里有但 UI 不显示。
- **「已暂停」= nextProbeAt 为 null 的统一文案,四种来源不分显**:
  1. turn 进行中(agent_start 清了 timer);
  2. 已读且 farewell 探测已完成(最后一跳后不重排;从未布防的已读会话则一次都没有);
  3. 达上限 pause(miss/error/idle/spend,sticky);
  4. **从未布防**(capture 未建立——含断链类事故)。

## 7. 排障 runbook

### 7.0 第一现场:应用通用日志(warn 级,免配置)

探测**失败**与**熔断**自 2026-10-08 起直接落应用通用日志(profile 的 `logs/omp.<日期>.<PID>.log`,logger.warn 立即落盘,不需要 PI_KEEPALIVE_DEBUG):

| warn message | 含义 | 关键字段 |
|---|---|---|
| `keepalive probe failed` | 一次探测尝试失败(计 errors;连续 `maxErrorStreak` 次后熔断) | `sessionFile`(归属会话)、`model`、`endpoint`、`error`(HTTP 状态 / network error / 凭据缺失的根因消息)、`errorStreak` |
| `keepalive paused` | 熔断/暂停(所有 pause 来源) | `reason`、`model` |
| `keepalive probe auth unresolved; falling back to captured headers` | 凭据解析失败回落捕获 headers(后续多半跟着 "no Kimi credentials" 失败) | `cause`(解析失败根因) |
| `keepalive probe endpoint unresolvable` | baseUrl 非 https 导致端点拼不出(静默重排路径,以前无任何痕迹) | `baseUrl`、`api` |
| `keepalive tick dropped — context or capture missing` | 已排 timer 但 ctx/capture 缺失(理论不可达,出现即状态机被外力重置) | `hasContext`、`hasCapture` |

**注意:UI 上下文卡不显示 errors 计数,probe-log.jsonl 只记成功探测**——失败只能在这些 warn 行里找。成功路径零 warn 行。


### 7.1 第一刀:PI_KEEPALIVE_DEBUG=1

宿主启动时带 `PI_KEEPALIVE_DEBUG=1`,stderr 出 `[pi-kimi-keepalive]` 线。链路每一环都有输出,按下表直读结论:

| 观察到的 debug | 结论 |
|---|---|
| 零输出(该会话跑过 turn) | 事件没到扩展:查注入条件(实验开关 + 创建时点)、session-lifecycle.ts 的 emit 与 extSessionStarted 守卫 |
| `target miss: <id> vs targets=[]` | config 没加载(session_start 断链,BUG-050 形态)或 targets 真没配 |
| `target miss: <id> vs targets=[...]` | id 错配(BUG-043 形态):对照靶标选择器(models 帧)的 catalog id |
| `target miss: <id> carries no baseUrl` | 模型注册表缺 baseUrl,探测端点不可解析 |
| `pi-kimi-keepalive paused — <原因>` | 熔断,原因在行内(idle / miss streak / error streak / spend cap / 凭据) |
| `farewell probe settled — session already read` | 正常路径:已读会话最后一跳跑完,不重排 |
| `probe hit/miss: ...` | 探测在跑,看计数与 probe-log |

### 7.2 状态查证(不重启宿主)

WS RPC `get_keepalive_status`(sessionId 用 pool key):probes/hits/spendUsd 恒 0 且 nextProbeAt 恒 null = 从未布防,与 probe-log.jsonl 零行互证。注意 pool key ≠ 磁盘会话 id(独立 UUID),按 path 定位。

### 7.3 隔离复现台(e2e,不污染用户 profile)

1. `OMP_PROFILE=omp-desktop-test` 起全新宿主(profile 目录不存在会自动建);
2. 测试 profile 的 models.yml 写 OpenAI 兼容 mock provider;omp-desktop.json keepalive 段 targets 指向 mock 模型、`intervalMs=30000`(下限,让窗口短到可等);
3. 本地 https 自签 mock 服务(Bun.serve cert/key);宿主带 `NODE_TLS_REJECT_UNAUTHORIZED=0` 过 probeEndpoint 的 https-only 守卫;
4. WS 发 prompt 跑一轮真 turn → 断言链:capture 建立(agent_end 布防,nextProbeAt=+30s)→ 到点探测(mock 收到 probe 请求、probes 递增)→ 30s 循环重排。

### 7.4 历史断链事故(都修在上游链路,不在状态机)

- **BUG-043**(2026-10-05):靶标判定用的 id 与注册表口径错配 → 统一 catalogId(`provider/model`)。
- **BUG-050**(2026-10-07):宿主照抄 ACP 的 initialize 漏抄紧随的 session_start emit → config 恒空靶标、自移植起从未布防;extSessionStarted 守卫修复。
