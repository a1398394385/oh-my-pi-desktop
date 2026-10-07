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
| BUG-029 | 会话列表把旧会话显示成「刚刚」——`modified` 取文件 mtime，被 `session_exit` 诊断帧刷新 | 2026-10-01 |
| BUG-030 | 大面积拖选把两侧空档整片填蓝——WebKit 选区填充膨胀只认裁剪边界 | 2026-10-01 |
| BUG-031 | 输入法选字回车直接发消息——WebKit 上 compositionend 先于 Enter keydown 到达，Lexical 核心 isComposing 守卫失效 | 2026-10-01 |
| BUG-032 | 输入框按一下 Esc 焦点外流、必须鼠标点回来——RichTextPlugin 在 EDITOR 优先级绑了 editor.blur() | 2026-10-01 |
| BUG-033 | 会话树页进入停在最顶端、且条目只能鼠标操作——落底判据挂在挂载上 + 无键盘导航 | 2026-10-01 |
| BUG-034 | 供应商报错（配额/鉴权）不进消息区——失败原因只存在于 assistant 的 `errorMessage` 字段，翻译层无此分支 | 2026-10-01 |
| BUG-035 | 统计行整轮不刷新、压缩后 token 倒退——口径取成「活动窗口筛选」且只在 turn 收尾推送 | 2026-10-01 |
| BUG-036 | 升级底座 18.5.0 后 host:build 加载期即炸——build-host.ts 深依赖 pi-natives 内部模块，上游导出改名 | 2026-10-03 |
| BUG-037 | Windows 上 check-style-tokens 误报 shadcn 基件 9 处违规——vendor 目录排除被反斜杠路径击穿 | 2026-10-03 |
| BUG-038 | Windows 终端默认起 PowerShell 5.1 不跟随用户 pwsh 7——默认 shell 硬编码 powershell.exe，无探测 | 2026-10-03 |
| BUG-039 | 项目打开后终端起始目录落在用户主目录——无活跃会话时空 cwd 回落宿主 process.cwd()（GUI 启动目录） | 2026-10-03 |
| BUG-040 | 发消息后「工作中 Ns」紧贴气泡被渐隐吞掉——贴底目标把 sticky 底部占位的 36px 算进内容 | 2026-10-03 |
| BUG-041 | Windows 安装版使用统计永远「同步失败」——桌面宿主分支未声明 worker host，stats 解析 worker 回退编译产物虚拟路径不可加载 | 2026-10-04 |
| BUG-044 | 桌面版 computer use 全不可用——薄入口在 worker 线程 runCli 返回后无条件 process.exit(0)，worker 刚 ready 就被秒杀 | 2026-10-05 |
| BUG-047 | 安装版批准计划后收尾崩——readSdkPrompt 用 import.meta.resolve 运行时读 SDK 包，standalone exe 无 node_modules 可解析 | 2026-10-06 |
| BUG-048 | 批准卡无模型滑条且批准后静默切 default 模型、输入框仍显示旧模型——requestApproval 帧手挑字段漏 slider 等 4 个 + applyRoleModel 后不推 session_model | 2026-10-06 |
| BUG-049 | SSH 测试报错既看不懂又复制不了——Windows OpenSSH 八进制转义外泄 + toast 承担了不可抄的诊断 | 2026-10-06 |
| BUG-050 | 缓存保活自移植起从未布防过——嵌入式宿主只调 initialize 不发 session_start，扩展 config 恒为空靶标默认值 | 2026-10-07 |

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

### BUG-029: 会话列表把旧会话显示成「刚刚」——`modified` 取文件 mtime，被 `session_exit` 诊断帧刷新

**现象**：default profile 的 `01a0e6d3…` 会话点进去看着「最后一次回复 9-28 16:04」，左栏列表却显示「1 分」。磁盘上该文件 mtime = 当前时刻，transcript 尾部是三条 `session_exit`（最近一条 10-01 13:15）。

**根因**：列表时间来自底座 `SessionInfo.modified`，`session-listing.ts` 直接取 `stat.mtimeMs`。而底座会话 teardown 会往 transcript 追加一条 `session_exit` 诊断帧（`session/exit-diagnostics.ts`；正常 dispose、SIGINT/SIGHUP 都写），**打开过一次旧会话，mtime 就被刷成打开时刻**；UI 又拿它排序，于是旧会话被顶到列表最前。实测 default profile 276 个会话文件里 235 个 mtime 晚于最后一条 message；另有 41 个无 message 的新会话必须继续用 mtime 兜底。

**修复**：新增 `host/session-activity.ts` —— 读文件尾部窗口（16 KB 起，4 倍扩到 512 KB 上限）从后往前取最后一条 `type === "message"` 帧的 timestamp 作活动时间，无 message／读不到时回退 mtime；按 (size, mtime) 做上限 4096 的缓存，`peekFileTail` 走 `@oh-my-pi/pi-utils`。`host/rpc/session.ts` 的 `handleListSessions` 与 `get_session_tree` 在 `SessionManager.listAll()` 后调用 `applyActivityTimes()` 原地改写 `modified`（排序与显示自动跟随）；`scripts/check-host-boundaries.mjs` 登记 `rpc/session.ts→session-activity.ts`。验证：test profile 复制该会话 → 列表行 `2026-09-28T08:04:18.275Z`（= 本地 16:04:18，与详情一致），`utimes` 刷新 mtime 后重算仍不变（缓存失效路径）；276 个真实会话文件与全量逐行扫描交叉比对 0 mismatch、10 ms；`scripts/smoke.ts` 真宿主跑通 list 链路（后续 prompt 因测试 profile 无模型中止，与本次改动无关）。回归探针：`.local/probe-session-activity.ts`（端到端行时间 + touch 后不变）、`.local/probe-activity-parity.ts`（276 文件与 oracle 全量比对）。

**教训**：文件 mtime 不是活动时间——任何诊断/元数据写入都会污染它（标题原地重写、退出帧同理）。凡列表时间、排序、GC 依赖 mtime，先问「这次写入代表用户活动吗」。残留（未改，语义不同）：`host/stats.ts` 热力图与 `host/session-context.ts` 的 days 过滤仍吃 `modified`。

### BUG-030: 大面积拖选把两侧空档整片填蓝——WebKit 选区填充膨胀只认裁剪边界

**现象**：消息区大面积拖选时，选中高亮不止染文字，而是把整片区域填蓝到满窗口宽——两侧空档、段落间隙全部涂实；只有用户气泡正常（只染文字本身）。拖动调整左右边栏宽度时异常蓝区消失（`body.resizing` 临时禁选），只剩文字上的正常高亮。分诊：②确认存量缺陷（引擎行为，一直如此）。

**根因**：WebKit 的选中高亮是引擎自绘的间隙填充：选区跨越块级边界时，每行填充矩形沿祖先链向上膨胀到更宽的绘制上下文（实测一直膨胀到视口宽），`::selection` 只能改颜色改不了形状。上一轮（2026-09-30）给气泡/折叠条加的 `user-select:none` 只排除了命中与文本入选，**不控制填充几何**——气泡看着正常其实是因为文本在内联 span 里按行盒逐行绘制。变体矩阵实证（Playwright WebKit 2248，与 WKWebView 同 WebCore）：`user-select:none` 隔离、`width:fit-content`、`inline-block`、自绘背景四路全败；只有**裁剪边界**（`overflow:hidden/clip`）与 flex item 自绘能拦住膨胀。Chromium 按 text box 逐行填充无此问题，故 ZCodium/Electron 天然正常。

**修复**：两层裁剪 + 一处全宽化。① `.msg.assistant.md-body` / `.msg.assistant.stream-plain` 加 `overflow: clip`（main-chat.css:225,232）——选区**边缘**的消息盒自绘填充被裁回盒内（短消息贴文字、长消息贴内容列）；② `.turn-flow` 加 `overflow: clip`（main-chat.css:145）——选区**完全覆盖**的块不自绘、由祖先代画（探针实证：跨轮拖选时中间消息的 clip 失效、两侧照蓝），flow 的 clip 把代画条带（折叠行两侧、气泡↔正文细条）裁到列宽；③ `.turn-acts` 退出共享列宽规则、改全宽盒 + `padding-left` 补偿列左缘（main-chat.css:960）——祖先在「被跨越子盒两侧」补画间隙，子盒铺满全宽则间隙归零，分叉/复制条两侧的满宽细条消失。选 `clip` 而非 `hidden`：clip 不建 BFC，`.md-p` 的 8px margin 穿透塌陷不变、布局零影响。失败路线：`user-select:none` 隔离上移（s10/f6 变体）与 acts 挪进 flow（f2 变体，莫名毒化 flow 的 clip）均被像素探针否掉。验证：双轮完整 DOM 复刻页 + 13 点像素探针（`/tmp/wk-seltest/probe.mjs`，f1&g4 变体全绿）；`check-architecture`（960/960）/ `check-encoding` / `check-style-tokens` / `vite build` 全绿；真机视觉确认留用户一次拖选。

**教训**：WebKit 渲染行为只能靠真引擎变体矩阵定案，盒模型直觉推断（none 边界拦截）会错；`overflow: clip` 是「只要裁剪不要 BFC」的标准答案；「选区完全覆盖的块由祖先代画」决定了 clip 必须套在**文本所在的最近列宽容器**上，只套叶子盒不够。残留（有意不修）：长消息内部短行尾仍填到内容列右缘（列内填充），逐行贴字需 md-body 改 flex 列+子项 fit-content（margin 不再塌陷、要审计全部 markdown 子元素宽度）或自绘高亮层（百行 JS 子系统），代价均不成比例。同类待观察点：`.turn-acts` 内展开卡片（终端输出/diff）拖选仍会膨胀到视口宽，有投诉再套同款 `overflow: clip`。

