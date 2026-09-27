# 已知 Bug 与历史教训

> **结构**:开局「问题总览」表(BUG-NNN 编号 / 标题 / 日期),下为逐条详情(现象/根因/修复/教训);新条目追加到详情末尾,编号顺延,并在总览表同步加一行。
> **分诊六分类**:记账前先对报告的问题分诊,分类落定才动手——①确认回归(曾经正常,新改动引入);②确认存量缺陷(一直如此,与本次改动无关);③已修复(主线当前代码已无此问题);④预期行为(按设计本该如此);⑤环境特定(特定环境才复现);⑥证据不足(无法复现/定位,记录已查项后挂起)。纪律:**先验证后实现,不许先实现再调查**。
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
| BUG-012 | 代码块染色显示成另一个代码块的原文——染色缓存键只取首尾 100 字符 | 2026-09-22 |
| BUG-013 | 同一会话文件被两个 AgentSession 同时持有——load_session 不查会话池 | 2026-09-22 |
| BUG-014 | 折叠左侧边栏整界面白屏——Sidebar 的 useRef 落在折叠早退之后 | 2026-09-23 |
| BUG-015 | customTools 全部不可用——runner.initialize 传空 actions 让 ctx.model 抛 TypeError | 2026-09-23 |
| BUG-016 | /goal 模式运行中整窗口黑屏——读取行展开态早于内容到达，dc.text 炸渲染 | 2026-09-23 |
| BUG-017 | 快速上滚消息流跳动/闪烁——content-visibility 首轮 120px 估算纠偏落在视口 | 2026-09-23 |
| BUG-018 | 下拉列表键盘上下箭头切换选择时不自动滚动——仅改 index 未联动 scrollIntoView | 2026-09-26 |
| BUG-019 | 主对话区收纳父标签展开后子标签点击弹窗失效——patchGroupSub 找错对象且展开 WeakMap 引用丢失 | 2026-09-26 |
| BUG-020 | 点击几百行读取记录展开延迟 1-2S 无反馈——微任务执行高亮 tokenize 阻塞首帧绘制 | 2026-09-26 |
| BUG-021 | 终端复合标签内子命令未做超长截断——chg-body 未 stretch 且 chg-item flex-wrap 导致溢出 | 2026-09-26 |
| BUG-022 | 标签弹窗卡片滚到底带动外层消息流滚动——ldiff 漏 contain 且 WKWebView 边界 wheel 渗透 | 2026-09-26 |
| BUG-023 | 设置页面大量移植配置项下拉框点击无反应——层级遮挡、数字类型拦截与缺失枚举 | 2026-09-26 |
| BUG-024 | 会话永不自动起标题——SDK 宿主未调用底座标题生成入口 | 2026-09-26 |
| BUG-025 | 扩展页关掉来源后技能/MCP 页仍列出该来源资产——宿主自建目录扫描不查来源开关 | 2026-09-26 |
| BUG-026 | 整份 ui/style.css 中文注释双重编码乱码——UTF-8 字节被按中文 ANSI/CP936 解码后回写 | 2026-09-27 |
| BUG-027 | 读取「部分内容」时文件图标退化为通用图标——选择器后缀只剥了 `:N` 一种形态 | 2026-09-27 |
| BUG-028 | Windows 安装版每 10s 泄漏一个 ~250MB 宿主进程——编译产物不分发 SDK 的 `__omp_worker_*` 协议 | 2026-09-27 |

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

### BUG-012: 代码块染色显示成另一个代码块的原文——染色缓存键只取首尾 100 字符

**现象**:`ui-src/lib/highlighter.js` 的染色结果缓存以「主题 + 语言 + 长度 + 首尾各 100 字符」为键。中段不同、长度与首尾相同的两个代码块命中同一条目，而 `CodeTokens` 直接渲染 `token.content`——撞键位置显示的是**另一个代码块的原文**，不只是配色错。

**根因**:键刻意不含中段（沿用 ZCode 写法，注释称「避免整段 code 做键的内存翻倍」），两个前提都不成立：① 长度 + 首尾不足以标识内容；② 该写法没省下内存——缓存值本身存着全量 tokens（含逐 token 的 `content`），原文在内存里本就有一份完整副本。同一缓存还**无淘汰**，长会话里读过的每个文件/diff 永久留一份。

**修复**:键改为完整内容的双种子 FNV-1a 64 位哈希（单 32 位在数万个块下碰撞概率已到千分之几）；缓存改为按总字符数封顶（2M）的 LRU（Map 插入序，命中即 touch）。验证：构造长度/首尾相同、中段不同的两块，断言各自得到自己的内容（PASS）；塞入超上限内容后断言队首被淘汰、队尾仍在（PASS）。

**教训**:为省内存而弱化缓存键，必须先确认「缓存值是否已持有原文」——持有的话，弱化键只买到碰撞，没买到内存。

### BUG-013: 同一会话文件被两个 AgentSession 同时持有——load_session 不查会话池

