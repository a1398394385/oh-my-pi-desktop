# Tickets: 架构整治实施队列(arch-remediation)

> 来源:2026-10-14 双审计整合(缺陷审计 P0×1/P1×7/P2×9 × 深度走查 15 候选),去重合并 4 处、修正 1 处冲突(wire 契约落点)后立项。
>
> **Triage**: `ready-for-agent`
>
> **实施仓库**:本 worktree `/Volumes/MacApps/Github/omp-desktop-arch`(分支 `arch-remediation`,基于 aebb775)。
>
> 边界约束(全队列有效):
>
> - **票绿即 commit**(worktree 内 commit,不 push、不提 PR);commit message 解释为什么。
> - 验证三件套:`bun run check` 必跑;动 `ui-src/` 加 `bun run ui:typecheck`(必要时 `ui:build`);动 `host/` 加 `bun run host:build`。smoke 一律 `OMP_PROFILE=omp-desktop-test`(package.json 已内嵌;无 npm 别名的冒烟直接 `OMP_PROFILE=omp-desktop-test bun scripts/<file>.ts` 执行);需真模型或 default profile 的冒烟在票面标注,不在无用户在场时跑。
> - **测试红线**:禁止裸跑 vitest / 多包并发测试;任何长跑命令中断后 `ps aux | grep vitest` 查孤儿进程。
> - 代码注释英文;用户可见文案走 `ui-src/i18n/`(UI)/ hostI18n(host);全部文件 UTF-8。
> - **外科手术式**:每行改动可追溯到票面;票面外的缺陷记入回报不顺手修;既有死代码只报告不删除。
> - **设计不可擅改**:票与实际代码冲突(行号漂移属正常,以符号为准;结构性冲突)停下上报。
> - 行号引用来自 2026-10-14 审计亲验,实施时以符号为准。

## 依赖图

```text
A1  desktop-json 容错语义(P0 数据丢失链)   ← frontier
A2  七处读写轮子收敛                       ← A1
A3  delete_session 协议分叉修复            ← frontier
A4  功能静默失效 5 处补上报                ← frontier
A5  设置页假数据 4 处                      ← frontier
A6  stats HTTP Origin 白名单               ← frontier
A7  门禁棘轮补后起热区基线                 ← frontier(先于一切拆分)
A8  hostI18n 迁中立位                      ← frontier
A9  57 处中文 stderr 迁 hostI18n           ← A8(同文件域,减少 import 冲突)
A10 wire 帧契约中立位(响应+请求双向)       ← A8(中立位规则先确立)
A11 审批流收拢 requestApproval             ← frontier(宜先于 A12,同文件)
A12 session-lifecycle 切两个内部 seam      ← A7、A11(含 created 帧三抄收敛)
A13 右栏展开不变量收拢                     ← frontier
A14 Composer 发送管线下沉                  ← A13(同域减冲突)
A15 设置页控件沉淀 common.tsx              ← frontier
A16 keepalive 宿主侧状态机收拢             ← A2(同文件域)
A17 branched/forked 回执合并               ← frontier(小票)
A18 真重复收敛(fmtDuration/fmtAgo/config)  ← frontier(小票)
A19 冒烟脚本共享库                         ← 观察触发,不专项重写
A20 ui/assets/app.js 旧产物删除            ← blocked-on-user(文件删除需授权)
```

泳道速览:A1-A6 正确性与数据安全 · A7-A9 治理与门禁 · A10-A15 结构加深 · A16-A18 尾部收敛 · A19/A20 待触发/待拍板。

**不立项观察项**(触发条件命中时再评估立项,防止重复怀疑):候选8 translate 投影表(host 自有工具再加 3 个时)· 候选12 ring-pop hook(第 4 张弹卡出现时)· 候选13 条目树 walk 原语(下次改 chat 折叠行为时)· 候选14 placement 一致性断言(下次挪设置键时)· D-2.1 时长格式化四兄弟(新页面消费时长时先收敛)· S-1 旁路总线(第 6 条出现时收 createBus)· S-2 WS 断连白名单(新数据请求受害时补)· B-4 模型配置三写(下次动 models 设置域时)。

---

## A1: desktop-json.ts 容错语义修复——读失败拒绝合并写(P0 数据丢失链)

