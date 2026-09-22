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
| BUG-007 | 长流式会话把应用卡死——esbuild 未设 NODE_ENV,React 开发版打进生产包 | 2026-09-22 |
| BUG-008 | Profile 菜单缺 default 选项——宿主冷启动 >15s,UI 连接失败后永不重试 | 2026-09-22 |
| BUG-010 | 「立即发送」点击瞬间即分割处理过程 + 放回队列后新过程裸奔不可收缩 | 2026-09-20 |
| BUG-011 | 前端一断开连接宿主进程即崩——ACP 提交误删 pty import 整行 | 2026-09-22 |

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

### BUG-010: 「立即发送」点击瞬间即分割处理过程 + 放回队列后新过程裸奔不可收缩（UI 层三缺陷，底座一层遗留）

**现象**:①点排队消息的「立即发送」，历史过程立刻被缩起分割，但当时 steer 消息尚未被消费；②随即点「放回队列」，消费后处理过程变两段：分割点前的历史正常缩起，之后新流入的过程原样展开且不进 loop 组（无收缩）；③被放回的消息偶尔从消息流消失。

**根因**(UI 三层叠加，实测帧序复现):①设计违背——`sendNowQueueMsg` 在点击瞬间 `sealRunItems` 预封存并重置 `turnItemStart`，而既定设计是「仅消费时才分割」(`steer_consumed` 处理器本就实现了完整的消费时尾段封存，点击预封存多余且有害)；②点击与放回之间流式推入的过程行落在封存点之前，requeue/drop 的校准逻辑只判 `turnItemStart > items.length` 越界、管不到「点后插入」，这些行永远进不了 loop 组；③`steer_consumed` 找不到气泡时建的兜底气泡只 new 对象从没插进 `s.items` → 消息消失。实测帧序关键事实:`steer_consumed` 先于 `turn_end` 到达。

**修复**(ui/core.js):①`sendNowQueueMsg` 删掉点击时封存/draft flush/turnItemStart 重置，只转队列+推气泡+发 RPC，分割完全交给 `steer_consumed`；②`requeueSteerMsg`/`dropQueueMsg` 删掉失效的越界校准(修复①后 turnItemStart 恒在本轮起点、气泡之前，天然安全)；③`steer_consumed` 重构为先摘气泡→flush draft→封存→气泡落底转正，兜底气泡真正入列，并加 `steerDone` 标记防 RPC 重复推送帧重复补画。回归:Bun+DOM stub 直接驱动真实 core.js 状态机四场景重放(用户路径/正常 steer 注入/重复消费帧/伪 item 放回)全绿。

**遗留假象的二次深挖与最终根因**(用户复测「仍截断+消费瞬间卡死」后定位):插桩证实底座从未卡死——run 内 turn B 秒级跑完；真正的元凶在 host 翻译层 `translateEvent`:它只把 `agent_start`/`agent_end` 映射为 UI 的 turn 边界，**run 内每个真实 `turn_start`/`turn_end` 全部吞掉**。排队消息消费的续轮发生在同一 run 内 → UI 完全看不见轮次边界 → steer_consumed 之后状态机等不到 turn_start(B)/turn_end(B)，working 行空转=「卡死」观感，气泡/封存全部错乱。底座 `#prepareQueuedUserMessages` 预处理实测 <1ms 完成，排除。

**最终修复**(对齐 ZCode 协议设计——turn 边界是服务端权威投影，turnHeader 行显式下发，「不得由 UI 重猜」):①translate.ts 转发真实 `turn_start`/`turn_end`(每模型轮各一帧，turn_end 带本轮 usage)，`agent_end` 映射的收尾帧标 `runEnd:true`(整 run 用量+entryId 回填载体)，移除 agent_start 的 turn_start 映射；②UI turn_end 处理按 runEnd 分级——轮内帧只封存过程，runEnd 帧才做 entryId 回填/列表刷新/系统通知；③`steer_consumed` 气泡查找穿透 loop 组(turn_end 可能先到、把气泡封进组里)，组内摘除后空组一并移除。回归:状态机三场景 9 断言全绿 + freeze 复现端到端 9s 完成(此前 200s 超时)+ queue-smoke/smoke-sendnow 通过(smoke-sendnow 按 runEnd 过滤收尾帧、注入轮以首次 steer_consumed 定位——send_now 会 abort 原轮，其空尾轮也完成于点击之后)。

**教训**:①「分割」这类时序语义只能有一个权威时机(消费时刻)，预览态(点击)做持久化结构变更必然在取消路径(requeue/drop)上漏；②事件语义以实测帧为准，不能按直觉推(steer_consumed 先于 turn_end、单 run 多轮是常态)；③协议层的「近似映射」(agent_start≈turn 开始)在复合场景(单 run 多轮)下必然失真——轮边界必须逐帧权威下发，这是 ZCode turnHeader 设计的由来。