**现象**:`handleLoadSession` 无条件 `SessionManager.open` + `createSessionCore`，不检查该 path 是否已在 `sessions` 池中。

**根因**:前端正常路径用 `openSessions.has(path)` 短路（已打开就直接激活、不发 `load_session`），掩盖了宿主侧缺失的幂等。前端一旦对**池内已有**的会话发 `load_session`（页面 reload 后点击、或前端会话 LRU 驱逐后切回），宿主即为同一文件新建第二个条目：旧条目连同它的 ws 订阅一起泄漏在池里，且两个 AgentSession 各自落盘同一文件（互相覆盖）。

**修复**:`handleLoadSession` 先扫池内同 path 条目，命中则复用——仅在 ws 变化时（前端 reload）`unsubscribe()` + `attachEntry` 重挂订阅（旧订阅发往已关闭的连接，事件会丢），随后重推 `session_created` / `messages` / context 快照。为此 `PoolEntry` 增 `attachedWs` 字段。验证：连发两次同一 path 的 `load_session`，断言 sessionId 不变、宿主日志出现「复用池内会话」且只新建一次、两次历史条数一致（均 PASS）。

**教训**:宿主会话池的键是 path，前端的「已打开」判断**不是**宿主的幂等保证——凡前端可触发的加载入口，宿主都要自己查重。

### BUG-014: 折叠左侧边栏整界面白屏——Sidebar 的 useRef 落在折叠早退之后

**现象**:折叠左侧边栏（顶栏按钮 / 原生菜单 toggle-sidebar / 新增的 ⌘B），整个界面白屏：React 抛 `#300 Rendered fewer hooks than expected`，根容器被卸载，`#root` 清空。

**根因**:`ui-src/components/Sidebar.jsx` 的 `const manageSnap = useRef(null)`（清理模式进入前的展开/条数快照）声明在 `if (collapsed) return <aside id="sidebar" className="collapsed">` **之后**——展开态渲染 9 个 hooks、折叠态 8 个，React 判定 hook 顺序被破坏并卸载整树。该早退分支此前没有任何入口（⌘B 只在设置页「键盘快捷键」登记过、从未绑定，原生菜单项也没人点过），所以问题一直静默存在。

**修复**:把 `manageSnap` 提到早退之前，与其他 ref 同处声明。验证：preview 页面（`?preview=1`）派发 `meta+b`，`#sidebar` 在 `collapsed` 与空 class 之间往返，`tab.errors()` 为空。

**教训**:组件里任何 `if (cond) return` 早退都必须位于**全部 hooks 之后**；折叠/空态早退是最容易埋 hook 顺序坑的位置，且只在状态第一次切换那一刻才炸。长期无入口的早退分支等于埋雷——新增快捷键/菜单项把它接上时才会引爆。已立 RULE-005。

### BUG-015: customTools 全部不可用——runner.initialize 传空 actions 让 ctx.model 抛 TypeError

**现象**:新增的内置工具 `read_session_context`（历史会话检索）在真实会话里调用必失败，模型转述工具错误 `getModel is not a function`（重试同样报错）；而直接调 `execute()` 的单元探针完全正常。历史日志里同一错误早已出现——`~/.omp/logs/omp.2026-09-20.95327.log` / `omp.2026-09-22.62934.log` 有 `Custom tool onSession error`（`tool: "tui"`）同样文本，当时未追。

**根因**:`host/host.ts` 的 `entry.session.extensionRunner?.initialize({}, {}, {}, uiCtx, "rpc")` 把第 1、2 参传成空对象。`ExtensionRunner.initialize` 对 contextActions 是**直接赋值**（runner.ts:695 `this.#getModel = contextActions.getModel`，没有 `??` 兜底），空对象 → `#getModel === undefined`；而 SDK 每次执行 customTool 都先经 `createCustomToolContext(ctx)`（sdk.ts:987）求值 `ctx.model` → `getModel()` → TypeError。后果：**整个 customTools 面在真实会话里不可用**（ACP 五件套同此，只是 `acp.enabled` 为 false 时未暴露），只有绕开 SDK 包装层直连 `execute()` 的探针看不出来。

**修复**:`initialize` 按官方契约补全 actions / contextActions（照 `modes/acp/acp-agent.ts:2563-2645` 映射到 `entry.session` 的既有 API：sendCustomMessage / appendCustomEntry / getEnabledToolNames / model / abort / getContextUsage …）；第 3 参从 `{}` 改为 `undefined`——空对象同样会把 `#waitForIdleFn` / `#newSessionHandler` 等赋成 undefined（runner.ts:704 是 `if (commandContextActions)` 守卫），只有 undefined 才保留 runner 的 no-op 默认。验证：真实宿主 + 真实模型（`scripts/probe-tool-ab.ts`）调用 `read_session_context` 返回 `# Session context matches`（修复前同一路径报 `getModel is not a function`）；`smoke-approval` / `smoke-features` / `smoke-newsession` 全绿（审批 gate 仍走 initialize 注入的 uiContext）。