**What to build**:E-1 唯一 P0。现状:`host/desktop-json.ts` 与各私有副本在读取 omp-desktop.json 失败(损坏/EBUSY/EPERM)时返回空对象,后续任意一次 merge-write 会用空 base 全量重写文件,acp/keepalive/ui/computerDisplay 等非托管 sections 被静默清出,零报错零日志。修共享模块语义:read 区分**文件不存在**(合法空态,正常创建)与**存在但读失败/损坏**(抛错或返回 null);writeDesktopSection 发现读失败时**拒绝写入**并 safeStderr 上报,保住盘上未知内容等待人工介入,绝不覆盖。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] 读失败(构造损坏 JSON)时 writeDesktopSection 拒绝写入 + stderr 有日志 + 盘上原文件字节不变
- [ ] 文件不存在时正常创建初始结构(不误伤首次启动)
- [ ] `bun run check` + `host:build` 绿;新增最小冒烟(损坏文件场景)或并入既有冒烟

---

## A2: 七处 omp-desktop.json 读写轮子收敛到共享模块

**What to build**:候选3/D-1 合并项(取两份审计并集)。绕开 `desktop-json.ts` 的七处全部迁移:①`host/profile.ts` saveDesktopProjects(:97-101)+ readAcpRaw/writeAcpEnabled/writeSessionContextEnabled;②`host/assets.ts` writeHooks/PluginsEnabled(:1085-1093、:1106-1117,多 mkdir 的变体并入共享模块参数);③`host/keepalive-config.ts` 私有三件(:177-195);④`host/ui-config.ts`(:15-32);⑤`host/computer-display.ts`(:64-70);⑥`host/rpc/settings.ts` set_acp_config 内联(:185-191)。各域真实现原位保留(如 keepalive 的 normalizeProbeConfig、writeSection 的 probeEnabled 遗留 key 清扫语义随迁移保真)。

**Blocked by**: A1(先修容错语义,否则把坏语义迁移过去)
**Status**: open

- [ ] grep 七处私有 read/merge-write 副本零残留
- [ ] 行为保真:keepalive 探针写回、acp 开关、ui 配置、显示器绑定读写路径冒烟通过
- [ ] `bun run check` + `host:build` 绿

---

## A3: delete_session 协议分叉修复(path+previousPaths + dispose)

**What to build**:候选5 疑似真 bug。`host/rpc/session.ts:328` 只精确匹配 `entry.path`,违反 state.ts:183-189 记录的条目身份协议(path + previousPaths)——持久化迁移过的会话按旧 path 删除时池条目漏删,文件删了 AgentSession 还活着继续写新文件;且释放序列缺 dispose(对照 reload_session:261-283 / session_unload:298-310),另有 2 处裸 `catch {}` 吞错(:330、:331)。最小修法:匹配与释放对齐另两处;若四调用点(reload/unload/delete + host/session-lifecycle.ts:1488-1491 的 handleLoadSession 池匹配)自然导向 resolvePoolEntry/releasePoolEntry 两原语则顺势收敛,不强行抽象;裸 catch 换 safeStderr。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] 构造 previousPaths 命中场景:按旧 path delete_session 后池条目被清除、session dispose 被调用
- [ ] delete_session 路径无裸 `catch {}`;释放失败有 stderr 痕迹
- [ ] 会话类冒烟回归(smoke.ts / smoke-session 系)+ `bun run check` 绿

---

## A4: 功能静默失效 5 处补上报(E-2)

**What to build**:开关显示正常、实际没生效的五处,统一补 safeStderr 或 error 帧上报:①`host/profile.ts:198` winSleepSetter 防休眠失败;②`host/session-lifecycle.ts:1146-1150` kimi 自动思考门控与 `:1138-1142` 显式 thinkingLevel 设置的吞错(同修法);③`host/mcp-mount.ts:300-302、:393-395` 卸载后 refreshMCPTools 失败静默,以及**挂载路径 `:263-267`(同为 `try { void promise } catch` 形态,catch 抓不到异步 rejection,一并改 `promise.catch(fn)` 形态)**,与挂载侧日志对称;④`host/browser-mirror.ts:264-267` 镜像 poll 总开关吞错;⑤`host/session-lifecycle.ts:1154、:1190` setComputerMode 蒸发。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] 五处失败路径均有可 grep 的 stderr 标记(带定位上下文)
- [ ] mcp-mount 异步 rejection 真的可被抓(形态修复,非仅加日志)
- [ ] `bun run check` + `host:build` 绿

