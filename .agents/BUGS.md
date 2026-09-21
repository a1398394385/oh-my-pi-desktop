# 已知 Bug 与历史教训

> **结构**:开局「问题总览」表(BUG-NNN 编号 / 标题 / 日期),下为逐条详情(现象/根因/修复/教训);新条目追加到详情末尾,编号顺延,并在总览表同步加一行。
> **超限说明**([documentation.md](../docs/documentation.md) §5 长度预算·追加型历史结构性超限):本文是累积追加型文档,删除已修复条目会丢失教训。单条 ≤ 60 行,总数随历史增长。
> **边界**:本仓库代码 bug 记这里;外部依赖(omp SDK / Tauri / macOS)行为与预期不符的坑记 [docs/PITFALLS.md](../docs/PITFALLS.md)。

## 问题总览

| 编号 | 标题 | 日期 |
|---|---|---|
| BUG-001 | 新工具标签展开卡显示 `{}` 与「(无输出)」——宿主转发层未同步扩展 | 2026-09-20 |
| BUG-002 | 思考展开框内嵌滚动两坑：竖线滚走 + 滚动链带动会话区 | 2026-09-20 |
| BUG-003 | 添加供应商卡片 hover 闪烁、点击无反应——渲染函数与 RPC 响应互调成无限重绘 | 2026-09-20 |
| BUG-004 | 保存 API key「没有反应」——core.js 调用未 import 的函数抛 ReferenceError | 2026-09-20 |
| BUG-005 | 新建会话发首条消息后闪回欢迎页——底座会话文件懒建与 UI"已落盘"假设竞态 | 2026-09-20 |
| BUG-006 | 点一条排队消息「立即发送」把整队消息都发了——底座注入边界 drain 整队 followUp | 2026-09-20 |

---

## 详情

### BUG-001: 新工具标签展开卡显示 `{}` 与「(无输出)」——宿主转发层未同步扩展

**现象**:主对话区为新工具(web_search/ask/debug/github/lsp/记忆五件套)补齐标签行后,行本身渲染正常(图标+中文标签+摘要),但点击展开的内容卡里参数区只有 `{}`、结果区只有「(无输出)」。

**根因**:数据链路是「底座工具事件 → `host/translate.ts` 过滤/摘要 → WebSocket → 前端渲染」,前端渲染层加了新标签,宿主转发层没有同步扩展:
1. `toolArgsForUi()` 是按工具白名单过滤参数的——web_search 的 `query`、ask 的 `questions` 等不在名单,落入默认分支只保留 `path/files/content`,args 被丢光;
2. `summarizeResult()` 只给 bash/shell/eval/hub 提取 `output`、给 read/hub 提取 `details`,其余工具什么都不带。

前端渲染器对缺数据只能回退显示 `{}` /「(无输出)」,不是渲染 bug。

**修复**:`host/translate.ts` ——
1. `toolArgsForUi()` 为 12 个工具补白名单分支(字段与 UI 摘要一一对应),大参数经 `capValue()` 超 8KB 降级截断;
2. `summarizeResult()` 新增标签工具组分支,抽出 `resultText()`(unknown + 类型守卫)提取结果文本进 `output`,截断 20KB;
3. 历史回放路径(`entriesToTranscript`)走同一 `toolArgsForUi`,args 自动恢复;output 回放本就不存在(终端行历史同样无输出),未动。

**教训**:给前端加新工具标签是「跨进程契约变更」,必须三层一起查:前端渲染(ui/tool-labels.js)、宿主转发(host/translate.ts 的 `toolArgsForUi` + `summarizeResult`)、底座参数 schema。行能渲染 ≠ 有数据。已立 RULE-001。

### BUG-002: 思考展开框内嵌滚动两坑——左侧竖线滚走 + 滚动到边界带动外层会话区

**现象**:主对话区思考标签的展开框(`.think-body`),① 往下滚动时左侧区域划分竖线会消失;② 内容滚到最底端(或最顶端)后继续滚动,整个会话区域会被带着向下(向上)滚动。

**根因**:`.think-body` 自己就是滚动容器(`overflow-y: auto`),两个坑都是内嵌滚动容器的经典问题:
1. 竖线是它的 `::before` 绝对定位元素。绝对定位子元素属于滚动内容的一部分,会随内容一起上移,滚多了整条线移出视口;
2. 滚动链传递(scroll chaining):内嵌容器滚到边界后,剩余滚轮量/触控板惯性继续传给祖先 `#stream`,外层跟着滚(顶/底两个方向都一样)。