**追加（2026-10-01，loop 汇总行精修）**：跨选 `.act.loop` 时上下 margin 被填成列宽蓝条（与所有块间带同源，但该行被点名要求像气泡只染文字）。补遗机理：父级间隙填充**只跳过子盒（border-box），裸 margin 必填**；遮盖路线全败——`box-shadow`/背景在父级选区相位之前绘制盖不住填充，`position:relative`、flow 去 BFC/去 clip、flex/grid 包裹均被变体实测否掉。唯一可行：**间距内化**——`.act.loop` 改 `margin:0; padding:20px 0`，相邻块相向 margin 归零（`.turn-flow > *:has(+ .act.loop)` / `.act.loop + *`），首子 loop 吸收 flow 的 `padding-top`（35px 保持原气泡→loop 间距）；sealed 细分隔线改背景线（`linear-gradient(var(--line-soft)…) bottom 20px / 100% 1px`，线下 20px 留白留在盒内）。顺手删死代码 `.msg.user + .act.loop { margin-top:70px }`（气泡恒在 sticky wrap 内，永不相邻，且与新 margin:0 冲突）。验证：vite preview + Playwright WebKit 真实拖拽像素扫描——loop 盒内仅文字线染蓝、上下 padding 区全黑，残留仅下一条消息自身 8px 段距带（与消息间填充一致）；门禁 960/960 全绿。

### BUG-031: 输入法选字的回车直接发消息——WebKit 上 compositionend 先于 Enter keydown 到达，Lexical 核心 isComposing 守卫失效

**现象**：中文输入法（拼音/注音）打字，候选窗开着按回车选字，消息被立即发出（`prompt` 帧已发、输入框清空），选字后本要接着输入的半句直接进了对话。分诊：②确认存量缺陷（textarea 时代有 `e.nativeEvent.isComposing` 显式守卫，P7 迁 Lexical 时误以为「核心层已守」而丢）。

**根因**：两处叠加。(1) 平台事件顺序：WebKit（= Tauri macOS 的 WKWebView）确认候选时先派发 `compositionend`、再派发这次 Enter 的 `keydown`（WebKit bug 165004；Stum 2016 记录「Safari 会补发 which=229 的 keydown」同源），到达 keydown 处理器时事件上 `isComposing` 已是 false。(2) Lexical 核心的守卫只覆盖「组合进行中」：`onKeyDown` 里 `if (editor.isComposing()) return`（`LexicalEvents.ts:1611`），而 composition 收尾在 `$handleCompositionEnd` 里就把 `_compositionKey` 置空。插件层 `KEY_ENTER_COMMAND` 处理里只判 `ev === null`（那是组合文本以 `\n` 收尾的派发），对 `isComposing === false` 的确认回车没有任何拦截——于是 `sendPrompt()` 被调用。旧 textarea 实现的 `!e.nativeEvent.isComposing`（commit c970d17^）正是补这个缺口，迁移时按注释「isComposing 守卫在核心层」删掉了。

**修复**：`ui-src/components/composer/lexical/ComposerPlugin.tsx` 记 `imeCommitAtRef`（最近一次 `compositionend` 的 `event.timeStamp`，0 = 无），经 `editor.registerRootListener` 在挂载后的 root 元素挂 `compositionstart`/`compositionend` 原生监听（root 元素由 ContentEditable 回调 `setRootElement` 挂载，晚于插件挂载，故只能走 root listener；不与 Lexical 自己的重入守卫冲突）。`KEY_ENTER_COMMAND` 处理里：回车落在 `IME_COMMIT_ENTER_WINDOW_MS`（100ms）窗口内 = IME 确认选字，吞掉不发送并清零（**只吞一次**，确认后下一次真回车照常发送）；窗口取小值是因为 WebKit 上两个事件几乎同一 tick，同时防「鼠标点候选收尾后紧接着按的真回车」被误吞。非 Apple 平台顺序相反，`imeCommitAt` 恒 0，本分支不生效。窗口判定用 `ev.timeStamp`（同源高精度时钟，不受 IME 长按导致 `Date.now()` 漂移影响）。验证：`vite dev` + `?preview=1` 真实 contentEditable 上按 WebKit 顺序注入事件，五项回归矩阵全绿——纯回车发 `prompt`；`compositionend` 紧跟回车不发送且草稿保留；250ms 后的真回车照常发送；组合进行中回车不发送（core 守卫）；窗口外 Ctrl+↵ steer 照常。CDP 真实按键复核（`page.keyboard` 真键、非合成事件，插桩收 `prompt` 帧 + `window.onerror`）：纯回车发 / IME 确认回车不发且草稿保留 / 400ms 后回车照发 / ⇧↵ 不发且草稿留 / 窗口外 Ctrl+↵ steer 发，全程 0 错误。同一探针在 `git stash` 掉本改动后复现 `prompt:zhong wen` 发出（红→绿）。`bun run check`（含 tsc）、`bun run ui:build`、`bun run smoke:react` 全绿。真机 Tauri 窗口手测留用户确认。

**教训**：「库核心有守卫」不等于「你的场景被守住」——核心守卫的判据（组合进行中）与真实平台事件顺序（先 compositionend 后 keydown）之间的缝，只有实测事件流才暴露。IME 场景的判据必须是「刚才是否发生过 composition 收尾」这类时间关系，不是事件自身的 `isComposing` 快照。ProseMirror 0c54477 是同源对策（记 `compositionEndedAt` + 时间戳窗口），照抄即可，不要自造。残留：WKWebView 上部分第三方输入法（如 Rime/搜狗的部分模式）干脆不派发 composition 事件，那时连 `compositionend` 都没有、时间戳窗口也无从谈起——那属于输入法不送组合事件，无解（VSCode/xterm 同样受影响，xterm 的规避是自定义 key handler 拦 229）。

### BUG-032: 输入框按一下 Esc 焦点外流、必须鼠标点回来——RichTextPlugin 在 EDITOR 优先级绑了 editor.blur()

**现象**：输入框里正打字，按一次 Esc 焦点就没了（`activeElement` 变 body），想接着打字必须用鼠标点回输入框。分诊：②确认存量缺陷（textarea 时代 Esc 只走全局路由、焦点不动，P7 迁 Lexical 时引入）。

**根因**：`@lexical/rich-text` 的 `registerRichText` 在 `KEY_ESCAPE_COMMAND` 上绑了 `editor.blur()`（`src/index.ts:1843-1853`，`COMMAND_PRIORITY_EDITOR` = 0）。Lexical 的命令分派按优先级从高到低跑（`triggerCommandListeners` 的 `for (i = 4; i >= 0; i--)`），插件层此前没有任何 `KEY_ESCAPE_COMMAND` 注册，于是 Esc 一路落到 core 最低优先级 → `editor.blur()` → `rootElement.blur()` + `domSelection.removeAllRanges()`，焦点彻底外流。而本应用的 Esc 语义全在全局路由 `keys.ts` 的 `handleEsc`（双击清空 / 双击唤起树 / 中止生成），它挂在 `document` 上、不依赖输入框焦点，于是「焦点外流」纯属副作用、没有任何功能收益。textarea 时代没有 core 这层默认 blur，所以迁移后行为回退。

**修复**：`ui-src/components/composer/lexical/ComposerPlugin.tsx` 注册 `KEY_ESCAPE_COMMAND` 于 `COMMAND_PRIORITY_NORMAL`（2 > 0，抢在 core 的 blur 之前），处理体 `() => !typeaheadOpenRef.current`——面板（斜杠/@ 补全）开着时返回 false 让路给 `LexicalMenu` 的 Esc 处理器（它在 LOW 优先级关面板），其余时候返回 true 吞掉。**不调 `ev.preventDefault()`**：keydown 继续冒泡到 `document` 的全局路由，Esc 的清空/中止/唤树语义一行不改。验证：`vite dev` + `?preview=1`，CDP 真实按键，`window.onerror` 全程 0 错误——(1) 有草稿按一次 Esc：`activeElement` 仍为 `input`、草稿保留、发送钮转取消态（`escArmedUntil` 置位），紧接着继续打字成功落字；(2) `/help` 弹面板时按 Esc：面板收起、焦点仍在输入框；(3) tree 模式按一次 Esc 仍切回 chat；(4) 空闲时按一次 Esc 只武装 tree 不切模式；(5) 流式态按一次 Esc 仍发 `abort_session` 且焦点不外流。`bun run check`（含 tsc）、`bun run ui:build`、`bun run smoke:react` 全绿。真机手测留用户确认。

**教训**：库在最低优先级挂的命令（`COMMAND_PRIORITY_EDITOR`）不是「保底」而是「兜底行为」——编辑器默认会做些什么（blur / 插换行 / 应用格式），你的应用只要有一个语义与之冲突的全局键，就必须在更高优先级显式接管，否则迁移即回退。接管时优先「不 preventDefault、只让 keydown 继续冒泡」，全局语义一行不动，风险最低。附带发现（**未修，见下**）：本条与 BUG-031 同批排查时发现「有草稿双击 Esc 清空」在 `?preview=1` 下也不生效——`composerSetSignal` 被 Composer effect 消费（`setState({ composerSetSignal: null })`）、`lexRef.current.clear()` 不抛错，但 DOM 文本不变；同一 `clear()` 逻辑经页面内直接调 editor.update 可正常清空，存疑点在该 update 落在哪个 Lexical 实例/队列上，与本条 Esc 焦点无因果关系，且**改动前后同样复现**（`git stash` 对照确认存量）。

### BUG-033: 会话树页进入停在最顶端、且只能鼠标操作条目

**现象**：双击 Esc 进会话树页，滚动条永远在顶部（看到的是最老的条目而非最新历史）；条目没有任何键盘操作，想跳转必须先用鼠标点行左侧那个 hover 才显形的快捷跳转钮。分诊：②确认存量缺陷（树页自迁入中栏起就没有这两项）。本次按需求一并补齐落底 + ↑↓/↵ 键盘操作。