---

## A5: 设置页假数据 4 处修复(E-3)

**What to build**:catch 后返回伪造成功态的四处,改为明确的「不可用」响应或上报:①`host/rpc/settings.ts:260-262` agent 资产列表返回空;②`host/voice.ts:224-226` 缓存态误报未缓存;③`host/rpc/models.ts:228-230` 账号数误报 0;④`host/rpc/login.ts:222-225` 配额列空。原则:失败路径的数据要么带错误标记让前端显示错误态,要么至少 stderr 上报;禁止把空数组/0 当成功值返回。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] 四处失败路径可观察(前端错误态或 host 日志),不再是无声假值
- [ ] 正常路径行为不变(不把成功态误伤成错误态)
- [ ] `bun run check` + `host:build` 绿

---

## A6: stats HTTP 旁路收紧——Origin 白名单替代 CORS *(B-1)

**What to build**:`host/stats.ts:89-93` 对全部 `/api/*` 响应附 `Access-Control-Allow-Origin: *` 且零鉴权,本机任意网页可跨源读取会话统计与转录(`/api/session/trace?file=` 直收路径)并可 POST 变更。修法:Origin 白名单——请求 Origin ∈ {tauri 源(macOS `tauri://localhost`、Windows `http://tauri.localhost`)、dev 源(`http://localhost:*`)}才回 ACAO 同源值,否则不回该头(浏览器侧跨源读取被浏览器拦截);无 Origin 头的本地工具(curl 等)放行。SSE/live 路径同规则。**不能直接删 CORS**:Tauri WebView 与 WS 动态端口不同源,跨源是功能依赖。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] 冒烟:伪造恶意 Origin 的预检/简单请求拿不到 ACAO 头;tauri Origin 正常拿到
- [ ] stats 页(设置→统计)在 tauri dev 下正常加载(真机验证待用户,冒烟先以模拟 Origin 覆盖)
- [ ] `bun run check` + `host:build` 绿

---

## A7: 架构门禁棘轮补后起热区基线(G-1)

**What to build**:`scripts/check-architecture.mjs:22-25` HOT_LIMITS 仅两条(host/main.ts 280、store/session.ts 800),后起热区全部漏网。补三条现状基线:`host/session-lifecycle.ts ≤1600`、`host/assets.ts ≤1600`、`host/translate.ts ≤1200`(现状 + 微缓冲,只许降不许升)。A12 拆分完成后同步下调 session-lifecycle 基线。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] 现状过 check;故意加行(临时)被拦后回滚
- [ ] 基线数值与注释(「现状锁死」语义)符合棘轮既有风格

---

## A8: hostI18n 迁中立位,断开 host→ui-src 反向依赖(B-2)

**What to build**:`ui-src/i18n/host.ts` 是宿主专用 i18next 实例却住在前端目录,host 侧 30 处 `import ... from "../ui-src/i18n/host"`(host 根 16 + rpc/ 14),`check-host-boundaries.mjs:375` 对 host 外部导入直接跳过,边界零拦截。迁移到 host 域(如 `host/i18n/`),30 处 import 更新;**先查 host.ts 的 import 图**——若其消费 ui-src/i18n/locales 下语言包资源,一并评估资源是否双端共享:host 专用资源随迁,双端共享资源走中立位。目标:host→ui-src import 零残留。此票与 A10 共同确立「两端共享物放中立位」规则。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] `grep -rn 'from "\.\./ui-src' host/ host/rpc/` 零命中
- [ ] check-host-boundaries 边表按新结构登记(不再依赖「跳过」豁免)
- [ ] host 错误消息语言不受影响(冒烟或 host:build 后手测一条错误路径);`bun run check` 绿

---

## A9: 57 处中文 stderr 迁 hostI18n(B-3)