**修复**(ui/style.css + ui/tool-labels.js):
1. 结构拆分——滚动职责移到内层 `.think-scroll`(max-height/overflow/mask/滚动条/底部虚化全在 inner),竖线 `::before` 留在外层非滚动节点上,不再随内容移动;
2. `.think-scroll` 加 `overscroll-behavior: contain` 阻断滚动链;
3. 同轮排查补齐全部内嵌滚动容器(共 12 处):会话区 `.ed-brief`/`.cmd-card-cmd`/`.cmd-card-out`/`.approval-title`/`#todoList`,右栏 `.bgcmd-code`/`.bgcmd-out`,设置页 `.md-side`/`.md-main`/`.md-main pre`/`.sem-body.form`。

**教训**:加内嵌滚动容器时有两个必查项——装饰元素(线/角标/背景)不能放在滚动节点内(会随内容滚走);滚到边界后的手势会传给外层滚动区(除非 `overscroll-behavior: contain`)。顶层滚动区(`#stream`/`#rightBody`/`#setBody`/`#tasklist`)、fixed 浮层菜单、纯横向溢出容器不受此限。已立 RULE-002。

### BUG-003: 添加供应商卡片 hover 闪烁、点击无反应——渲染函数与 RPC 响应互调成无限重绘

**现象**:「＋ 添加供应商」视图中,鼠标悬停卡片高亮不断闪烁,点击卡片无反应(进不了详情页)。

**根因**:为修「登出后已配置徽标不收敛」,把 `send({type:"get_all_providers"})` 放进了 `renderAddProviderView()`;而 core.js 的 `all_providers` 响应处理器在 `S.mpAddView` 时也会调用 `renderAddProviderView()`。两者互调形成无限循环:渲染 → 发请求 → 响应到达 → 再渲染 → 再发请求…DOM 每轮重建,hover 状态丢失(闪烁),点击瞬间目标元素已被替换(onclick 随之丢失)。

**修复**:渲染函数回归纯渲染,请求只在三个视图入口发——① index.js 点「＋ 添加供应商」按钮;② providers.js 详情页「← 返回」按钮;③ core.js `provider_key_done`(保存 key 成功)。响应处理器保留「更新缓存 + 条件重渲染」,重渲染本身不再发请求,循环终止。

**教训**:给渲染函数加请求前,必须先查该消息 type 的响应处理器会不会调回本渲染函数——会则形成自激循环,请求必须上移到入口。症状识别:UI hover 闪烁 + 点击无反应 ≈ 无限重绘。已立 RULE-003。

### BUG-004: 保存 API key「没有反应」——core.js 调用未 import 的函数抛 ReferenceError

**现象**:供应商详情页粘贴 API key 点保存,界面长时间无反馈,过一会才弹「已保存」toast;左侧供应商列表也不刷新,需手动点击。

**根因**:core.js `models_catalog` 分支写着 `if (S.mpDetailProv) renderProviderDetail();`,但该函数既未 import 也无全局定义——v12 ESM 拆分迁移遗漏。`models_catalog` 推送到达时该行直接抛 ReferenceError,中断当条消息处理(左侧列表渲染全没跑);`provider_key_done` 是下一条独立消息,正常处理弹出 toast,造成「延迟才有反应」的错觉。

**修复**:`models_catalog` 处理改为统一走 `renderModelPage()`(内部按 mpAddView/mpDetailProv/mpRolesView 分发),消除跨文件直调。

**教训**:跨模块函数调用必须核对 import(本仓无 lint 链,无人代查);症状上「部分消息有反应、部分没反应」= 消息处理器中途抛错,优先怀疑 ReferenceError。

### BUG-005: 新建会话发首条消息后闪回欢迎页——底座会话文件懒建与 UI"已落盘"假设竞态

**现象**:新建会话发送"你好",主对话页闪现一下,随即弹回欢迎页;后续回复帧全部丢弃。