**修复**：三处。(1) `ui-src/components/chat/MainSessionTree.tsx` 加 `scrollRef` + `useLayoutEffect` 落底——判据是「树数据已到位且会话 id 变了」而非单纯的挂载，因为 `stale` 分支先渲染转圈占位、瀑布流要等 `entry_tree` 回包才挂上；用 layout effect 是为了在 paint 前落位，避免先渲染一帧顶部再跳底（与 `Chat.tsx` 消息流贴底同款做法）。(2) `ui-src/components/chat/SessionTreeStream.tsx` 加 `cursorId` 游标：游标只落在 `type: "node"` 项上（分叉药丸行跳过），`↑/↓` 按视觉顺序走一步、**到边界停住不回绕**（回绕会让一次误触直接跳到另一端），首次按键落在末项（与「进树看最新」同向）；游标移动后按需微调 `scrollTop` 把目标行带进视口，只动纵向、不用 `scrollIntoView`（它会连带滚动祖先容器、页面抖）。(3) `↵` = 打开既有跳转二次确认弹窗（`setConfirmNode`，与点行左侧快捷跳转钮同一条路），弹窗三个按钮 Jump / Jump & summarize / Cancel 原样复用。键盘监听挂 `window` 捕获阶段、**在 `confirmNode` 打开时整个 effect 直接不注册**，于是弹窗期间 ↑↓/↵ 全部让路、回车不会穿透二次触发跳转，Esc 仍由弹窗自己的捕获监听关闭。`keys.ts` 注册表补「会话树」组（↑↓ 移动游标 / ↵ 打开跳转确认）供设置页 `pg-keyboard` 展示，中英文案在 `ui-src/i18n/locales/ui/misc.{zh,en}.ts`。游标视觉：`ui/css/main-tree.css` 末尾加 `.is-cursor`（accent 描边 + 左侧 2px 竖条 + 导轨徽标描边），**刻意不给整行加 hover 高亮**——按全站约束，hover 高亮是「可点」的 affordance，键盘游标是定位态、两者语义不同。

**验证**：`vite dev` + `?preview=1`，注入 21~26 节点带分叉的条目树（`?preview=1` 下手动写 `rightState.entryTree`），CDP 真实按键 + 截图，全程 `window.onerror` 0 错误——(1) 双击 Esc 进树：`scrollTop` 落在底部（458 / 1300，`atBottom` 为真），再进一次仍落底；(2) `↑` 起游标落在末项 `fa1`（分叉分支起点），再 `↑` 到 `c24`，`↓` 回 `fa1`；(3) 连按 `↑` 30 次停在首项 `root`（`scrollTop` 自动从 776 收到 5）、再多按 5 次不回绕；(4) `↵` 弹窗内容为「第 1 条消息」、按钮为 Cancel / Jump / Jump & summarize，弹窗开着时 `↑` 与 `↵` 均无效果（游标不动、不叠第二层弹窗），`Esc` 关闭；(5) 点 Jump 发 `navigate_tree{entryId:"c1",summarize:false}`、点 Jump & summarize 发 `summarize:true`；(6) 树页单击 Esc 仍切回 chat、再双击回树仍落底；(7) 游标视觉截图确认 accent 描边行与「Current」叶徽标（蓝）可区分。`bun run check`（含 tsc）、`bun run ui:build`、`bun run smoke:react`、`OMP_PROFILE=omp-desktop-test bun scripts/smoke-i18n.ts` 全绿；设置页 `pg-keyboard` 确认新增「Session tree」组两条目渲染。真机手测留用户确认。

**教训**：滚动落底的判据不能挂在「组件挂载」上——有异步数据 + 中间占位分支时，挂载那一刻内容还不存在，`scrollTop = scrollHeight` 落在 0 上，看起来就是「落底没生效」。判据应是「目标内容已渲染且身份变了」。同理，键盘操作不能只在有焦点的元素上监听：树页没有天然焦点容器，挂 `window` 捕获阶段 + 弹窗期间整体不注册，比逐组件 `onKeyDown` 更短也更不易漏。架构棘轮（`check-architecture`）会拦 `main-tree.css` 超行，逼着新样式跟文件既有的单行压缩风格对齐——这正是该文件「先拆分再增长」的意图，不要靠调大上限绕过。

### BUG-034: 供应商报错（配额/鉴权）不进消息区——失败原因只存在于 assistant 的 `errorMessage` 字段，翻译层无此分支

**现象**：会话 `01a0f5f5` 里两次「继续」都撞上 minimax-code-cn 的配额上限，消息区**没有任何提示**——没有错误行、没有 toast，看起来就是「发出去了但没反应」。用户是在供应商侧发现限流后回头查的。落盘记录见会话 jsonl 第 1521/1523 行：`stopReason:"error"`、`content:[]`、`errorStatus:402`、`errorMessage:"402 当前已达到 Token Plan 用量上限…(type=insufficient_balance_error)"`（上报口径说 429，实际是 402）。

**分诊**：②确认存量缺陷——自窄事件层建立起就没有错误路径，与本次改动无关。

**根因**：底座的失败语义是「一条 assistant 消息」而不是「一个错误事件」（`packages/agent/src/agent.ts:1758-1858`）：请求失败时合成 `stopReason:"error"` 的 assistant 消息，**失败文本只写在 `errorMessage`/`errorStatus` 字段上，`content` 为空**，然后照常 emit `message_start`/`message_end`/`turn_end`/`agent_end`。而 `host/translate.ts` 的 `translateEvent` 只认 `turn_start`/`turn_end`/`message_update`/`tool_execution_*`/`agent_end` 等，**没有 `message_start`/`message_end` 分支、也从不读 `errorMessage`** → 错误在翻译层静默丢弃。`entriesToTranscript` 同样只遍历 `content` 块，`content: []` 生成零条目 → 刷新/重载会话也看不到。UI 侧 `role:"error"` 的唯一写入点是 `{type:"error"}` 帧（`ui-src/store/wsHandlers/stream.ts:298`），而该帧只在 `prompt()` reject 时发（`host/session-lifecycle.ts:325`、`host/rpc/prompt.ts:395/446`）——底座把错误消化在 agent 内部、run 正常 resolve，这条通道永不触发。

**修复**：四处。(1) `host/translate.ts` 新增 `errorTextOf`（只认 `stopReason==="error"` 的 assistant + 非空 `errorMessage`）与 `message_end` 分支：先 `flushAssistantDraft`（保住失败前已产出的文本），再 push `{role:"error"}` 进 transcript 并下发 `{kind:"error", text}`。(2) `entriesToTranscript` 用同一判据，`finalizeRun()` 后把错误行推到顶层——过程可折叠，失败原因不可折叠。(3) `backfillAssistantEntryIds` 的候选过滤掉纯错误条目：它在磁盘上存在、在 transcript 里没有对应 assistant 行，占回填槽会把上一轮的 assistant 绑到错误条目的 id。(4) 前端 `ui-src/store/session.ts` 的 `applyEvent` 加 `error` 分支；`sealRunItems` 把尾部连续的 error 行摘出组外再拼回（`s.items.push(...finalOut, ...errors)`）。`host/state.ts` 与 `ui-src/types/frames.ts` 的条目/事件联合同步加 `error`。

**验证**：`bun .local/probe/error-row-probe.ts`（一次性探针，真实会话 jsonl 红绿对比）——`entriesToTranscript` 修复前 0 条错误行 / 修复后 2 条，且 0 条落在 loop 组内；`translateEvent` 对失败 `message_end` 修复前 `null`、修复后 `{kind:"error",…}`，普通 `message_end` 仍为 `null`；backfill 错配夹具修复前绑 `e1`（错误条目）→ 修复后绑 `a1`。浏览器端到端（`vite dev` + `?preview=1`，经页面链的 `dispatchFrame` 注入 `turn_start → tool → text_delta → error → turn_end(runEnd)`）：items 为 `[loop(仅含 tool), assistant(partial), error]`，DOM `.act.err` 渲染 `✗ 402 当前已达到 Token Plan 用量上限 (type=insufficient_balance_error)`（`--err` 色），截图确认错误行在折叠组之外、页面上直接可见。`bun run ui:typecheck`、`bun run ui:build` 通过。

**教训**：错误不是「一条消息」，而是消息上的一个字段——任何「只翻译文本增量」的窄事件层都会把它静默吞掉，而且现象是「什么都没发生」，没有任何报错可追。判断链路是否完整的办法不是读代码，而是拿一次**真实失败**的落盘条目喂进翻译层看输出（0 条 → 2 条即红绿判据）。另外错误行必须与过程组平级：把失败原因收进可折叠的 loop 组，等于把「为什么停了」藏起来，与「没显示」等价。

**已知遗留**：子代理流（`translateSubagentEvent`）同样没有 `message_end` 分支，子代理内部的失败仍不会产生错误行（`task:subagent:lifecycle` 只给 failed 状态、不带原因），未在本次处理。

### BUG-035: 统计行整轮不刷新、压缩后 token 倒退——口径取成「活动窗口筛选」且只在 turn 收尾推送

**现象**：输入框下方那行「缓存利用率 / 输入 / 输出 / 缓存读 / 缓存写 / 时长」，会话进行中整行数字不动，只在 turn 收尾跳一次（长回答、无工具调用期间「时长」也静止）；另有一处更隐蔽：发生过上下文压缩的会话，这些数字会**倒退**（缓存读从 57.5M 掉回几 M 量级）。

**分诊**：②确认存量缺陷——`buildSessionStats` 自建立起就是「agent_end 单点推送 + `session.getSessionStats()`」，与本次改动无关。