**What to build**:16 文件 55 处 `safeStderr` 中文硬编码(重灾区 mcp-mount.ts 11、session-lifecycle.ts 6、profile.ts 7、main.ts 6),基础设施 hostI18n 已在位未铺满。逐处迁 `hostI18n.t`,新键入既有 errors.* 命名空间,双语言补齐。用户可操作类优先(如 profile.ts:366 无可用模型、computer-display.ts:126 重选显示器)。

**Blocked by**: A8(同文件域,先完成迁移减少 import churn)
**Status**: open

- [ ] grep safeStderr 后跟中文字面量零残留
- [ ] check-i18n-keys 双向门禁绿;en/zh 键对齐
- [ ] `bun run check` + `host:build` 绿

---

## A10: wire 帧契约中立位——响应方向合一 + 请求方向补类型(候选1)

**What to build**:整合修正后的候选1(原「ui-src 直接 import host」方案被 B-2 否定,反向依赖本身是问题)。落点:中立位置单个纯类型文件(零运行时代码、零 Node/Bun 类型依赖——host 不在 ui 的 tsconfig,混合依赖造成 tsc 假绿),放 `host/wire/` 或按 A8 确立的中立位规则。内容:HostFrame union + 共享 payload 形状(TranscriptItem/UiEvent/TurnUsage/KeepaliveConfig)单一真源;`ui-src/types/frames.ts` 的手抄镜像改为 import 转发或直接替换;**顺手修三处已漂移**(frames.ts:371 缺 "error" role、`host/translate.ts` 的 UiEvent union 缺 user_message 变体(实发点 `host/automations/scheduler.ts:317`)、锚点注释改符号引用如 `host/state.ts#TranscriptItem` 弃行号)。第二个 commit:请求方向 union(键集镜像 host rpcHandlers,可加 check 断言键集一致),`WsSlice.send` 签名从 `unknown` 收紧;110 个旧调用点渐进迁移不强制一次改完。

**Blocked by**: A8
**Status**: open

- [ ] 帧类型单一真源;ui:typecheck 绿;故意改一个帧形状,双端同时编译报错(验证合一生效)
- [ ] 三处漂移修复(error role / user_message / 锚点)
- [ ] 请求 union + send 收紧后新代码受检;check-host-boundaries 边表登记新边
- [ ] 全量 smoke 回归(smoke.ts 起宿主,帧收发不走样)+ `bun run check` 绿

---

## A11: 审批流收拢 requestApproval(候选2)

**What to build**:`host/state.ts:279-361` 的 requestApproval(presentation 现支持 keepContextTokens/disabledIndices/slider/editable/editableIndex/plan/questions;**prefill 是缺口**——只在 editor 手搓帧 `session-lifecycle.ts:747` 存在,收敛 editor 时必须扩展 presentation(或帧构造)补上,否则 ask 对话框已输入文本的回填丢失)只被 select(:694)使用;confirm(:703-723)/editor(:724-752)/askDialog(:759-794)在 session-lifecycle 各手搓 25 行(randomUUID + pendingApprovals.set + ws.send + abort 监听,细节有微差:confirm 无 abort 监听);approval_response 的 settle 落在 `rpc/settings.ts:326-337`(域错位);state.ts:276 注释指认 main.ts 已陈旧。收敛:三处改走 requestApproval(补齐差异参数含 prefill),settle dispatch 挪到 requestApproval 同文件,审批状态机(表 + settle + blockKind + session-lifecycle.ts:414-428 的 keepalive blockState 读取)获得单一模块边界。abort 监听差异(confirm 无)核实是刻意还是漏,刻意则注释。

**Blocked by**: None — can start immediately(宜先于 A12:同在 session-lifecycle,减少拆分后返工)
**Status**: open

- [ ] 四种审批类型全部走 requestApproval 单入口;grep 手搓骨架零残留
- [ ] smoke:approval 冒烟回归(或新冒烟直接 import + fake ws 断言请求帧与 settle 时序)
- [ ] `bun run check` + `host:build` 绿

---

## A12: session-lifecycle.ts 切两个内部 seam + created 帧收敛(候选4+6)