**教训**:调用 SDK 这类「多参装配」入口（`initialize(actions, contextActions, commandContextActions, uiContext, mode)`）时禁止用空对象占位——SDK 内部多为直接赋值而非 `??` 兜底，空对象会把 handler 变成 undefined，把错误推迟到低频路径（工具调用 / 命令 / 生命周期事件）才炸。新增 customTool 必须走一次「真实模型调用」的端到端验证：`execute()` 单元探针覆盖不到 SDK 的包装层。

### BUG-016: /goal 模式运行中整窗口黑屏——读取行展开态早于内容到达，dc.text 炸渲染

**现象**:开启 /goal 模式跑一会（约在 goal 栏第一次刷新前后），整个应用窗口变黑，无报错、不可恢复，只能重启。

**根因**:`ui-src/components/chat/parts.jsx` 的 `ReadRow` 展开体无条件读内容：

```jsx
const open = item.readExpanded && !closing;          // 不看内容是否已到
const dc = item.details?.displayContent;             // 可能是 undefined
{open && <ReadBrief text={dc.text} … />}             // ← undefined is not an object (evaluating 'l.text')
```

`readExpanded` 有两条置位路径都先于内容：
1. 「工具运行中默认展开」(expandToolOutput) 在 `tool` 事件起始就置 true，而 `details` 要等 `tool_update` 帧才到——两帧之间只要发生一次渲染就炸；
2. 目录读取（`details.isDirectory`）永远没有 `displayContent`，展开态必炸。

React 无错误边界 → 渲染异常卸载根容器 → 深色主题下即「黑屏」（与 BUG-014 同症状类别）。与 goal 栏更新只是时间巧合（都在 turn 活动期）；是否命中取决于两帧之间有没有插入渲染，故 WKWebView 高负载流式下必现、Chromium 无头回放 300s 从未命中。

**修复**:
1. `parts.jsx ReadRow`——`open` 加 `&& !!dc` 守卫，`hasContent` 复用同一 `dc`。回归验证注入三种形状（目录+自动展开 / 文件+details 未达 / 正常可展开）：无错误页、目录行正常、正常展开不受影响。
   - 后续（2026-09-24）把「内容缺失」的两种语义显式化：`running`（tool 帧到 tool_update 之间）扩为**所有工具**置位，判定改为 `canOpen = !isDirectory && (!!dc || running)`，结果未到时展开体渲染转圈占位（`parts.jsx` 的 `Spin`），非 running 才回落「（无输出）」。工具行/编辑行/读取行/终端卡/内容卡/后台命令页/子代理工具行统一用该占位；轮收尾与宿主重启时由 `clearRunningTools` 复位 `running`，避免中断路径留下永久转圈。
2. 新增 `ui-src/components/ErrorBoundary.jsx`，`main.jsx` 以边界包裹 `<App/>`：渲染异常落地为可见错误页（错误信息 + 组件栈 + 「重新加载」），不再丢现场。本次根因正是靠错误页吐出的组件栈（`Ig`→`ReadRow`）在压缩产物里一步定位的。

**教训**:①「展开状态」与「展开体所需内容」是两件事，置位 expanded 的路径若早于内容到达，渲染判定必须把内容存在性一并纳入，否则是渲染时序炸弹；②「整窗口黑/白屏」在本栈 = React 根被卸载的确定性症状（BUG-014、BUG-016 两次），第一道防线永远是 ErrorBoundary——没有它，每次渲染崩溃都是一次不可诊断的现场丢失；③应用二进制嵌入 UI 资源（`frontendDist: ../ui`），前端改动必须重新 `tauri build` 才进得了已装应用，只 `bun run ui:build` 用户看不到。

### BUG-017: 快速上滚消息流跳动/闪烁——content-visibility 首轮 120px 估算纠偏落在视口

**现象**：长会话往上滚快了，消息流出现跳动和闪烁（无滚动输入的瞬间内容位移）；同一会话全部消息渲染过一次后再滚就正常。

**根因**：`ui/style.css` 曾给 `#stream > *` 加 `content-visibility: auto; contain-intrinsic-size: auto 120px`（5a1d447「渲染内存闸门」）。从未渲染的消息按 120px 估算占位，真实高度 38~5000px；快滚时一批刚进视口/邻近元素从估算态切到实测态，尺寸突变把视口内容整体推移——回路实测**无滚动输入帧锚点位移 81px**、scrollHeight 单帧纠偏 3.2 万 px。`auto` 只在渲染过一次后记住实测尺寸，故「全部加载完一次再滚就好了」；闪烁是同根的绘制侧表现（先空白后绘制）。

**回路**：`?preview=1` 注入 160 条高度差异消息 → 落底 → 5×(-1400px) wheel 风暴并发逐帧采样，判据「|ΔscrollTop|<0.5 且 |Δ锚点.top|>4px」。修复前稳定红（81px），修复后绿。