### BUG-007: 长流式会话把应用卡死——esbuild 未设 NODE_ENV,React 开发版打进生产包

**现象**:会话跑一段时间后应用假死:点击无响应,仅会话列表 spinner 与滚动条仍可动(合成线程动画)。宿主进程与 WS 连接均正常(直连探测 RPC 秒回)。

**诊断**:`sample` 抓 WebContent 进程:JS 主线程 100% 卡在微任务内连环正则。Chromium 复现页注入 RegExp 计数心跳(经独立 WebSocket 上报,冻结后读最后一份):每 300ms `^(aria)-…`/`^on.` 正则执行 5.5 万次——是 react-dom 开发版的属性名校验(possibleStandardNames)。`ui:build`(esbuild)未 `--define:process.env.NODE_ENV=production`,bundle 2.1MB 含 `scheduler.development.js`;流式 delta 每 100ms 全树重渲染 × dev 版每属性设置都跑校验正则 → 主线程烧穿。

**修复**:①`package.json` ui:build 加 `--define:process.env.NODE_ENV='\"production\"'` + `--minify`(bundle 2.1MB→870KB,零 development);②顺带 `AssistantMsg` 加 `React.memo` + `useMemo([text])`(历史消息跳过 markdown 重解析,流式渲染的正确防御,单靠它挡不住 dev build);③子代理 text_delta 并入 100ms 合并渲染。

**教训**:React 应用进打包链,构建脚本必须显式钉死 NODE_ENV=production——esbuild 不像 CRA/Vite 自带。诊断手法:CSS 动画仍在转 ≠ JS 活着(合成线程);「注入计数器 + 旁路上报,冻结后读末份」可在不可调试环境里定位热点。**注意**:headless 浏览器复现环境的「标签页挂起」会假死(tab worker 被回收,渲染进程 CPU≈0%),勿当真——只信 `sample`/CPU 实证。

### BUG-008: Profile 菜单缺 default 选项——宿主冷启动 >15s,UI 连接失败后永不重试

**现象**:打包应用设置页 Profile 下拉只有当前一项(如 omp-desktop),看不到 default;重启应用时好时坏。宿主侧数据始终正常(直连 ready 帧 availableProfiles 三项齐全)。

**根因**:两级叠加。①宿主冷启动慢:applyProfile 里 `modelRegistry.refresh()` 走代理网络,READY 可晚于 15s;②`lib.rs ws_url` 只轮询 15s,超时即 Err;③前端 `connect()` 对 ws_url 失败/WS 断线**一次性放弃,永不重试** → `S.hostSettings` 为 null → GeneralPage 走 fallback `[activeProfile]` 渲染单选项。网络快时 15s 内就绪故「时好时坏」。

**修复**:①`lib.rs` ws_url 轮询 15s→60s;②store.js `connect()` ws_url 失败 3s 重试、onclose 3s 自动重连。

**教训**:**残缺的 fallback 是静默撒谎**——`profiles: [activeProfile]` 把「没数据」伪装成「只有这一个选项」,用户看到的是假清单。可选列表数据缺失时应显式禁用/提示,而不是拿当前值充数;任何「启动竞态窗口」类 bug 必须配重试闭环,一次性失败 = 把瞬态固化成永久错误。以后:凡 UI 有「等待宿主」依赖,connect 必须幂等可重入——此项为验收红线。

**BUG-007 补充(第二轮,同日晚)**:装 NODE_ENV 修复后用户复测仍卡死,且 spinner 也停转(WebContent 进程级饥饿)。再采样:递归 JIT 帧(React fiber 递归 render)+ 正则风暴 + GC allocateSlowCase。Chromium 从未真复现(V8 有回溯限制;headless 标签挂起是假冻结,渲染进程 CPU≈0 即可识别)——**该 bug 是 WKWebView/JSC 特有放大**。最终热点:`ui/icons.js icon()` 每次调用跑 `width="\d+" height="\d+"` 替换正则,每个 Icon 组件每帧都调——全树重渲染 × 数千组件 × 正则 + fiber 分配 GC 风暴。补修:icon 同名+同尺寸变体缓存(查表零正则);曾试给 ToolRow/ThinkingRow/UserMsg/ApprovalCard 加 React.memo,因组件内 13 处就地改 `item.expanded/cmdExpanded` 等交互态会吞掉展开交互,已回退——依赖「生产 React + icon 缓存 + AssistantMsg memo」三层。验收红线:UI 打包产物 grep 不得含 `development`(React 生产链);图标变体必须缓存。

### BUG-009: 工具循环被拆成每轮一行「已工作 x 秒」——封存时机绑在轮帧而非 run 帧

**现象**:多轮工具循环的回复实时展开成 N 行独立的 loop 组摘要(N=模型轮数),时长/usage 都是单轮口径;重开会话又合并回 1 行——同份数据两种呈现。