**What to build**:1585 行按概念切两刀:①`host/subagent-view.ts`——live 侧 5 个 Map(:890-901)+ 3 个订阅 payload 拼装(:925-1044,含 IRC wake-turn 折算 :968-982)+ 磁盘重放纯函数族(:1194-1476 约 280 行),attachEntry 只留订阅接线;②`host/session-snapshot.ts`——pushGoal/pushTodos/pushContext/buildSessionStats/countCacheBreaks(:109-300)+ keepaliveStatusPayload(:57-78)。③顺带候选6:session_created 帧体三抄(:1156-1170/:1500-1513/:1557-1570)收敛单一构造点,快照九步序列(:1514-1521/:1571-1585)按 mode 参数化组合,分支差异(顺序差异)显式注释是必须还是偶然。纯搬家重构,diff 证明行为零变;完成后下调 A7 棘轮(session-lifecycle 基线)。

**Blocked by**: A7(棘轮先锁)、A11(同文件先收敛审批)
**Status**: open

- [ ] 九项相关冒烟零改动全回归(subagent/subagent-subview/keepalive 系/plan/kimi-auto 等)
- [ ] session-lifecycle 显著瘦身(目标 <900 行,以 diff 纯搬家为约束,不为数字硬切)
- [ ] created 帧/快照序列收敛后,「load 一个会话应收哪些帧」可在冒烟中断言
- [ ] A7 棘轮基线下调;`bun run check` + `host:build` 绿

---

## A13: 右栏展开不变量收拢(候选9)

**What to build**:「展开右栏 = 压下流程卡(todoCollapsed: true)」跨模块不变量手写 6+ 处(shell.ts:104-106、Composer.tsx:1015-1023、chat/parts.tsx:483-489/:519-530/:539、right/tabs.ts:70),AgentHubPage.tsx:129 与 TodoCard.tsx:119 已漏配对(只写 rightCollapsed: false)。在 right.ts/tabs.ts 收敛一个「带 tab 打开并展开右栏」action(内部统一 rightTab/rightCollapsed/todoCollapsed/selectedFile 清理),调用点改一行;Composer toggleBgTab 保留 toggle 语义复用它;两处漏配对修复。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] 调用点全部走 action;grep 手写 `todoCollapsed: true` 配对零残留(action 内部除外)
- [ ] AgentHub/TodoCard 入口行为与其他入口一致(流程卡让位)
- [ ] `ui:typecheck` + `bun run check` 绿;smoke:react 回归

---

## A14: Composer 发送管线下沉 store(候选10)

**What to build**:Composer.tsx(1332 行 ≥6 概念)的发送管线(:434-543,含 bash 模式/welcome 延迟创建/queue/steer)下沉为 store 层 action,组件只取草稿文本调用;**乐观启动三写收敛一**(组件 :522-533、wsHandlers/session.ts:189-197 消费 pendingNewPrompt 重写、store/session.ts:472-479 applyEvent 第三写)——「本地启动一条 run」成为唯一写法;pendingNewBash/pendingNewPrompt 语义随 action 搬;纯函数 filterCommands/filterSkills/filterSubcommands(:60-101)与 bgTaskCount/subagentCount(:145-177)迁 composer/ 独立模块;fit() 底栏测量留原地(纯 DOM)。

**Blocked by**: A13(同域减冲突)
**Status**: open

- [ ] 乐观启动单一写法;grep 三处逐字段手写零残留
- [ ] smoke:queue + smoke:steer-queue-order + smoke:newsession 类回归(发送/排队/steer 行为不变)
- [ ] filterCommands 族可独立 import 断言(迁移后至少一项直接测试)
- [ ] `ui:typecheck` + `bun run check` 绿

---

## A15: 设置页控件沉淀 common.tsx(候选11)

**What to build**:`components/settings/common.tsx`(现仅 confirmDialog/LoginBanner/emptyRow)补三个行控件:`Toggle`(渲染 .tg,props: on/disabled/onChange)、`Sel`(合并七份变体:GeneralPage:39-81、ExperimentalPage:31-91、AppearancePage:77、ComputerPage:40、VoiceSection:36、McpPage:227、CapabilityPage:40——claimDropdown + 外点关闭 + dropUp/wide 参数化)、`Srow`(标题+描述+ctl 标准行布局)。各页渐进替换,类名不变(遵守 AGENTS.md 设置页控件语言,不引 Radix);ExperimentalPage 的 .tg 裸写 7 处优先替换。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] 七份 Sel 收敛为一个;grep 各页私有 claimDropdown effect 零残留
- [ ] `ui:build` + `ui:typecheck` 绿;设置页视觉零变化(类名级 diff 审查)
- [ ] 下拉互斥/外点关闭行为一致(现有全局行为不回归)