**修复**：删除该规则（原地留防回归注释）。A/B 实测规则无收益：cv=on 累计布局 26.7ms vs cv=off 10.3ms（反复 skipped↔relevant 切换反而多付布局账），DOM 节点数与 JS 堆无差（4865/4867、均 12.8MB）；656MB 闸门的实际功臣是同 commit 的染色缓存封顶与三处 LRU，均保留。更重的 shiki 会话未单独测［推理］。

**教训**：①不布局就不知道高度——「首轮跳过布局」与「滚动几何稳定」不可兼得，估算器只能减小误差不能消除，行高 38~5000px 列表的正解是虚拟化（docs/openbitfun-borrow-ui.md U4.3）；②性能闸门类改动必须带 A/B 基准入账，否则事后分不清哪颗药丸真正有效；③「无输入帧的锚点位移」是快滚跳帧的可靠判据，比肉眼录屏可断言。

### BUG-018: 下拉列表键盘上下箭头切换选择时不自动滚动——仅改 index 未联动 scrollIntoView

**现象**:侧栏会话搜索卡片（`SidebarSearch`）及各类带结果下拉列表，当条目数较多触发浮层纵向滚动（`max-height: 260px; overflow-y: auto;`）时，按键盘 `ArrowDown`/`ArrowUp` 键切换高亮项，光标高亮超出可视区域后浮层不跟随滚动，选中的项目被遮挡在可视区之外。

**根因**:组件在键盘事件响应中仅通过 `setSelectedIndex` 更新 React 内部选中索引（继而给 DOM 节点切换 `.on` 类名），没有联动容器滚动。浏览器原生的键盘焦点默认落在输入框（`<input>`）上，非聚焦的列表节点类名改变不会自动触发原生滚动视口调整。

**修复**:
1. 浮层滚动容器挂载 `listRef`；
2. 引入 `isKeyboardNavRef` 区分键盘切换与鼠标 hover；
3. `useEffect` 监听 `selectedIndex`，在键盘导航时获取激活项调用 `activeEl.scrollIntoView({ block: "nearest" })`；
4. 筛选列表重算时调用 `listRef.current?.scrollTo({ top: 0 })` 复位回顶端。

**教训**:凡支持键盘上下键切换高亮项的滚动交互容器，「修改选中索引」必须与「DOM 节点 `scrollIntoView({ block: "nearest" })`」成对实现，禁止只改索引丢掉视口对齐。已立 RULE-007。

### BUG-019: 主对话区收纳父标签展开后子标签点击弹窗失效——patchGroupSub 找错对象且展开 WeakMap 引用丢失

**现象**：主对话区域中由多个工具折叠合并的收纳父标签（如多文件查阅、多文件更改、多个终端命令等）展开后，内部各个子标签（如具体的单文件“查阅”行）点击展开/弹窗无响应。

**根因**：
1. `parts.tsx` 中的 `patchGroupSub` 原本假设底座 store 的 items 数组中存在带 `group` 字段的复合条目，通过 `it.role === "tool" && it.group.includes(sub)` 进行查找。但实际上查阅/更改/终端组仅是 `items.tsx` 在 `renderItems` 时动态组合的视图结构，底座 store 中的 `ChatItem` 都是平铺存储的，`it.group` 永远不存在，导致 `patchGroupSub` 找不到条目直接返回空对象，状态从未更新；
2. 组首条目不可变更新后引用变化导致 WeakMap 失效：子项展开状态存储在 WeakMap（`rdExpand` / `chgExpand` 等）中，当不可变更新产生新对象时，WeakMap 仍挂在旧对象上，导致后续重绘时展开状态丢失。

**修复**：
1. `groupExpand.ts`：将分散在 `EditRow.tsx`、`ToolRow.tsx` 等处的 `rdExpand`、`chgExpand`、`cmdExpand`、`devExpand` 统一收纳，并新增 `migrateGroupExpand(from, to)` 函数；
2. `parts.tsx`：重构 `patchGroupSub`，遍历 items 及 loop items 时直接比对 `it === sub`，在不可变拷贝替换条目时调用 `migrateGroupExpand(sub, next)` 同步迁移 WeakMap 状态；在 `patchActiveItem` 中同步挂接状态迁移。

**教训**：
1. UI 渲染期动态构造的虚拟组结构（Virtual/Derived Group）不能直接等同于 Store 持久化层的数据结构。在向下派发针对子项的更新器（Updater）时，必须明确更新的目标是在 Store 真实存在的条目引用还是 Derived 视图对象；
2. 基于 WeakMap 绑定对象引用记录组件展开状态时，任何不可变拷贝（`{ ...item }`）都会切断键值关联，必须配合引用迁移机制（Migration）或改用稳定的唯一 ID。

### BUG-020: 点击几百行读取记录展开延迟 1-2S 无反馈——微任务执行高亮 tokenize 阻塞首帧绘制

**现象**：点击包含数百行文本的阅读记录展开卡片时，界面卡顿 1-2 秒且没有任何视觉反馈（小箭头不转、弹窗不展开），随后突然弹出。