**根因**：两处独立缺陷。(1) **时机**：`session_stats` 帧只在 terminal `agent_end` 与加载会话时下发，turn 进行中一帧不发；每次模型轮结束（`message_end`）、每次工具结束（`tool_execution_end`）这些真正推进计数器的中间态全部跳过。(2) **口径**：`session.getSessionStats()` 底层的 `activeModelUsageEntries`（`packages/coding-agent/src/session/session-stats.ts`）按**活动窗口**筛选 model_usage 条目——窗口起点取最新 compaction 的 `firstKeptEntryId`，压缩后只统计窗口内的条目，压缩前的累计被整段裁掉 → 数字倒退。该窗口口径是「当前上下文窗口」的正确语义，但状态行要的是**整会话累计**：TUI 状态行自己读的是 index 级累计计数器 `sessionManager.getUsageStatistics()`（`#index.usageSnapshot()`，每条 model_usage 在 `insert` 时累加，从不窗口化）。

**修复**：(1) `host/session-lifecycle.ts` 的 `buildSessionStats` 改读 `entry.manager.getUsageStatistics()`（累计、单调）。(2) 新增 `maybePushSessionStats`，挂在既有的 `message_end` / `tool_execution_end` 分支（与 `pushContext` 同源事件）上推 stats，`STATS_PUSH_MIN_INTERVAL_MS = 1500` 节流——工具密集的 turn 不刷屏，turn 首个事件立即推。(3) `PoolEntry.statsPushedAt` 记录上次推送时刻（`host/state.ts`）。(4) UI 侧补连续量：`SessionStatsBar` 在 `session.streaming` 期间每秒本地外推时长（帧只在模型轮/工具边界到达，纯生成期间没有新帧），基准是帧落地时刻 `receivedAt`（`ui-src/types/frames.ts` 新增可选字段，`ui-src/store/wsHandlers/stream.ts` 落地时打戳）。

**验证**：`scripts/probe-stats-cumulative.ts`（真实 SDK，构造含 compaction 的会话文件）——累计口径 input/output/cacheRead = 1200/2400/60000 全保留，旧窗口口径只剩 200/400/10000（`firstKeptEntryId` 失配时甚至归零，正是「倒退」的极端形态）；`scripts/probe-stats-live-push.ts`（stub 驱动真实 `attachEntry`）——agent_start 后 0 帧、首个 `message_end` 后 1 帧（立刻推）、20 次 `tool_execution_end` 突发仍 1 帧（节流生效）、冷却后 2 帧、terminal `agent_end` 后 3 帧；`scripts/smoke-react-shell.ts` 新增状态行断言（运行中秒数递增 / 收尾冻结在宿主上报值）——把本地 tick 关掉后该断言转红，红绿判据成立。

**教训**：「当前上下文窗口」与「整会话累计」是两个口径，压缩点会把选错的那个暴露出来（数字倒退而非清零）。此外，进行中的连续量（时长）不能指望事件帧覆盖：帧只在离散边界到达，段间插值属于渲染层的职责。定位这类问题最快的路径是拿真实会话文件喂进两边口径直接对比数值，而不是读调用链。

**已知遗留**：真实模型端到端（应用内肉眼确认整行随会话走动）需在有凭据的 profile 验收——测试 profile 无可用模型，自动化跑不了真实 turn（`scripts/smoke-newsession.ts` 在该 profile 下停在 `ready 帧 defaultModel=null`，与本修复无关）。


### BUG-036: 升级底座到 18.5.0 后 host:build 直接 SyntaxError——build-host.ts 深依赖 pi-natives 内部模块，上游导出改名

**现象**：`bun run host:build` 在脚本加载期即炸：`SyntaxError: Export named 'containsVersionSentinel' not found in module '.../pi-natives/native/version-sentinel.js'`，构建链（host:build → ui:build → tauri build）一步走不下去。

**分诊**：①确认回归——`@oh-my-pi/*` 从 18.4.x 升 18.5.0 后首次构建暴露，升版前 host:build 正常。

**根因**：`scripts/build-host.ts` 为校验 `.node` 与包版本一致，深路径 import `node_modules/@oh-my-pi/pi-natives/native/version-sentinel.js`——该文件随 npm 包发布但**不在 package `exports` 内**，属上游内部模块，其导出名上游不承诺稳定。18.5.0 上游把「按版本哨兵导出名」方案重构为「链接后版本戳」方案，`containsVersionSentinel`/`versionSentinelFor` 两个导出消失；Bun 在 ESM 链接期校验命名导出，直接抛 SyntaxError。而 tsconfig 只 include `ui-src`，`scripts/` 与 `host/` 对底座的取用零静态门禁（RULE-004 早已点破本仓无 import 门禁），升级依赖时无人发现。

**修复**：三层防线——
1. `scripts/build-host.ts`：删深 import，版本校验逻辑（stamp + legacy 哨兵）内联为 `addonBytesMatchVersion()`，头部注释标明镜像来源与失效时重新镜像的方法——此后上游改函数名不再影响本仓；
2. 新增 `scripts/check-omp-imports.mjs` 挂进 `bun run check`：对 `host/host.ts` 与 `scripts/build-host.ts` 两个入口 `bun build --target=bun` 干跑（打包不执行、链接期校验导出），把底座导出/子路径漂移从「构建/运行期」提前到「升级后跑 check 时」暴露；host 入口同时覆盖 `host/` 里全部子路径 exports 依赖（如 `@oh-my-pi/pi-tui/chat/transcript-entry`）。须带 `--external omp-legacy-pi-modules`（与 build-host 一致，pi-coding-agent 内部可选动态 import）；注意干跑的 tree-shake：无引用的 import 会被消除不报错，守卫只对「真实调用点」的漂移可靠；
3. `docs/PITFALLS.md` 补升级底座 SOP；立 RULE-010。

**验证**：守卫故障注入（把旧深 import + 真实调用形态临时写回 build-host.ts）→ `check-omp-imports` 精准报 `No matching export ... for import "containsVersionSentinel"` 退出码 1，还原后恢复通过；`bun run host:build` 实跑通过（内联校验在真实 baseline `.node` 上命中 stamp 分支，`PI_NATIVES_VERSION_STAMP:18.5.0`）。

**教训**：升级 `@oh-my-pi/*` 是跨包 API 契约变更，本仓对底座的取用有三类耦合面——公共入口、子路径 exports（`pi-tui/chat/...` 这类）、包内未导出文件的深路径（`pi-natives/native/...`）——后两类上游不承诺稳定。防线必须机器化（check 干跑 + RULE-010 升级 SOP），不靠记性。



### BUG-037: Windows 上样式门禁误报 shadcn 基件——vendor 目录排除被路径分隔符击穿

**现象**：Windows 机器 `bun run check` 第三步 `check-style-tokens` 红，报 `ui-src/components/ui/*.tsx`（dialog/dropdown-menu/input/select/textarea/scroll-area）共 9 处任意值 utility（`rounded-[6px]`/`rounded-[9px]`/`rounded-[inherit]`/`leading-[1.55]`）；macOS 上同一门禁绿。

**分诊**：⑤环境特定 + ②存量缺陷——脚本自引入起在 Windows 上排除逻辑就失效，与任何近期改动无关。

**根因**：`scripts/check-style-tokens.mjs` 用 `rel.startsWith("ui-src/components/ui/")` 排除 shadcn vendor 目录（设计意图见该脚本头注释：基件是上游移植，不受本仓样式治理），但 `path.relative()` 在 Windows 返回反斜杠路径（`ui-src\components\ui\...`），正斜杠前缀永不匹配 → Windows 上 vendor 排除失效，shadcn 自带的设计值被当本仓违规报出。

**修复**：L42 归一 `relative()` 结果的分隔符（`split(/[\\/]/).join("/")`）。vendor tsx 零改动——上游移植文件保持原样便于同步，正确治理是排除而非逐行豁免/改值。

**验证**：门禁单跑绿；故障注入（向非 vendor 的 `ui-src/App.tsx` 临时加 `rounded-[7px]`）仍被抓、exit 1，还原后恢复；`bun run check` 八步全绿（3.2s）。

**教训**：跨平台脚本里「字符串前缀匹配路径」必须先归一分隔符。Windows 上跑红的门禁先查脚本的平台假设再怀疑业务代码——本例险些按「存量欠账」误诊去改 9 处 vendor 文件（把基件改出本仓私有 diff，制造未来同步 shadcn 的冲突面）。

### BUG-038: Windows 终端默认起 PowerShell 5.1——默认 shell 硬编码，不探测 pwsh

**现象**：Windows 机器右栏终端打开就是 Windows PowerShell 5.1（`PSVersion 5.1.26100.x`），用户机器默认 shell 已设为 pwsh 7 也不跟随。

**分诊**：②确认存量缺陷——自终端功能引入即如此。

**根因**：`host/pty.ts` 的 `resolveDefaultShell()` Windows 兜底硬编码 `"powershell.exe"`（=5.1）。前端 `terminal_create` 只发 id/cwd/cols/rows 不传 shell；`SHELL` 环境变量在 Windows GUI 进程基本不存在；应用也没有终端 shell 设置项、不读系统/Windows Terminal 默认——三条路全断，永远落到硬编码值。而「用户默认 shell」在 Windows 没有可靠系统 API（Windows Terminal 的默认 profile 是其私有配置）。

**修复**：Windows 默认改为探测式 pwsh 优先——`spawnSync("pwsh.exe", ["-NoProfile","-NoLogo","-Command","exit 0"])` 起得来就用 pwsh 7，ENOENT/非零回落 `powershell.exe`，探测结果进程内缓存一次。与 pi-natives loader 自己的探测顺序（native/loader-state.js 先 `pwsh.exe` 后 `powershell.exe`）一致。`SHELL` env 显式覆盖保持最高优先（现行为不变）。

**验证**：throwaway 脚本真起 PTY（createTerminal→读 session.shell→dispose）——本机默认解析 `pwsh.exe`；设 `SHELL=C:\fake\overwrite.exe` 时传给 PTY 的即该值（以 CreateProcessW 报错形态证明覆盖优先级生效，探测未参与）；`bun run check` 八步全绿。