---

## A16: keepalive 宿主侧状态机收拢(候选7)

**What to build**:keepaliveWanted 写点散布 4 文件(session-lifecycle.ts:626 agent_end→true、:1494 load→false、rpc/prompt.ts:496 prompt→false、rpc/session.ts:233 mark_seen→false),状态存储 state.ts:90-97,帧体语义只活在 session-lifecycle.ts:52-78 注释里。收拢为 keepalive-host.ts(或并入 keepalive.ts):markTurnWrapped/markSeen 两操作 + statusPayload + reportState 推送,PoolEntry 只留字段;「非 target 必须报 zeroed disabled shape」语义从注释升级为代码。

**Blocked by**: A2(同文件域先完成配置收敛)
**Status**: open

- [ ] 四写点变四行调用;grep 直接写 keepaliveWanted 零残留(收拢模块内部除外)
- [ ] keepalive 冒烟回归(探针注入/mark_seen 流转)
- [ ] `bun run check` + `host:build` 绿

---

## A17: branched/forked 回执合并 + selectedImages 分叉核实(D-2.2)

**What to build**:`store/wsHandlers/session.ts:338-355`(session_branched)与 :356-375(session_forked)十八行复制,隐藏分叉:branched 传 `msg.selectedImages`,forked 硬编码 undefined,且 SessionForkedFrame 类型(frames.ts:802-810)无 selectedImages 字段。核实 fork 分叉是 bug 还是刻意(fork 不带图?)后合并为 applyForkReceipt;若为 bug,host 侧 fork 帧是否补字段一并在回报中给出(改 wire 契约需对齐 A10 落点)。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] 分叉核实结论落票面;applyForkReceipt 合并后两路径行为一致
- [ ] 会话树分叉/导航冒烟回归(session-tree 系)
- [ ] `ui:typecheck` + `bun run check` 绿

---

## A18: 真重复收敛(D-3)

**What to build**:同名同义可合一的三组:①fmtDuration 双定义(chat/util.ts:151 ≡ sidebar/util.ts:14)合一;②fmtAgo 双定义(right/helpers.ts:7 ≡ sidebar/util.ts:6)合一;③wsHandlers/config.ts ready/settings 两段落地(:33-48 vs :71-83,注释自认 same ordering)提为共享函数,顺序差异显式。

**Blocked by**: None — can start immediately
**Status**: open

- [ ] grep 全仓唯一定义;消费方 import 更新无孤儿
- [ ] `ui:typecheck` + `bun run check` 绿

---

## A19: 冒烟脚本共享库(D-5,观察触发)

**What to build**:33 个冒烟脚本各自手写宿主启动样板(READY 正则 ×33、waitFor/waitFrame 重复 ×7、超时三种)。**不专项重写**:下次新增冒烟脚本时把 waitFor/waitFrame/宿主启动提为 scripts/lib/ 共享,存量脚本碰到哪个改哪个。

**Blocked by**: 触发条件(下次新写冒烟脚本)
**Status**: deferred-by-design

---

## A20: ui/assets/app.js 3.9MB 旧构建产物删除(D-4 拍板项)

**What to build**:2025-09 旧构建产物仍入库(现役产物在 ui/dist/),唯一引用者过期 dev-reader.html:23。文件删除需用户授权,**待拍板**;其余死代码 12 条(bootstrap re-export ×3、mcp-pool 整函数 ×2、migrateMcpSharingConfig、shadcn 基件 ×5、ArchivedSection、stats/traces barrel)按宪法只记录不删除,清单见审计报告 D-4。

**Blocked by**: 用户授权
**Status**: blocked-on-user

---

## 完工定义

全部 open 票 Status 转 done、观察项留档、A20 得到拍板(做或明确不做)后:本文件随最终批次 commit,整合报告五要素(行为变化/改动文件/实际验证/跳过项/遗留风险)在收尾回报中给出。