**根因**:两层叠加。①底座 `SessionManager` 完全懒建会话文件——`createAgentSession` 后、首条真实内容写入前,磁盘上没有 jsonl(`flush()` 也不建空文件,实测验证);②UI 在 `session_created` 处理尾部立即 `list_sessions` 重拉,`session_list` 里有"活跃会话不在列表→`openSessions.delete`+弹回欢迎页"的清理逻辑,而 `handleListSessions` 只扫磁盘(`SessionManager.listAll()`),刚建的会话必然缺席→误杀。历史上没炸是因为 UI 曾传 `thinking:"off"`,`setThinkingLevel` 的落盘副作用有时碰巧先建了文件(纯运气竞态)。

**修复**:host 侧 `handleListSessions` 把内存会话池(`sessions` Map)中磁盘上还没有的活跃会话兜底并入列表(stub:空 title/firstMessage、messageCount=0、modified=now),按 `entry.cwd` 归入项目。文件懒建语义不变,列表数据源变为"磁盘∪内存池"。

**教训**:跨进程数据契约要以实测为准——UI 注释写的"新会话已落盘"从未被底座保证过;凡是"扫磁盘→对账内存态"的校验,必须先问文件创建时机。诊断利器:脱离 Tauri 直连 host 的 ws 复现脚本(create_session→list_sessions 时序一跑即现)。

**衍生坑(冒烟固化时发现,已一并修复)**:①内存池兜底与 remove_project 语义冲突——已移除项目的活跃会话会把项目顶回列表,兜底循环须跳过 `removedProjects`;②冒烟/临时目录建会话再拉 list_sessions,历史扫描(mergeHistoryProjects)会把临时 cwd 永久写进 omp-desktop.json 的 allProjects——凡触发 list_sessions 的测试脚本必须备份还原该文件(先 kill host 再写回,防退出钩子回写)。

### BUG-006: 点一条排队消息「立即发送」把整队消息都发了——底座注入边界 drain 整队 followUp

**现象**:流式中排 3 条队,点第 1 条的「立即发送」,三条全部被发出,且拼进同一次模型回复(一次 turn_end 里同时含三条的答复)。

**根因**:底座 `runAgentLoop` 的注入边界(工具批次后 / yield 边界 / run 起始 steering poll)会把 steering + followUp 队列 drain 到排空才停——任何留在 followUp 队列的消息都会被当前 run 带走。host 的 `handleSendNow` 只把被点的那条转 steer,没保护剩余 followUp 消息:它们被同一 run 的 yield boundary 依次 dequeue,与被点消息拼进同一轮(`one-at-a-time` 只限制单次 dequeue 条数,不阻止边界处连续 dequeue)。自然排队路径(不点立即发送)同样整队被吃,只是各占一次模型调用;`send_now` 的 steer 注入又触发了 mid-batch/stop 边界的连续 drain,把整队拼进一次调用,表现最差。实测复现:read 工具结束到 bash 结束之间连续三帧 dequeue,turn_end 仅一次、回复 "AAA-DONE BBB-DONE CCC-DONE" 连写。

**修复**(host 层,不动底座):`PoolEntry` 增 `parkedFollowUp` 暂存区,维持不变式「底座 followUp 队列最多留 1 条用户消息(下一个待消费的)」——①流式 prompt 入队后(`handlePrompt` then)、`send_now`、`requeue` 后统一 `parkFollowUpTail()` 修剪,超出部分连同前导隐藏伴随(图片描述)进 parked;②`agent_end`(isTerminal)时从 parked 放回 1 条(`agent.followUp` 原结构回队,保图片)并 `agent.continue()` 触发消费(busy 竞态经 waitForIdle 补一次);③`send_now`/`drop_queued` 的 followUp 索引改按完整视图(底座队列+parked)定位;④`sendQueued` 快照与 turn_end 收尾竞态兜底的 `queuedTexts` diff 都并入 parked,防误判「被吞」而重发。排队消息自此逐轮 FIFO、每轮一条独立 turn。

**教训**:底座队列语义是"流水线"(run 内 drain 到排空),桌面 UI 的队列语义是"逐条可控"——host 层夹在中间必须显式翻译,不能假设「入队后什么时候被消费」与 UI 呈现一致。凡"点一条/删一条"的索引型 RPC,索引必须基于 UI 看到的完整视图,而不是底座物理队列。回归冒烟:`scripts/smoke-sendnow.ts` 三断言(点的那条独立成轮 / 逐帧单条注入 / 其余各占独立 turn)。