**教训**：跨平台默认 shell 不能硬编码 powershell.exe——Windows「用户默认 shell」没有系统 API，pwsh-first 探测是唯一可靠路径（底座 loader 同款顺序）；GUI 进程 env 里没有 SHELL 可读。

### BUG-039: 终端起始目录落用户主目录——空 cwd 回落宿主 process.cwd()

**现象**：打开 oh-my-pi-desktop 项目后开右栏终端，提示符落在 `C:\Users\<user>` 而非项目目录。

**分诊**：②确认存量缺陷——终端功能引入即如此。

**根因**：三层回落链全部没有项目语义：① 前端 `terminal_create` 仅在「有活跃会话」时传会话 cwd，否则发空串（`TerminalPage.tsx` 的 `cwd: s?.cwd ?? ""`）；② 宿主 `rpc/terminal.ts` 对空 cwd 回落宿主进程 `process.cwd()`；③ 宿主由 Tauri GUI spawn（`src-tauri/src/lib.rs` 的 `cmd.spawn()` 未设 current_dir），继承 GUI 起始目录——Windows 下从开始菜单/双击启动即用户主目录。「当前项目」信息只存在于会话层，无会话时没有任何带项目语义的兜底。

**修复**：`TerminalPage.tsx` 创建 PTY 的回落链改为 会话 cwd → `getAvailableProjects()[0]?.cwd`（主项目目录，与新建会话默认/欢迎屏同一惯例）→ 空串（宿主兜底不变）。

**验证**：`bun x tsc --noEmit` + 七道门禁全绿；用户 dev 实测确认（无会话开终端落主项目目录）。

**教训**：GUI 宿主的 `process.cwd()` 是任意的启动目录，任何「默认工作目录」语义都不能落到它上面；应用内已有主项目惯例（`getAvailableProjects()[0]`）就直接复用，不要发明第二套默认。
### BUG-040: 发消息后「工作中 Ns」贴着气泡被渐隐吞掉——贴底目标把 sticky 底部占位的 36px 算进内容

**现象**：发送消息后，新回合的气泡下方第一行流程内容（「工作中 Ns」+ 转圈）几乎贴在气泡下沿（实测仅 7px），且整行处于气泡底部 36px 渐隐蒙版里，看起来像被"自动淡出"；用户诉求是「发出后流程内容初始离气泡远一点」。

**分诊**：②确认存量缺陷——`#stream::after` 底部渐隐占位（508e3ba 引入）落地后即如此，与本次改动无关。

**根因**：三件既有设计叠加。(1) 发送时的贴底滚动目标是 `el.scrollTop = el.scrollHeight`（Chat.tsx）；(2) `.turn-section:last-of-type { min-height:100% }` 让新回合恰好占满一屏，回合自身没有可滚动余量；(3) `#stream::after` 是 36px 的 `position:sticky` 占位块（计入 scrollHeight 但无内容）。于是「贴底」相对真实内容多滚了 36px——把整回合顶上去 36px，sticky 用户气泡被钉在滚动口顶端时其流内位置上方 36px 与流程内容重叠，流程首行被拽进 `.sticky-user-wrap::after` 的 36px 渐隐带（sticky 贴顶尖与蒙版区同随滚动，内容正好卡在渐变最浓段）。验证：隐藏 `#stream::after` 后同一贴底目标的 clamp 值从 36 变 0，内容不再被顶起，证明 36px 偏移正是占位块贡献。

**修复**：`ui-src/components/Chat.tsx` 新增 `latestScrollTop(el)` 取代全部三处 `scrollTop = scrollHeight`（发送/切换/流式跟随 + 「回到底部」按钮点击；按钮可见性口径同步改为「视口位置低于最新内容位」）。目标 = 最新回合真实内容底端（`turn-section` 末子块 `turn-body`/`turn-acts` 的底边）+ 36px 渐隐余量 - 视口高，再 clamp 到 [该回合顶部, scrollHeight - clientHeight]：内容装得下时停在回合顶部（气泡贴顶、流程内容自然落在蒙版下方 43px 处），回合超过一屏时才跟到贴底（长回合跟随行为不变，末行仍停在底部渐隐带之上）。回合后的顶层 steer 气泡走「其自身底边 + 36px 余量」同款口径。

**验证**：`vite build` + 本地静态服务 + Chromium（`?preview=1`）逐态实测——(1) 首条消息发出：`scrollTop 0`，气泡底→首行间距 43px（修前 7px），首行/转圈均落在蒙版区外，回底钮按新口径正确隐藏；(2) 短回合结算（loop 折叠）/二次发送叠在短回合上：同前，间距 42.7~43px；(3) 长回合（40 段）：跟随时仍稳在最大滚动位（971/971），滚上去后按钮出现、点击回落 (971 → 971)、按钮转隐；(4) 长回合成长期（草稿 300→900→1600）：未超屏时停在回合顶（不顶气泡），超过一屏后无缝切回贴底跟随；(5) 结算后的长回合：静止位在 `acts 底边 = 视口高 - 36`（底部渐隐带正上方），与设计留白一致；(6) 流式中追加 steer 气泡（长流短流两态）：落点均在底部渐隐带之上；(7) `bun run check` 八步 + `smoke:react` 全绿。

**教训**：计算「滚到底」不能直接用 `scrollHeight`——任何参与布局的 sticky 渐隐占位/留白块都会被算成内容，让贴底目标系统性过冲，把「贴着滚动口顶端的吸附元素」与「紧随其后的内容」压到一起。目标应锚定「最新内容真实末边 + 预留渐隐高度」，并给「回合装得下」的常见情形回落到回合顶部，否则短回合永远停留在被顶起 36px 的状态。现象上「内容被淡出」容易被误判成蒙版本身的问题，实为滚动落点问题——蒙版没错，是内容站错了位置。

### BUG-041: Windows 安装版使用统计永远「同步失败」——桌面宿主分支未声明 worker host，stats 解析 worker 回退编译产物虚拟路径不可加载

**现象**：Windows 打包版设置页「使用统计」右上角实时徽标恒为「同步失败」，tooltip 是 `BuildMessage: ModuleNotFound resolving "B:\~BUN\root\sync-worker.ts" (entry point)`，每 10s 重试每 10s 失败，统计零导入；macOS 打包版正常。

**分诊**：②确认存量缺陷——自 stats 服务器并入桌面宿主（host/stats.ts）即如此，仅 Windows 打包形态可观测（用户 omp-desktop profile 当日日志 75+64 条 `Stats live sync failed` 实锤）。

**根因**：两层叠加。① `host/host.ts` 只在 argv 非空分支 `declareWorkerHostEntry()`，桌面宿主分支（argv=0，正是 stats 服务器所在进程）里 `workerHostEntry()` 恒为 null；omp-stats `createSyncWorker()` 于是回退 `new Worker(new URL("./sync-worker.ts", import.meta.url).href)`——编译产物里该 URL 解析为虚拟内嵌路径 `B:\~BUN\root\sync-worker.ts`，Windows Bun 无法作为 worker 入口加载 → ModuleNotFound。macOS 不可见是因为 omp-stats `defaultWorkerCount()` 对 darwin 固定 1（串行解析、从不 spawn worker）。② 补上 declare 后又揭出第二层：worker 线程重入 omp-host.exe → runCli 分发 `__omp_worker_stats_sync`，cli.ts 对这个零导出模块的动态 import 被 bun 单文件编译改写成惰性工厂调用 `(KVr(),{})`，模块体（`self.onmessage = ...`）永不求值，分发器留下的缓冲 onmessage 吞掉所有消息——不报错、永远 syncing。

**修复**：`host/host.ts` 两处。① declare 提到路由前、两分支共用（自分发入口协议：本入口能分发 worker 选择器就应注册为 worker host）。② `__omp_worker_stats_sync` 选择器不再借道 runCli，在入口直接 `await import("@oh-my-pi/omp-stats/sync-worker")`（从入口 import 的改写会正确求值模块体），并按 cli.ts 同款「先寄存再重放」处理早到消息，setInterval 挂住线程。防回归：`scripts/smoke-stats-sync-worker.ts`（起产物 → /api/events → 断言 idle 且 fixture 计入；未修复产物上实测 FAIL/error，修复产物 PASS）。

**教训**：库内嵌宿主把自己当「CLI 编译产物」时，SDK 的 worker 协议责任要在**宿主形态的每个分支**核对——declare 只写在 CLI 分支，意味着宿主进程内一切线程 worker（stats 解析、js_eval）全部走降级路径；平台差异（darwin 串行）会掩盖故障面。另外 bun 单文件编译对零导出模块的动态 import 改写存在不求值陷阱（详见 PITFALLS「Windows MSI 打包」节），新选择器在产物里必须实测消息往返，不能只看分发不报错。

### BUG-042: 切换 MiniMax 后上下文明细卡配额段等 ~1s——无会话 hover 走裸 provider 缓存键从未被预热，冷抓再叠加跨区域端点回退

**现象**：把输入区模型切到 MiniMax 供应商后 hover 上下文环，明细卡弹出的配额段要等接近 1 秒才出现；后台配额缓存明明每 5 分钟全量刷新。

**分诊**：②确认存量缺陷——多账号 `provider#credentialId` 缓存键体系落地后即如此，对「凭证存 authStorage 的 API-key 型供应商」（MiniMax 无 OAuth 流程，只能 API key 向导配置，必属此类）必现。