**根因**：
1. `highlighter.ts` 在 `getHighlighter().then(...)` 的 Promise 微任务（Microtask）中直接同步执行了 `h.codeToTokens(code)`。基于纯 JS 正则引擎处理 500+ 行代码耗时超过 1000ms；
2. 微任务队列在清空前，浏览器渲染管道无法执行 Layout 与 Paint。导致 React 虽然已提交首帧 DOM，但浏览器无法绘制展开入场动画和纯文本，界面被同步卡死 1-2 秒；
3. `ReadBrief` 之前缺乏行数上限截断保护，如果底座读取上千行文本，会无节制全部挂载 DOM 并送入高亮引擎。

**修复**：
1. `highlighter.ts`：将未命中缓存的 `codeToTokens` 调度至宏任务（`requestAnimationFrame` + `setTimeout`），确保首帧纯文本与展开动画优先渲染完成（0ms 响应），随后在后台异步计算语法上色；
2. `parts.tsx`：为 `ReadBrief` 添加 `MAX_READ_BRIEF_LINES = 500` 渲染保护，超出部分截断并提示点击文件名在右侧边栏查看完整文件。

**教训**：纯 CPU 密集计算（如分词/语法着色/正则引擎）绝不能在 Promise 微任务队列中同步运行，必须移至宏任务让出浏览器首帧渲染周期。

### BUG-021: 终端复合标签内子命令未做超长截断——chg-body 未 stretch 且 chg-item flex-wrap 导致溢出

**现象**：独立终端标签中的超长命令会在单行内截断并展示省略号，但在终端复合标签（连续终端命令合并组）内部，子命令超长时直接溢出撑爆容器，没有进行文本截断。

**根因**：
1. 父级 `.chg-body` 被设为 `align-items: flex-start`，子行宽度随内容伸缩（fit-content）；
2. 组内行 `.chg-item` 带有 `flex-wrap: wrap` 且缺少 `max-width: 100%` / `box-sizing: border-box`，导致其内部包含的长命令文本将行容器无限向右撑开，破坏了 flex item 的收缩与省略号截断机制。

**修复**：
1. `style.css`：将 `.chg-body` 修改为 `align-items: stretch; max-width: 100%; box-sizing: border-box;`；
2. `style.css`：将 `.chg-item` 修改为 `flex-wrap: nowrap; max-width: 100%; box-sizing: border-box; overflow: hidden; padding: 5px 15px 5px 0;`，并给内部图标与箭头置 `flex: none`；
3. `html[data-code-wrap="on"]` 补充支持 `.chg-item .c-tx` 换行。

**教训**：嵌套组内行的容器宽度必须受上层边界约束（`stretch` + `max-width: 100%`），文本超长截断必须依赖 `flex-wrap: nowrap` 与 `min-width: 0`。

### BUG-022: 标签弹窗卡片滚到底带动外层消息流滚动——ldiff 漏 contain 且 WKWebView 边界 wheel 渗透

**现象**：在主对话区各个标签弹窗（读取卡片、diff 卡片、终端卡片、思考卡片等）内部滚动时，当内容滚到最底端或最顶端后继续滚动，外层的会话消息页面（#stream）会被连带滚动。

**根因**：
1. `.ed-brief` 虽然声明了 `overscroll-behavior: contain`，但自身为 `overflow: hidden`，实际产生滚动的子容器 `.ldiff` / `.ed-brief > .ldiff` 未声明 `overscroll-behavior: contain`，导致滚动链向上传递；
2. macOS WebKit（Tauri WKWebView）内核对触控板动量惯性滚动与边界滚动存在特性：即使设置了 CSS contain，在元素已到顶/底或指针落在不可滚动间隙时，依然可能将 wheel 事件链式分发给祖先滚动容器。

**修复**：
1. `style.css`：在所有内嵌卡片及其实际滚动容器（`.ldiff`、`.ed-brief > .ldiff`、`.cmd-card`、`.think-body` 等）上全量补齐 `overscroll-behavior: contain;`；
2. `Chat.tsx`：在 `#stream` 消息流上挂载非 passive `wheel` 监听器，针对命中的标签弹窗（`.ed-brief`、`.cmd-card`、`.bash-out`、`.think-body`、`.chg-body`、`.approval-card`、`#todoList`）判定滚动边界：当内部不可滚、已到顶继续上滚或已到底继续下滚时，调用 `e.preventDefault()` 彻底截断向外层消息流的物理渗透。

**教训**：内嵌可滚动卡片不仅要在实际滚动子节点上设 `overscroll-behavior: contain`，还必须在祖先容器上配合 `wheel` 边界判定主动拦截，杜绝 WKWebView 触控板手势溢出。

### BUG-023: 设置页面大量移植配置项下拉框点击无反应——层级遮挡、数字类型拦截与缺失枚举

**现象**：设置中心中大量从 omp (oh-my-pi) 移植的设置项（如温度设置、压缩阈值、各类模式枚举等）下拉框点击没有任何反应，或者选择后无法生效。

