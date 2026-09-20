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