**根因**：两层叠加。① 缓存键错位：`host/rpc/limits.ts` 的 `get_limits` 只在**有会话**分支做 key 反查（getApiKey → credentials.list 反查 → `#id` cacheTag），与后台刷新（`refreshAllLimits` → `fetchProviderAccountsLimits`，只写 `provider#id` 行）共享缓存；输入区切完供应商还没开会话时走**无会话**分支，cacheTag 恒 undefined → 裸 `provider` 键——凭证存在时后台从不写裸键行 → 每次超过 TTL 的首次 hover 必冷抓。② 冷抓耗时被 MiniMax 拉满：`VENDOR_SPECS.minimax*` 不传 `minimaxApiHost`，vendor 端点序默认 `[EN tokenPlan, EN legacy, CN tokenPlan, CN legacy]`，CN key 打 EN 端点返回 200 + `base_resp.status_code 1004`（auth 形态）→ 逐端点回退，2~3 次 HTTPS 往返 ≈ 1s。

**修复**：三处。① `host/rpc/limits.ts`：无会话分支同样走 getApiKey + 反查（提取 `accountForResolvedKey` 共用），共享 `#id` 缓存行，顺带补上无会话路径的账号 label；② `host/limits/index.ts`：新增 `minimaxRegionForBaseUrl`（minimaxi.com→cn / minimax.io→en，仿 zaiRegionForBaseUrl），四个 minimax spec 传入 `minimaxApiHost` 锁区域，未知 host 保持双区域序；③ `host/rpc/login.ts`：`provider_set_key` 后 fire-and-forget 预热该供应商配额缓存，消掉刚配完 key 到下个 5 分钟 tick 之间的冷窗。

**验证**：`.local/verify-limits-cache.ts`（临时,已删）——真实 AuthStorage + 录制型 fake fetch：后台预热 1 次请求；旧无会话形态复现冷抓（extra=1）；新形态 `#id` 命中（extra=0）；CN baseUrl 全程不碰 EN 端点、区域内在 token_plan→legacy 回退后 ok；EN baseUrl 只碰 EN 端点。8/8 PASS。`bun run check` 六道门禁绿；`ui:typecheck` 报 `ComputerPage.tsx` `Section` 未定义——存量 WIP,与本次无关（本次未触 ui-src）。

**教训**：给「预热缓存 + 前台读缓存」设计缓存键时，要枚举**前台读取方的全部入口形态**（有会话/无会话/多账号 sticky/按 provider 直查），任何一种形态的键合成路径没有预热方对应写入，该形态就永远冷路径——TTL 越长，症状越像「缓存没生效」。跨区域供应商（MiniMax 双域名、zai 双站点）的限额查询必须从 baseUrl 锁区域，否则冷路径延迟会被端点回退序放大数倍。

### BUG-043: 缓存保活永远显示「已暂停」——靶标匹配拿设置页的拼合 catalog id 比注册表裸 model id，捕获永不成立

**现象**：实验功能页开了缓存保活、靶标模型已配置（deepseek/zhipu/minimax 均已选），但上下文明细卡保活段的「下次运行」恒为「已暂停」，探测计数永远为 0。

**分诊**：②确认存量缺陷——keepalive 桌面移植引入 selectable targets 时即如此，凡通过设置页配置靶标的用户必现（即全部用户：UI 是靶标的唯一写入方）。

**根因**：id 格式两侧错位。设置页靶标选择器的数据源是 composer 模型菜单 `modelNames`，其 key 是宿主 `models.ts` 拼合出的 **`provider/model` 复合 id**（`const id = \`${m.provider}/${m.id}\``，与 models 帧/UI 全站一致）；而 keepalive 扩展在 `before_provider_request` 里做捕获门禁的 `isTargetModel` 拿 **SDK 注册表 `ctx.model.id`（裸名，如 `glm-5.3`）** 去 `config.targets.includes(model.id)`——拼合串永远 ≠ 裸名，捕获永不成立 → `capture` 恒 null → `armed()` 恒 false → `agent_end` 的 `schedule()` 永远是空操作 → `nextProbeAt` 恒 null → 卡片恒「已暂停」。移植时的类型注释「catalog id ("provider/model")」是对 SDK 上下文的错误假设。smart 模式的 per-model TTL 存储（modelTtlMs 确认值 / model-ttl.json 爬升值）与 probe-log 的 model 字段同用裸 id，一并统一。

**修复**：`host/keepalive.ts` 新增 `catalogId(model) = \`${provider}/${id}\``，五处统一改用复合 id：`isTargetModel` 靶标匹配、smart 模式 `resolveModelTtlMs` 读取、`smartAdaptAfterHit`/`smartAdaptAfterMiss` 的 TTL 写入键、probe-log 的 model 字段。存储键无历史迁移负担（捕获从未成功过，旧键不存在）；修正 `KeepaliveModel.id` 的错误注释。

**验证**：`.local/verify-keepalive-targets.ts`（临时,已删）——真实 `createKeepaliveExtension` 走 session_start → before_provider_request → agent_end 事件链（temp omp-desktop.json 复刻设置页写入的复合靶标）：非靶标 provider 同名裸 id 不布防；复合靶标（裸 id + 正确 provider）布防且 `nextProbeAt ≈ now + intervalMs`（±5s）。3/3 PASS。`bun run check` 全绿（含 tsc）。

**教训**：在两个 id 体系（SDK 注册表裸名 vs 宿主/UI 拼合 catalog id）之间做任何**等值匹配**前，先核对两侧字段的实际取值格式——类型注释写的「catalog id」可能是移植时的假设而非事实。跨边界传递的 key（配置文件里人可见、UI 可回显的字段）应统一到 UI 侧格式；隔离实现里对 SDK 形状的每一处假设，都要用真实事件上下文验一次。

### BUG-044: 桌面版 computer use 全不可用——薄入口在 worker 线程 `runCli` 返回后无条件 `process.exit(0)`，worker 刚发出 ready 就被秒杀

**现象**：桌面版（Windows 打包/开发形态）computer 工具任何调用立即失败：`computer.capabilities()` 抛 `Error: Computer worker exited`，截图/AX/点击全不可用；同一 else 分支的线程 worker（浏览器镜像 tab、终端输出、eval）也在启动瞬间退出（探针实测四类在 0.4s 内 `close`，computer 还能看到 `{"type":"ready"}`）。native 后端本身完好——把那次退出挡住后 capabilities 返回 `backend: win32 / capture+input+ax: true / capturePermission..axPermission: granted / displayCount: 2`。

**分诊**：①本仓新引入——364a13d 薄入口改造把「argv 非空 = 以 CLI 身份运行，`runCli` 返回即 `process.exit(0)`」写成通则，ad8ef9a（BUG-041）只给 `__omp_worker_stats_sync` 补了托底；computer/tab/terminal-output/eval 四类线程 worker 走的正是没有托底的 else 分支。

**根因**：worker 线程的存活责任挂在 message port 上，不在宿主入口。cli.ts `runWorkerEntrypoint()` 对选择器分支只做「装 inbox → import worker 模块（computer 再 `startComputerWorker()`）→ return」——分发一返回，线程就只剩 parentPort 的 message 监听器撑着事件循环（子进程形态不同：`runIpcSubprocessWorker` 自己 await IPC 循环）。`host/host.ts` 的 else 分支在 `runCli(argv)` 返回后无条件 `process.exit(0)`，于是 `__omp_worker_computer` 线程在发出 `{"type":"ready"}` 后约 40ms 被自己的入口杀掉；宿主的 `ready` 与 `close` 事件几乎同时到达，`spawnComputerWorker()` 的 `wrapWorker` 把它翻译成 `Computer worker exited`。定位法：在 worker 线程里包一层、先 patch `process.exit` 打印调用栈再 import 宿主模块——单帧落在 host.ts 顶层的 `process.exit(0)`；patch 成空操作后线程存活并正常应答 ping/capabilities。

**修复**：`host/host.ts` else 分支改为「非主线程 + worker 选择器」时 `setInterval(() => {}, 2 ** 30)` 挂住线程（与 stats_sync 分支同一托底），其余形态仍 `process.exit(0)`。防回归：新增 `scripts/smoke-computer-worker.ts`——以 `new Worker(host/host.ts, { type: "module", argv: ["__omp_worker_computer"] })` 重入宿主入口，断言 ready → ping/pong → close/closed，握手前 close 直接判失败。

**验证**：修复前 dev 源起线程实测 `0.03s ready → 0.04s close`、无 pong（安装版编译产物同签名）；修复后 smoke 全绿（EXIT=0），capabilities 探针 `ok:true`（win32 / capture+input+ax granted / displayCount 2）。产物形态未能跑通 `--smoke-test`：它在测试 profile 上先死在无关的 stats dashboard `HTTP 500`（test profile 无 stats.db），未走到 computer 检查；故产物侧以「安装版复现签名 + 同源编译」佐证。

**教训**：宿主入口把 SDK 的 worker 协议转发给 `runCli` 时，**线程 worker 与子进程 worker 的退出责任不同**——子进程自己守着 IPC 循环、父进程断连后再退出是对的，线程全靠 port 监听器，入口「分发完就 exit」对后者等于秒杀。给这类隐式协议补分支要按**选择器全集**过一遍（这次只给 stats_sync 补了托底），而不是只验当前出问题的那个；`--smoke-test` 里每个 worker 家族各有一条 ping/pong 断言，是这类 bug 的天然防线。

### BUG-045: 外部写入误报警 + 重载后「进行中」消失——reload_session 把仍在跑的 AgentSession 抽稀成孤儿，轮询把自己的孤儿写入当成「别的进程」

**现象**：应用内与会话对话中途，突然提示「此会话正在被其他进程写入（如 CLI），视图可能不同步」；点重新加载后，会话不再显示进行中，但实际上那轮生成仍在继续（用户确认没有任何 CLI/别的写入方）。

**分诊**：①本仓新引入——外部写入轮询（`host/main.ts pollExternalWrites`，逐 2s 比对「文件新增行里不在 `entry.manager.getEntries()` 索引中的 id」）只在「同文件存在第二个写入者」时才会触发，而桌面自身就会制造这种写入者。