**根因**：
1. **Portal 层级遮挡（无反应主因）**：Radix UI `SelectContent` 挂载在 `body` 根节点上，默认类名为 `z-[90]`，而 `#settings` 设置中心浮层为 `z-index: 115`，导致下拉弹框实际在设置窗口背后渲染，被完全遮挡；
2. **数字类型回写拦截**：`temperature`、`topP`、`tools.maxTimeout`、`compaction.thresholdPercent` 等在 omp 中为带预设选项的 number，前端 Select 选中的值默认为字符串，发送到 host 后被 `typeof value !== "number"` 拦截并报错；
3. **选项缺失与分派缺失**：原 `SchemaRows` 仅对 `type === "enum"` 派发下拉框，43 个带预选值的 number 设置项以及 `composer.shape` / `theme.dark` / `theme.light` 未走下拉选择，且 19 个枚举项在 `OPTS_ZH` 中完全缺失。

**修复**：
1. `ui-src/components/ui/select.tsx`：`SelectContent` 提升为 `z-[125]`（高于 `#settings` 的 115 与 `#toast` 的 120）；
2. `ui-src/components/settings/settings-zh.ts`：从 omp 底座提取并补齐 19 个枚举字典、8 个 composer 形态及 101 个主题列表；
3. `ui-src/components/settings/SchemaRows.tsx`：重构 `resolveSettingOptions` 与 `SchemaSel`，支持 number 及 runtime 选项下拉，回传自动转回 number，支持 `__empty__` 与 default 阈值映射；
4. `host/host.ts`：`set_setting` 针对 number 类型兼容数字字符串与 `"default"` 转换。

**教训**：全局 Portal 弹层的 z-index 必须与应用全局层叠上下文严格对齐；带选项的配置项需兼顾 UI 字符串交互与后端强类型契约。

### BUG-024: 会话永不自动起标题——SDK 宿主未调用底座标题生成入口

**现象**：desktop 里新建会话发完首条消息，标题始终是空的（侧栏/搜索兜底显示首条消息截断文本，重命名输入框为空）；CLI `omp` 同样操作会自动得到一个概括性标题。

**根因**：自动标题在底座里**不是自动行为**，而是由宿主显式调用 `AgentSession.maybeStartTitleGeneration(firstMessage)` 触发（CLI 侧调用点是 `modes/controllers/input-controller.ts` 与 `main.ts` 的 initial message 路径，均属宿主职责）。desktop 的 `host/host.ts` 走 SDK 宿主路径，全仓无一处调用该方法，底座内部的 gate 因此永不进入。链路其余环节本就齐备：`host.ts` 已订阅 `sessionManager.onSessionNameChanged` 并下发 `session_title_changed` 帧，前端 `store/ws.ts` 也已处理该帧——缺的只有唯一触发点。

**修复**：`host/host.ts` `handlePrompt()` 在 `session.prompt()` 之前补 `if (!steer) entry.session.maybeStartTitleGeneration(finalText);`。底座 gate 自身负责「已有标题 / 该会话已在生成中 / 本地扩展命令 / 低信号输入 / `PI_NO_TITLE`」跳过，标题落盘走 `setSessionName(title, "auto")`（用户已手动命名时自动标题被底座忽略）。流式注入（steer / 排队 followUp）不触发，与 CLI 只在 idle 提交时起标题一致。

**教训**：底座提供能力 ≠ 自动生效。以 SDK 内嵌方式复用 CLI 产品时，凡「CLI 宿主侧调用、底座只暴露入口」的职责（标题生成、进度提示、队列语义、UI 上下文注入）都要逐条对照 CLI 源码自查，否则表现为静默功能缺失——不报错、不崩溃，只是从来不发生。


### BUG-025: 扩展页关掉来源后技能/MCP 页仍列出该来源资产——宿主自建目录扫描不查来源开关

**现象**：在扩展中心把 Claude Code 来源关掉后，设置·技能页仍列出 `~/.claude/skills` 下的技能（`provider=claude`，界面显示 Claude 来源标签），MCP 页同样列出了已关来源的服务器；而 CLI/会话侧这些来源确实已不加载，页面与现实不一致。

**根因**：扩展页的「来源」开关写底座的 `disabledProviders`（`host/extensions.ts` `toggleExtensionProvider` → 底座 `capability/index.ts` `disableProvider`），底座 `filterProviders` 据此过滤 —— 这条链路对 `loadCapability` 是生效的。问题出在宿主自建扫描：`host/assets.ts` 的 `loadAllSkillsScoped()` 硬编码枚举外部目录（`~/.claude/skills`、`~/.codex/skills`、`~/.config/opencode/skills`、`~/.opencode/skills` 及项目级 `.claude/.codex/.opencode/.github/skills`），过滤条件只看项级的 `disabledExtensions` / `skills.ignoredSkills`，从不查来源状态；底座 `loadCapability` 在该函数里只作补充（`if (!profileItemsMap.has(name))`），命中的条目永远由硬编码扫描产出。此外这些补充调用传了 `includeDisabled: true`，等于 `ctx.includeOptOutUserSources`，把「外部工具 ~/ 配置」opt-in 一并绕过（实测关掉 claude 后仍能列出 `~/.claude/plugins` 的 20 条技能与 hindsight MCP）。