### BUG-007: 「立即发送」点击瞬间即分割处理过程 + 放回队列后新过程裸奔不可收缩（UI 层三缺陷，底座一层遗留）

**现象**:①点排队消息的「立即发送」，历史过程立刻被缩起分割，但当时 steer 消息尚未被消费；②随即点「放回队列」，消费后处理过程变两段：分割点前的历史正常缩起，之后新流入的过程原样展开且不进 loop 组（无收缩）；③被放回的消息偶尔从消息流消失。

**根因**(UI 三层叠加，实测帧序复现):①设计违背——`sendNowQueueMsg` 在点击瞬间 `sealRunItems` 预封存并重置 `turnItemStart`，而既定设计是「仅消费时才分割」(`steer_consumed` 处理器本就实现了完整的消费时尾段封存，点击预封存多余且有害)；②点击与放回之间流式推入的过程行落在封存点之前，requeue/drop 的校准逻辑只判 `turnItemStart > items.length` 越界、管不到「点后插入」，这些行永远进不了 loop 组；③`steer_consumed` 找不到气泡时建的兜底气泡只 new 对象从没插进 `s.items` → 消息消失。实测帧序关键事实:`steer_consumed` 先于 `turn_end` 到达。

**修复**(ui/core.js):①`sendNowQueueMsg` 删掉点击时封存/draft flush/turnItemStart 重置，只转队列+推气泡+发 RPC，分割完全交给 `steer_consumed`；②`requeueSteerMsg`/`dropQueueMsg` 删掉失效的越界校准(修复①后 turnItemStart 恒在本轮起点、气泡之前，天然安全)；③`steer_consumed` 重构为先摘气泡→flush draft→封存→气泡落底转正，兜底气泡真正入列，并加 `steerDone` 标记防 RPC 重复推送帧重复补画。回归:Bun+DOM stub 直接驱动真实 core.js 状态机四场景重放(用户路径/正常 steer 注入/重复消费帧/伪 item 放回)全绿。

**遗留假象的二次深挖与最终根因**(用户复测「仍截断+消费瞬间卡死」后定位):插桩证实底座从未卡死——run 内 turn B 秒级跑完；真正的元凶在 host 翻译层 `translateEvent`:它只把 `agent_start`/`agent_end` 映射为 UI 的 turn 边界，**run 内每个真实 `turn_start`/`turn_end` 全部吞掉**。排队消息消费的续轮发生在同一 run 内 → UI 完全看不见轮次边界 → steer_consumed 之后状态机等不到 turn_start(B)/turn_end(B)，working 行空转=「卡死」观感，气泡/封存全部错乱。底座 `#prepareQueuedUserMessages` 预处理实测 <1ms 完成，排除。

**最终修复**(对齐 ZCode 协议设计——turn 边界是服务端权威投影，turnHeader 行显式下发，「不得由 UI 重猜」):①translate.ts 转发真实 `turn_start`/`turn_end`(每模型轮各一帧，turn_end 带本轮 usage)，`agent_end` 映射的收尾帧标 `runEnd:true`(整 run 用量+entryId 回填载体)，移除 agent_start 的 turn_start 映射；②UI turn_end 处理按 runEnd 分级——轮内帧只封存过程，runEnd 帧才做 entryId 回填/列表刷新/系统通知；③`steer_consumed` 气泡查找穿透 loop 组(turn_end 可能先到、把气泡封进组里)，组内摘除后空组一并移除。回归:状态机三场景 9 断言全绿 + freeze 复现端到端 9s 完成(此前 200s 超时)+ queue-smoke/smoke-sendnow 通过(smoke-sendnow 按 runEnd 过滤收尾帧、注入轮以首次 steer_consumed 定位——send_now 会 abort 原轮，其空尾轮也完成于点击之后)。

**教训**:①「分割」这类时序语义只能有一个权威时机(消费时刻)，预览态(点击)做持久化结构变更必然在取消路径(requeue/drop)上漏；②事件语义以实测帧为准，不能按直觉推(steer_consumed 先于 turn_end、单 run 多轮是常态)；③协议层的「近似映射」(agent_start≈turn 开始)在复合场景(单 run 多轮)下必然失真——轮边界必须逐帧权威下发，这是 ZCode turnHeader 设计的由来。