**根因**：`reload_session`（host/rpc/session.ts）对池内条目只做 unsubscribe + 出池，随后从磁盘重建。若那轮生成还在跑，旧 AgentSession 既不被 abort 也不被 dispose：它继续无头执行并落盘（事件发给已注销的订阅、UI 的 streaming 状态只由事件驱动，重建条目从磁盘起就是空闲态）——「重载后不显示进行中但确实还在跑」；同时孤儿的持续写入（含空闲后缓存保活持久化的 usage 行、退出时的 session_exit 行）的 id 不在重建管理器的内存索引里，轮询判为外部写入——「确确实实没有别的地方在写入」。磁盘证据（2026-10-05）：`01a10cb3` 带 `parentSession=01a10c91` 回链、宿主死亡瞬间诞生，是 SDK 所有权租约被占后 `moveOffSessionFile` 的产物——当晚确有第二个 omp 进程碰过该会话；且会话文件被转移后前端仍持有旧路径，按路径匹配的池扫描（load 复用/reload/mark_seen）会漏掉活条目、在死文件上再建一个会话，属同类「第二写入者」来源。

**修复**：`reload_session` 三处收口：①忙态拒绝——`activeStartedAt !== null`（回合进行中）、`queuedMessageCount > 0`、后台任务 running 任一成立即抛 `errors.session.reloadBusy`（前端 toast，实时视图继续流式，提示条保留）；②空闲重载改为 `session.dispose()` 全量收尾（停缓存保活/后台任务/残余写入者，SIGTERM 收尾同款路径）再出池重建；③重建改用条目**当前** `entry.path` 而非请求路径。配套：`PoolEntry.previousPaths` 记录持久化转移的旧位置（`onPersistenceNotice` 追加），`handleLoadSession` 复用扫描 / `reload_session` / `mark_seen` 三处按「当前或历史路径」匹配，杜绝在废弃文件上分叉第二活会话；`Chat.tsx` 提示条的重载按钮在 `s.streaming` 时禁用并带 `chat.reloadRunning` 提示（zh/en）。

**验证**：`scripts/tmp-verify-reload.ts`（临时，已删）真实宿主 + glm-5.3-flash 全链路：流式中途发 `reload_session` → 收到 reloadBusy 拒绝帧、该轮继续完整流式到 turn_end（含全部 30 行输出）→ 空闲后重载从磁盘重建（历史含完整回复）→ 重建会话再发一轮正常应答 → 全程 0 个 `session_external_write` 帧（含重载后跨多个轮询窗口）。`bun run check` 全绿（含 tsc、能力清单、边界、注释语言等 8 项）。

**教训**：「按路径换血重建」类 RPC 必须先过**存活检查**——视图刷新绝不能把 worker 抽稀成孤儿，否则孤儿自己就会变成「外部写入」的假信号源；轮询式外部检测的判定基准（内存索引）只对「单一管理器」成立，任何会制造第二管理器/第二会话的路径（reload、文件转移后的路径失配）都是它的误报入口。文件被 SDK 转移后，前端持有的旧路径仍是有效身份，池匹配必须认历史路径。

### BUG-046: 同一会话一夜间多出两份完整拷贝——宿主重叠窗口内，垂死宿主的退出补写把整份 journal fork 成新 ID 文件

**现象**：会话列表出现三份「AskUser 其他选项输入框过短」：原件 `01a10c91` + `01a10c97-eaf5`（56 条快照）+ `01a10cb3`（128 条快照），后两者是带 `parentSession` 回链的完整 journal 拷贝；同晚另两个并行会话（`01a10c7f`/`01a10c85`）也被各复制了一份（`eadd`/`eaec`）。

**分诊**：①非数据损坏，是 SDK（pi-coding-agent）的会话属主保护：同一会话文件「谁先写谁拥有」（Windows 命名互斥体，进程死内核自动释放），非属主进程一旦再写——哪怕只补一条 `session_exit` 诊断——就把整份 journal 搬到新 UUID 的兄弟文件（`#moveOffSessionFile("open-elsewhere")`），防止两进程写坏同一文件。②两次复制均有宿主日志实证：23:04:05 宿主 23376（父壳已死、stderr 管道已断）在 5 分钟一次的配额刷新回调里 `process.stderr.write` 撞 EPIPE（host/main.ts:193）→ unhandled rejection → 致命退栈给每个打开的会话补写退出记录，而当时 3 个标签会话的属主已在接班宿主 25680（23:01 起）手里 → 24ms 内 fork 出 3 个副本；23:34:07 宿主 9760 的父死自监视触发裸 `process.exit(0)` → SDK 进程退出钩子同样补写 → 又 fork 出第二份。③会话列表按磁盘 `.jsonl` 全量扫描、不按 `parentSession` 折叠，故三份同显。

**根因**：三缺陷叠加——(1) stderr 写无 EPIPE 保护，一条定时器里的日志就能把宿主炸进致命退栈；(2) 孤儿宿主的一切自退路径（父死自监视裸 exit、致命退栈）都会向「已易主」的会话 journal 补写记录，而补写=抢属主=fork；(3) 宿主重叠窗口客观存在（壳重启、双开实例、tauri dev 杀树残骸），属主必然先被接班宿主拿走。垂死进程的任何「顺手补写」在多进程共享存储下都是写冲突源。

**修复**：(1) 新增 `host/stderr.ts` 的 `safeStderr`（吞同步抛 + 模块顶层挂 error 空监听），host 下 54 处 `process.stderr.write`/`console.error` 全量替换；(2) `host/main.ts` 父死自监视由裸 `process.exit(0)` 改为 `process.kill(self, "SIGKILL")` 硬退出——SIGKILL 跳过全部 JS 退栈，零 journal 写入零 fork；journal appends 本就逐条同步落盘，仅损失本进程的 exit 诊断行，且该路径只在父壳已死时触发，与旧路径相比只减不增（旧的裸 exit 同样不做异步清理，唯一多做的是引发 fork 的补写）。边界表同步登记 16 条 `→stderr.ts` 依赖边。残余风险（未修）：RSS 看门狗 `process.exit(86)` 需保留退出码给壳重启逻辑，重叠窗口内仍可能 fork；UI 列表不折叠 fork（修复③④范畴）。

**验证**：safeStderr 契约 3/3（单串透传/多参拼接对齐 console.error/写失败吞掉）；SIGKILL 自杀跳过 exit 钩子（探针红绿：SIGKILL 无 flag、`exit(0)` 有 flag）；孤儿链路实跑：spawn 真宿主 → READY → 父进程退出 → ≤2.5s 内自灭、tasklist 无残留、宿主日志干净；`bun run host:build` 通过；真实宿主冒烟起机、WS 握手、会话列表、配额刷新日志（当年炸机的那一行）全走 safeStderr；八项门禁全绿（host/main.ts 278/280）。注：`scripts/smoke.ts` 的「应有历史 project」断言因测试 profile 历史被前次清理而空挂，与本次改动无关。

**教训**：进程级管道（stdout/stderr）在父壳死亡后就是地雷，守护进程的一切日志写入必须有 EPIPE 兜底——日志永远不许杀进程。垂死进程应当零写入退出：诊断、审计、埋点类「退出补写」在多进程共享存储下等于写冲突；Windows 上壳的 TerminateProcess 天然零退栈，而一切「自己 process.exit」的路径都会跑钩子，自毁手段必须与写入意图匹配。

### BUG-047: 安装版批准计划后收尾崩——readSdkPrompt 用 import.meta.resolve 运行时读 SDK 包，standalone exe 无 node_modules 可解析

**现象**：Windows 安装版批准计划（任一选项）后收尾失败，消息区报 `Cannot find package '@oh-my-pi/pi-coding-agent' imported from B:\~BUN\root\omp-host.exe`；计划模式本身、提案、审批卡均正常，死点固定在批准后的执行派发。

**分诊**：①确认存量缺陷。`readSdkPrompt` 自引入起就以 `import.meta.resolve("@oh-my-pi/pi-coding-agent/plan-mode/approved-plan")` 锚定包 src 根再读 `prompts/system/*.md`——dev 形态（bun 跑源码）两条解析都通，编译形态从未可用（与 BUG-041 同族：编译产物虚拟路径）。