**修复**：`host/assets.ts` 新增来源判定 `isAssetSourceOn(provider, level)`，对齐底座 discovery 的加载条件（来源主开关 `isProviderEnabled` + 用户级 opt-in `isUserSourceEnabled` + claude/codex 技能级兼容开关 `skills.enableClaudeUser` / `enableCodexUser`；项目级只受主开关约束），技能 profile/project 两级目录扫描逐源过滤；技能与 MCP 的底座补充调用去掉 `includeDisabled: true`，与运行时加载行为一致。`host/bootstrap.ts` 补导出 `isProviderEnabled`。子智能体/钩子/记忆页只扫 omp 自有目录（`assetRoots`），本就没有外部来源，无需改动；扩展页仍由底座 `getAllProvidersInfo()` 驱动，关掉的来源行仍在（`enabled=false`），可随时点回。

**教训**：宿主一旦自建「枚举外部工具目录」的发现逻辑，就等于把底座 discovery 的来源/opt-in 判定复制了一份并悄悄丢掉；凡列出外部来源资产的页面，都应复用底座的来源判定（或直接吃 `loadCapability`），并且不要用 `includeDisabled` 让页面比运行时看到更多。回归防线：`scripts/probe-asset-sources.ts`（关来源/开来源/opt-in/单来源粒度四组断言，改前红、改后绿）。

### BUG-026: 整份 ui/style.css 中文注释双重编码乱码——UTF-8 字节被按中文 ANSI/CP936 解码后回写

**现象**：agent / 编辑器 / grep 读 `ui/style.css` 时中文全部是乱码，如 `/* 鈹€鈹€ 涓诲璇濆尯鍩熸秷鎭竷灞€涓庢皵娉?鈹€鈹€ */`（真值 `/* ── 主对话区域消息布局与气泡 ── */`——反推容易看成「氛围」，说明启发式反解不可信）。文件本身是合法 UTF-8（`file` 报 UTF-8），所以「换编码打开」修不好；受影响行 504 行，横跨全文件。

**根因**：`9b077bd` 提交把整份文件（524 增 / 505 删）经过了一条**按 Windows 中文 ANSI（CP936）解释字节的文本通道**：UTF-8 字节被当作 GBK 解码后再以 UTF-8 写回（`─` E2 94 80 → `鈹` + `€`(U+20AC←单字节 0x80)；`：` EF BC 9A → `锛`…）。偏离位由 .NET/PowerShell 类通道的 `?` 兜底产生，且**消费 2 字节**，连 ASCII 一起吃掉（`由 JS` → `鐢?JS`、`寮);` → `寮?;`），个别槽位映射到 PUA（U+E1F1）与西里尔/全角（`т`、`３`）。同一次提交还夹带了真实代码改动（`grid-template-columns: var(--setnav-w, 180px)`），所以父提交不能整文件取用。

**修复**：以「引入该次改动的提交 diff」为真值：`git show -U0 9b077bd -- ui/style.css` 逐 hunk 把 `-`/`+` 行按序配对，得到 494 组「干净↔乱码」精确映射（行数不等的 hunk 仅 1 个，是纯新增的干净行）；对当前文件逐行替换命中项（501 行），提交映射未覆盖的 3 行（其后被再次编辑过）按反解 + 上下文单独修复。校验：乱码标记行归零；`/* */` 全量剔除后与修复前仅剩 3 行差异（2 处 `content: "鈼?"` → `● ` 的字面量还原，1 处被映射误还原的代码行改回 `--setnav-w`）；`bun run ui:typecheck` + `bun run ui:build` 通过，`?preview=1` 实机渲染正常。

**教训**：非 UTF-8 通道回写源码，坏的不只注释（字符串字面量、乃至被连带替换的代码行都会变），且**不可逆**（`?` 处的字节已丢失）。可靠抓手是那次改动的 diff 行对，不是启发式反解——`emu(父版本行) == 当前行` 这种反推在本例中会漏 2/3 的行（PUA/西里尔/全角槽位与原工具映射不完全一致）。预防与门禁见 RULE-009。回归防线：`scripts/check-encoding.mjs`（非法 UTF-8 + 乱码特征字符 + 双重编码指纹；阈值经 67455 行干净语料校准，0 误报、对本例坏版本召回 493/507 行），已接入 `bun run check` 与 `.githooks/pre-commit`（`core.hooksPath=.githooks`，故意回放坏文件时 `git commit` 被拦截、HEAD 不变）。

### BUG-027: 读取「部分内容」时文件图标退化为通用图标——选择器后缀只剥了 `:N` 一种形态

**现象**：读取行显示 `读取 style.css:683:raw ui/`，左侧是通用文件图标（`ftFile`）而非 CSS 图标；点击该文件名请求右栏整文件时，`read_file` 带着 `:683:raw` 后缀（宿主必然 ENOENT）。