**根因**:BUG-007 修复(commit 464131d)让 host 逐帧转发真实 `turn_start`/`turn_end`(每个模型轮一对,排队消费可见性依赖它),但 UI 的 `sealRunItems()` 仍无条件挂在每个 `turn_end` 上——每轮各封一组;`turn_start` 每轮重置 `turnStartAt`/`turnItemStart`,时长从不是累计。重载路径 `entriesToTranscript` 一直按整 run 分组,故重开即"回弹"。

**修复**(ui-src/store.js):①`turn_start` 仅在 `turnItemStart == null`(run 首轮)初始化计时与起点;②轮内 `turn_end`(runEnd:false)只收尾草稿提前返回,不封存不停表;③封存移入 `runEnd` 帧分支,usage 用其整 run 累计、时长取 run 起始。steer 消费预封存路径不变(消费时刻仍即时封存)。验证:3 次工具调用的 run,实时 1 组(5s/22.8K),重载 `entriesToTranscript` 输出同构 1 组。

**教训**:协议语义从「run 级近似」改成「逐帧权威」时,所有依赖旧粒度的消费端(封存/计时/usage 口径)必须逐个对齐新粒度——半改(只加 runEnd 标记不挪封存点)等于没改。另:主页侧栏左下角 profile 名硬编码 omp-desktop 一并修复(绑定 `S.hostSettings.activeProfile`,与设置页同源)。

**BUG-007 补充(第三轮)**:prod React + icon 缓存后仍卡(时间变长=曲线被压低但斜率仍在)。sample 同签名(React 递归 + RegExpTestString 风暴),排除 LightweightDiff(有 useMemo,收起态不解析)与 thinking(纯文本)后锁定:**流式尾巴对不断增长的 draft 全文每 100ms 重跑 markdown 管线——每行 ~6 个 test + renderInline 的 exec,O(n²) 累积,回复越长每帧越贵**。修复:流式态改纯文本渲染(`.stream-plain`,pre-wrap),turn_end 定稿 push 为历史条目后才由 AssistantMsg 做一次 markdown 解析(memo 下仅此一次)。教训:**任何"对增长中的全文做全量变换"的流式渲染都是 O(n²)**——流式期间只许增量/纯文本,富文本变换留给定稿时刻;这是流式 UI 的硬性设计约束,违者必卡。
### BUG-011: 前端一断开连接宿主进程即崩——ACP 提交误删 pty import 整行

**现象**:WebSocket 客户端断开后，宿主进程抛 `Uncaught Exception: ReferenceError: disposeTerminalsOf is not defined`（`host/host.ts` 的 `close` 处理器）并直接退出（exit=1）。用户侧表现为：刷新前端 / 关窗 / 网络抖动后整个会话池消失，重连拿到空池。启动与 `READY` 一切正常——只有断开路径触发，故常规冒烟看不见。

**根因**:`6fd7c72`（feat: ACP 压缩执行引擎）插入 `acp-state.ts` / `acp-context.ts` 两条 import 时，把相邻的 `import { createTerminal, disposeTerminalsOf, terminalFor } from "./pty.ts";` **整行替换**掉了（该行由 `35e3f00` 引入，main 上健在）。三个符号在 host.ts 内仍被引用（终端 RPC 三处 + close 一处），而本仓无 tsc/eslint 门禁，编译期无人代查 → 只在运行期暴露：终端 RPC 报错、`close` 处理器直接把进程带崩。

**修复**:恢复该 import 行（`host/host.ts` 导入区，紧随 acp 三条之后）。验证：隔离配置根启动宿主 → WS 连接 → `get_settings` → 主动断开 → 进程存活（exit=0）；修复前同流程稳定复现 exit=1。

**教训**:①编辑 import 区块时禁止整行替换相邻既有 import——新增一律插入；②删除/替换任何 import 名后必须 grep 该符号在本文件的使用点；③本仓无 lint 链，「启动即 READY」覆盖不到 close 路径，host 改动后必须单独跑一次「连接 → 断开」存活检查。已立 RULE-004。

**同源误删（已一并修复）**:同一提交还把 `createAgentSession({...})` 的 `sessionManager,` 传参吞掉（main 上有）。取证（隔离配置根，单元级对比）：**传参**时 `session.sessionFile === manager.getSessionFile()`（同源）；**不传**时 host 的 manager 指向 `…11b4-7284….jsonl`、SDK 实际写入 `…11b7-7462….jsonl`——两个不同文件，`entry.manager` 沦为孤儿。用户可见后果［推理，需真实对话历史才能端到端复现，隔离环境无凭证］：`rename_session` 写到孤儿文件；`compact_session`/`branch_session` 用 `entry.manager.getEntries()` 重建 transcript，孤儿 manager 读空 → 消息清空。已恢复该行，`scripts/smoke-features.ts` 全绿（含 rename 标题落盘生效、池外 rename、compact 结构合法）。