**根因**：standalone exe 里「运行时读 node_modules」是死路：(1) 虚拟 FS（`B:\~BUN\root\`）里没有 node_modules，`import.meta.resolve` 运行时直接抛「Cannot find package」（Bun 1.4.2 最小复现 exe 实证，措辞 `Cannot find module ... from 'B:\~BUN\root\repro.exe'`）；(2) md 文件不在 import 依赖图内，`bun build --compile` 根本不会把它打进产物——即使 resolve 成功也无文件可读。SDK 的 exports 又不暴露 `prompts/` 子路径，包内直接 import 不可行。

**修复**：prompt 镜像入仓（`host/prompts/`，与 SDK 逐字节一致）+ 根 `bunfig.toml` 声明 `[loader] ".md" = "text"`（oh-my-pi 源码仓同款）+ `readSdkPrompt` 改静态 import 镜像文件查表（构建期内联字符串，dev/编译同一路径）；`scripts/build-host.ts` 每次构建校验镜像 == 已装 SDK，漂移即败并提示 `bun run host:sync-prompts`（对齐 BUG-036 的「镜像 + 失效提示」哲学）。

**验证**：probe 最小 exe 实测编译产物内 `.md` import 返回完整文本（type string / 922B / 内容正确）；故障注入三态（篡改镜像 → host:build 精准拦截报文件名 → sync 恢复 → 重建通过）；`bun run smoke:plan` 13 断言全绿；`bun run check` 全绿。

**教训**：standalone exe 中一切「运行时解析/读取 node_modules」的路径（import.meta.resolve、动态拼接 import、读包内非 import 文件）都是死路，包内文本资源必须构建期内联；dev 形态全通会系统性掩盖这类问题，凡新增触碰 SDK 资源的路径，最低验证要过一次 `host:build` 后的 exe 实测。

### BUG-048: 批准卡无模型滑条且批准后静默切 default 模型、输入框仍显示旧模型——requestApproval 帧手挑字段漏 slider 等 4 个 + applyRoleModel 后不推 session_model

**现象**：用户在 kimi 会话批准计划执行后报错收尾（BUG-047 叠加），打「继续」续跑：输入框右下角仍显示 kimi，上下文明细环额度卡显示 GLM 余额，实际请求也发给 GLM（journal 实证：`mode_change:none` 后 7ms `model_change:zhipu-coding-plan/glm-5.3 role=default`，其后 40 条消息全 glm），直到手动切回 kimi；且批准卡上从未出现执行模型滑条。

**分诊**：②两个叠加缺陷（同一批准链）：A. `host/state.ts` `requestApproval` 帧 spread 手挑字段，只透传了 `keepContextTokens`——`slider`/`disabledIndices`/`editable`/`editableIndex` 全部没上帧；UI 端组件/store/消费链齐全，纯发送端漏字段。B. `dispatchApprovedTurn` 的 `applyRoleModel` 与手动切换的 `set_model` RPC 推送契约不对称：后者推 `session_model` 帧刷新输入框显示，前者什么都不推。

**根因**：A 使 UI 永远收不到滑条 → 不渲染、不回传 `sliderIndex` → host 端 `pickedTier` 兜底为本地构造的 `slider.index`（default 档）→ 静默 `applyRoleModel`(default 角色 = GLM)，用户无从看见也无从选择（滑条 UI 与回传协议都在，唯独帧上没数据）；B 使切换发生后 UI 模型显示冻结在旧值。另 keep 行禁用（>95% 上下文）与 save-quit 路径编辑框标志同因失效。

**修复**：帧构造改 `...(presentation ?? {})` 整体透传（滑条、禁用行、编辑器标志一并恢复；字段名即帧字段名，整体透传杜绝再漏）；`dispatchApprovedTurn` 增加 `ws` 参数，`applyRoleModel` 成功后镜像 `set_model` 推送 `session_model`（sessionId 取 session 自身 id——execute 分支作用于新 fork 的会话）。

**验证**：帧构造 throwaway 探针 6/6（slider 五字段 + options 完整）；`bun run smoke:plan` 13 断言全绿；`bun run check` 全绿。限制：无模型 profile 下 `slider` 不下发、`roleIndex` 分支不可达，`session_model` 推送未获自动断言——帧形状与 `set_model` 既有通道逐字段一致，UI 处理器既有，首次真模型批准时人工复核一次即可。

**教训**：帧构造里「手挑字段 spread」是漏字段模板——payload 字段与帧字段同名时应整体透传，让类型系统当透传面的 SSOT；复用既有 RPC 的副作用（applyRoleModel）时必须核对其完整推送契约（谁推 `session_model`），任何新路径改 session 状态都要与 UI 同步成对出现。

### BUG-049: SSH 测试报错既看不懂又复制不了——Windows OpenSSH 八进制转义外泄 + toast 承担了不可抄的诊断

**现象**：欢迎页远程连接对话框点「测试」，弹出的失败文本形如 `\350\202\226\351\211\264\346\235\276@10.147.17.244: Permission denied (publickey,...)`；文本 2.2 秒自动消失，且无法选中复制。

**分诊**：三缺陷叠加——(1) **编码**：Windows OpenSSH 把诊断里的非 ASCII 字节逐个转义成字面 `\NNN`（mprintf 保持诊断 ASCII-safe），底座与桌面都不还原，用户看到的是八进制而非自己的中文用户名；Git 自带 ssh 同样如此，非本机 ssh.exe 版本问题。(2) **截断**：`ssh_test_host` 把 stderr `.slice(0, 300)`，Windows 私钥权限告警的 `@@@@` 横幅 + 前 5 行就吃掉 300 字符，真正的失败原因（`Load key ...: bad permissions`）被整段切掉。(3) **承载**：失败走 `toast(...)`，而 `#toast` 是 `white-space: nowrap` + 2.2s 自动隐藏 + 无 `user-select`，且 `z-index: 400` 低于 Radix 对话框遮罩的 1000——它在对话框打开时本就压在遮罩下，即使没超时也读不到。

**根因**：(1)(2) 在 `host/rpc/ssh.ts` 取原始 stderr 后直接当 UTF-8 用；(3) 把「需要用户读并粘贴的诊断」当成了瞬时通知——toast 的契约是「一句话、不需要留存」，与 ssh 错误的诉求正交。

**修复**：(1) 新增 `decodeSshOctalEscapes`，把**连续的**转义段还原成字节再按 UTF-8 解码（必须整段：一个汉字 = 3 个转义字节，逐个解码会让续字节单独校验失败；`\000` 这类口令提示填充字节丢弃）；非法 UTF-8 序列回退保留字面文本，不吐 U+FFFD。(2) 抽出 `formatSshError` 统一「解码 + CRLF 折叠 + 尾截断」，上限 3000（覆盖最长的 `@` 横幅 + 权限说明）；未截断原文经 `safeStderr` 落宿主日志（新增边界边 `rpc/ssh.ts→stderr.ts`）。(3) `RemoteDialog` 改内联 `.rd-result` 面板：`user-select: text`、最大高度 220px 内滚、带「复制详情」按钮逐字复制，成功/失败靠左边框 `--green`/`--err` 区分，不再用 toast。

**验证**：真实目标端到端（走宿主 WS RPC，不是模拟）——`ssh_test_host` 与 `add_remote_workspace` 两条失败路径的 `error` 字段均为可读中文用户名 + 完整 `Permission denied` 行，宿主日志另有未截断副本；`bun run smoke:ssh-result` 17/17（走真实 UI 路径：欢迎页 → 项目胶囊 → `#wbProjRemote` → 对话框 → 落失败帧 → 断言可选中/可复制/无 toast，成功态 data-ok=true）；`bun run check` 全绿；`bun run host:build` 通过。限制：冒烟用 happy-dom，`getComputedStyle` 可验证 `user-select` 计算值，但 WKWebView 上的真实拖选手感未人工复核。

**教训**：外部进程的 stderr 是**不可信字节流**，不是「拿来 trim 一下就能显示的字符串」——先按字节解码再做截断，截断要在解码之后（否则切一半的多字节序列会碎）；连续转义是「一个逻辑字符」的边界，不能逐 token 解码。承载面也要对：toast / snackbar / badge 装不下「需要留存、需要选中、需要粘贴」的诊断，这类内容该有自己的可复制容器——`user-select` 缺失和 z-index 低于父遮罩是两类独立缺陷，会各自让错误不可读。

### BUG-050: 缓存保活自移植起从未布防过——嵌入式宿主只调 initialize 不发 session_start，扩展 config 恒为空靶标默认值

**现象**：实验功能页开了缓存保活、靶标已配置，但上下文明细卡保活段「下次运行」恒为「已暂停」，探测计数恒 0，`~/.omp/cache-keepalive/probe-log.jsonl` 从未产生。turn 完整结束后、用户无任何操作时同样如此。

**分诊**：②确认存量缺陷——8110d48 移植当天起即坏，BUG-043（catalog id 错配）修的是真问题但被这个更上游的断链完全掩盖：`isTargetModel` 在 config 加载之前就死了，靶标格式对不对根本轮不到判。

**根因**：嵌入式 SDK 宿主必须自己派发 `session_start`——SDK 内只有模式层会发（TUI 的 extension-ui-controller/runtime-init.ts:212、ACP 的 acp-agent.ts:2644、print/rpc/task 模式的 initializeExtensions）。桌面宿主 session-lifecycle.ts:634 照抄了 ACP 的 `runner.initialize(...)`（注释自称 same as acp-agent.ts:2631）却漏抄了它紧随其后的 `await emit({ type: "session_start" })`。keepalive 扩展的 config 只在 session_start handler 里从 omp-desktop.json 加载；事件永不到达 → config 恒为 `DEFAULT_PROBE_CONFIG`（targets=[]）→ `isTargetModel` 恒 false → capture 永不建立 → `armed()` 恒 false → agent_end 从不布防 → nextProbeAt 恒 null。UI 的 enabled:true 来自 entry 的初始零值快照（注入开关开着就有），与扩展是否真的初始化无关，掩盖了断链。

**修复**：`host/session-lifecycle.ts` attachEntry 的 initialize 之后补 `emit({ type: "session_start" })`，用 `entry.extSessionStarted`（host/state.ts PoolEntry 新字段）守卫——attachEntry 在池复用/前端重连时会重跑，重复派发会重置扩展状态（keepalive 丢 capture 清 timer）。

**验证**：全隔离复现台（OMP_PROFILE=omp-desktop-test + models.yml 自定义 mock provider + 本地 https 自签 mock 服务，宿主带 NODE_TLS_REJECT_UNAUTHORIZED=0 以过探测的 https-only endpoint 守卫）——修复前：turn 完整跑完（mock 收到真实请求）而 active 恒 false、150s 零布防；修复后：capture 建立（active:true）→ agent_end 布防（nextProbeAt=+30s）→ onTick 到点 → 探测真实发出（mock 收到 probe 请求、probes 1→2、hits 1→2）→ 30s 循环持续重排。`bun run check` 全绿。

**教训**：照抄上游某个调用点的「仪式」时要抄完整条链——SDK 的 initialize 和 session_start emit 是配对的（三个模式层全都 emit），只抄一半就是静默半死状态；「开关开了 + UI 有渲染」不等于扩展初始化过（entry 初始快照就能撑起 enabled:true）。调试此案的关键手法：给宿主开 PI_KEEPALIVE_DEBUG、在 isTargetModel/before_provider_request 入口加一次性诊断行，一条 `[diag] target miss: targets=[...]` 直接把断链钉在 config 加载层。