**根因**：`FileChip` / `splitPath` / `openReadFileInSidebar` 只剥离 `:\d+(?:-\d+)?$` 一种后缀（10163b3 的部分读取图标补丁），而底座 read 的选择器是**冒号分段、可多段串联**，每段为 `raw | conflicts | img | 行号段（可逗号多段）| -N`（底座 `Yni`/`Vni`/`p2t`）。`style.css:683:raw` 尾部是 `:raw`，正则不匹配 → 整段选择器留在路径里 → 扩展名被算成 `css:683:raw` → 落回 `ftFile`；右栏请求同样带着选择器。

**修复**：`ui-src/components/chat/util.ts` 新增 `stripReadSelector`（镜像底座语法 + URL scheme 保护，跳过 `https://` 的冒号）与 `readSelectorRange`（取选择器首个行范围供右栏行号高亮），`splitPath` 改走它；`FileChip`、`ReadRow`、`openReadFileInSidebar` 全部改用（后者顺带修好 `:N-K` 高亮与请求路径）。验证：一次性脚本断言 28 组选择器形态（`:683:raw`/`:2-4:raw`/`:5-16,960-973`/`:-60`/`:50+150`/`:50-`/`conflicts`/`:img`/URL/盘符路径）与 `style.css:683:raw → ftCss` 图标链路；`?preview=1` 注入四种选择器读取行，实机截图确认图标、文件名、目录三者均正确。

**教训**：前端展示层复刻底座路径语法时必须照抄底座正则——「只处理最常见的 `:N`」在 `:raw`/`:conflicts`/多段场景下静默退化为通用图标，不报错、不进组、只是图标错。本仓暂无 ui-src 单测基建，回归防线为一次性冒烟（无长期守卫）。

### BUG-028: Windows 安装版每 10s 泄漏一个 ~250MB 宿主进程——编译产物不分发 SDK 的 `__omp_worker_*` 协议

**现象**：Windows 安装版后台持续增长名为「Bun」的进程（任务管理器读的是 Bun 的版本资源，实为 omp-host.exe 副本）：主宿主每 10.0s 起一个 `omp-host.exe __omp_worker_daemon_broker`，每个 ~230-260MB、约 1.5s CPU 后永久闲置、从不退出，内存无限增长（实测 4 分钟 +20 个）；`__omp_worker_js_eval_process` 亦漏 2 个。dev 形态无此问题。

**根因**：SDK 在编译形态下把 worker 子进程 re-entry 到「当前可执行文件」——`subprocess/worker-client.ts` `resolveWorkerSpawnCmd()`：`if (isCompiledBinary()) return { cmd: [process.execPath, workerArg] }`。它假设该二进制像 omp CLI 一样在入口分发 `__omp_worker_*` 选择器（`cli.ts` `runWorkerEntrypoint()`），但桌面产物入口 `host/host.ts` 是完整桌面宿主：argv 被无视 → 每个 worker 被启动成一整个宿主（打印 READY、起 WS 服务、永不退出）→ daemon broker 命名管道永远不出现 → 客户端 `CONNECT_TIMEOUT_MS = 10s` 超时重试 → 每次重试再漏一个。dev 形态 `isCompiledBinary()` 为假，spawn 的是真 `cli.ts`，故无此问题。

**修复**：`host/host.ts` 改为薄入口（宿主主体原样移至 `host/main.ts`，git mv 保留历史）：argv 空 = 宿主（Tauri 壳 spawn 从不带参数），动态装载 `main.ts`；argv 非空 = 以 CLI 身份运行——`declareWorkerHostEntry()`（对齐 cli.ts 的 isProcessEntry 分支，使 worker 子进程可再 spawn worker 线程）后交 SDK `runCli(argv)` 分发（worker 选择器、`--smoke-test`、`--version` 等全部可用），`runCli` 返回即 `process.exit(0)`。分流必须在宿主静态图求值之前（ESM 静态 import 先于顶层代码），所以宿主主体动态装载、worker 路径只拉 CLI 轻入口（静态图不含 TUI 与 native addon）。`check-capabilities.mjs`/`check-host-boundaries.mjs` 扫描目标跟随改为 main.ts。验证：`scripts/smoke-worker-dispatch.ts`（编译产物三 broker：daemon 分发为真 broker + scope.json + 3s 空闲自退；blob/lsp socket 出现；均无宿主 READY 行）+ 编译产物 `--smoke-test` 的 sync/stats_activity worker 通过。

**教训**：以 `bun build --compile` 内嵌 SDK 的宿主二进制，就是 SDK 眼里的「CLI 编译产物」——SDK 的隐式协议（worker re-entry 到 `process.execPath`）必须由入口实现，否则每个子进程形态 worker（daemon/blob/lsp/js_eval/stats…）都漏成完整宿主。新增任何「宿主被 spawn 的形态」时，先对照 CLI 入口（cli.ts isProcessEntry 分支）核对协议责任。`--smoke-test` 与 `scripts/smoke-worker-dispatch.ts` 是此类回归的防线。
