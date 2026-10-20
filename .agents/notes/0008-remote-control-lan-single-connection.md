# ADR-0008: 局域网远程控制——host 内第二服务 + 分通道顶号 + 事件双流 + 持久化访问密钥

**Status**: Accepted(2026-10-16,同日修订:单连接顶号 → 分通道顶号 + 事件双流,见 Revision)
**Decider**: 用户(桌面端)
**Informed by**: 本会话代码核查(host/main.ts、session-lifecycle.ts、ui-src/store/ws.ts、Composer 压缩阶梯)与编译产物静态读盘探针实验(2026-10-16)

## Context(背景)

需求:向局域网开放一个端口,手机/其他电脑浏览器打开即得本应用的远程控制界面。桌面浏览器看到与当前应用一致的主页;手机窄屏一次只显示一栏(默认中栏,可切左/右栏);远程端无设置页、不允许修改设置。

已核查的事实约束:

- host 现有 `Bun.serve`(`host/main.ts:70`)为 Tauri 专用:动态端口、`activeWs` 单槽 last-connection-wins(`:80`),**旧连接无人通知、无人关闭**(2026-10-16 scout 全仓确认)。
- 会话事件在 `attachEntry`(`host/session-lifecycle.ts:324-717`)中以闭包捕获单个 ws;`entry.attachedWs` 单槽。第二个客户端仅连接不偷事件;发 `load_session` 时走 `:851-853` 先 `unsubscribe()` 再重挂,无泄漏。多连接广播需重构这组闭包为扇出集合,是最大改造面。
- UI `ws.onclose` 无条件自动重连(`ui-src/store/ws.ts:87-91`,退避封顶 3s 无限次):若 host 只踢人不加门控,被踢端 3s 内自动重连顶回新端,形成互顶循环。
- 编译产物(`scripts/build-host.ts`)内 `import.meta.dir` 为虚拟路径 `/$bunfs/root`,不可读盘;`process.execPath` 为真实路径,从 exe 旁相对定位读文件已经探针实验验证可行(2026-10-16)。Tauri 把 host-dist 的**内容**铺进 Resources 根(`src-tauri/src/lib.rs:117-135` 在 resource_dir 直找 omp-host);`ui/dist` 经 frontendDist 内嵌进 Tauri 主程序,磁盘上不存在。
- 远程是 http 明文 + 非 secure context:手机浏览器麦克风/Clipboard API 不可用,语音类功能在远程端必须隐藏。
- Composer 已有按宽度分 5 级压缩的阶梯(`Composer.tsx` `fit()` + `ui/css/main/composer.css:426-437` 的 `.bar-1..5`),手机端压缩可续档而非新造。

## Decision(决策)

1. **远程服务 = host 内第二个 `Bun.serve`(新模块 `host/remote.ts`)**:固定可配端口(默认 16800),绑定 `0.0.0.0`;fetch 只处理两件事——静态文件(ui/dist)与 `/ws` upgrade;upgrade 后复用与主服务相同的 open/message/close 处理与 `dispatchRpc`,会话池/模型目录天然共享。主服务(Tauri,动态端口)完全不动。
2. **分通道顶号 + 事件双流(2026-10-16 修订,原「单连接顶号」作废)**:顶号按通道隔离——本地槽 `activeWs` 与远程槽 `activeRemoteWs` 各只留一个连接,新 open 只踢本通道旧值(`kicked` 帧 + close 4001)。远程接入永远不顶本地桌面,本体与远控同时在线。会话事件流改双流:`attachEntry` 拆为每条目一次的 `subscribeEntryCore`(全部发送点扇出到 `entry.uiSockets`)加每 ws 的 `attachEntryUi`(subagent view/快照/进行中审批重放);`load_session` 复用分支只给未订阅的 ws 补挂。前端收到 `kicked` 帧或 onclose code 4001 → 置 `kickedByOther` 标志、**跳过重连**、显示「连接已被另一设备接管」提示与「重新接管」按钮;点击才重连(把对方顶回,形成显式人为接力)。审批卡片双端可见,先到 `approval_response` 者得;plan 流程派生的新会话挂主 UI。
3. **固定鉴权**:首次开启远程时生成 128-bit 随机访问密钥并持久化进 omp-desktop.json `remote.accessKey`(§Spec 3.1,非 settings.values);WS upgrade 在 `fetch` 里以 `?t=` 查询参数校验(`timingSafeEqual`),失败返回 401 不升级。静态页面不校验(无敏感数据)。密钥明文存储(与 models.yml 凭据同级假设),设置页显示完整 URL、提供「重新生成」一键作废旧 key。URL 进入页面后 key 存 localStorage 并 `history.replaceState` 抹掉 query。
4. **远程端只读化 = UI 隐藏 + host denylist 双保险**:upgrade 通过时 `srv.upgrade(req, { data: { remote: true } })` 打标(启用现有死泛型);`dispatchRpc` 对 remote 连接拒绝设置/凭据/扩展/profile 写操作(显式集合 `REMOTE_WRITE_DENYLIST`);UI 以 `!window.__TAURI__` 判定远程模式,不渲染设置页与入口。
5. **静态资源随包分发**:平台 resources 配置(`src-tauri/tauri.macos.conf.json` / `tauri.windows.conf.json`)以 **map 形式**加 `{"../ui/dist": "ui/dist"}`——Tauri v2 中 `../` 开头的数组条目会被映射到 `$RESOURCE/_up_/...`,map 形式才能把内容落进 `Resources/ui/dist`(与 omp-host 同级,后者正是靠 map 形式空目标 `{"../host-dist": ""}` 摊平到 Resources 根);host 定位:编译态(`import.meta.dir` 以 `/$bunfs` 开头)取 `dirname(process.execPath)/ui/dist`,dev 态(`import.meta.dir = <repo>/host`)取 repoRoot/ui/dist。代价:ui/dist 在 bundle 内存在两份(frontendDist 内嵌 + resources 拷贝),安装包体积约多一份静态资源,接受。
6. **手机端 = 响应式单栏**:viewport ≤768px 时 `App` 只渲染 `mobileCol` 指定栏(默认 main,底部 tab 切 left/main/right),两个 resizer 隐藏,侧栏/右栏变全宽;composer 压缩阶梯 `BAR_STAGES` 5→7 续档(bar-6: 三个 pill 全 icon-only;bar-7: 藏 plan pill 与 mic/screen 钮);远程模式语音按钮不渲染;index.html viewport 加 `viewport-fit=cover, interactive-widget=resizes-content`,底栏/composer 垫 `env(safe-area-inset-bottom)`。**(2026-10-17 更新:底部 tab 已移除,改为 ZCode 式单页导航 —— 远程默认会话列表,点会话进会话页,header 返回回列表,右栏以抽屉打开;见 spec §4.3。)**

字段级契约与验收矩阵见 Spec:[docs/architecture/remote-control-spec.md](../../docs/architecture/remote-control-spec.md)。

## Consequences(后果)

**正面**:
- 传输层零协议改造:同一 `dispatchRpc` 与会话池,远程端能力 = 桌面端能力(除设置写)。
- 远程之间仍互顶(同时只许一个远控),但本体永不被顶、远控时本体正常运行——桌面 + 手机协同(手机批准、桌面观看)可用。
- 鉴权一次配对长期使用;「重新生成」即风控。

**负面**:
- 事件双流把 attachEntry 的单 ws 闭包改为扇出集合(~20 个发送点),漏切一个发送点即该帧只到一端;probe-remote 矩阵 4 的 rename→双端 title 帧断言兜底核心路径,其余路径靠代码评审。
- 审批/询问卡双端可见但先到者得:另一端卡片残留到下次刷新(host 仅对**新挂载**的 UI 重放进行中审批,已挂载端不会收到「已被对方答掉」的撤销帧)。
- plan 流程派生的新会话挂主 UI(先连端),远程端不会自动出现该会话的 session_created,需刷新侧栏。
- http 明文:LAN 嗅探者可截获 key 与内容;判定局域网风险可接受,不上自签证书。
- bundle 内 ui/dist 两份:frontendDist 内嵌 + resources 拷贝,安装包体积约多一份静态资源;接受,未选「bun file loader 内嵌进 omp-host exe」方案(见备选表)。
- 远程端可发 prompt、可批准工具调用 = 完全会话控制能力;key 泄露即机器控制权泄露。

**风险/不确定性**:
- `kicked` 帧与旧端 onclose 存在竞态:帧未达即断。以 close code 4001 兜底,双保险;真机/弱网验证归 Spec 验收。
- 手机软键盘:页面布局固定不动,底部输入栈(`.composer-stack`)作为 fixed 层按 `visualViewport` 的键盘重叠量(`--kb`)上浮,`#stream` 以 `--stack-h + --kb` 预留可滚动空间;聚焦放大由「渲染后字号不低于 16px」消除(`max(16px, 16px / --ui-zoom)`)。仍待 iOS Safari / Android Chrome 真机验收。
- 打包布局:resources 落位已由 map 形式规则判明(`{"../ui/dist": "ui/dist"}` → `Resources/ui/dist`);余量为首次打包实测验证一次,若 Tauri 行为有出入只改 host/remote.ts 编译态定位一处。

## Alternatives Considered(备选方案)

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 多连接广播(activeWs/attachedWs 改集合扇出) | 两端同时在线,手机批准桌面观看可用 | attachEntry 十余个闭包改扇出 + unsubscribe 单槽拆分,改造面最大;漏切一个发送点即静默不更新 | **2026-10-16 修订后已选**:用户实测单连接顶号把本地本体也顶掉,要求本体共存;改造面按 core/per-ui 拆分落地(见 Revision) |
| 复用主 WS 服务(动态端口)兼做静态/远程 | 不增服务 | 端口每次启动变,远程无法书签化;localhost 通道混入 token 分支,污染 Tauri 主链路 | 固定端口是远程可用性前提;双服务隔离更干净 |
| 每次启动随机 token | 泄露窗口小 | 每次重启都要重新扫码/输址 | 用户明确否决:要固定鉴权 |
| ui/dist 以 bun file loader 内嵌进 omp-host exe | 零 resources 改动 | exe 体积随前端产物膨胀;前端每次改动需重编 host | frontendDist 流水线已存在,resources 拷贝更笨更稳;编译产物读盘已探针验证 |
| mDNS/Bonjour 广播(omp.local) | 免看 IP | 引入发现层依赖与平台差异 | 用户拍板:先绑 0.0.0.0,IP 用户自理,发现机制暂缓 |

## Revision 2026-10-16(分通道顶号 + 事件双流)

用户实测:远程浏览器一接入,本地桌面立即显示「此应用已被人接管」被顶掉。原决策 2 把本地客户端也当普通连接顶,与需求(只能一人远控、但远控时本体正常运行)矛盾。修订:

- **顶号分通道**:`activeWs`(本地)与 `activeRemoteWs`(远程)两槽(`host/state.ts`),`ws-shared` open 按 `ws.data.remote` 选槽踢人;close 清各自槽。
- **事件双流**:`attachEntry` 拆三分——入口幂等(首挂 core)、`subscribeEntryCore`(每条目一次,~20 个发送点全部经 `entryBus` 扇出到 `entry.uiSockets`)、`attachEntryUi`(每 ws:subagent view + 池快照 + 进行中审批帧重放)。`PoolEntry.attachedWs` 改为 `uiSockets: Set` + `uiSubViews: Map` + `coreAttached`。`load_session` 复用分支不再 unsubscribe→重挂,只给未订阅 ws 补挂。ws close 时按会话摘除,最后观察者离开才收 core。
- **全局推送**(models/session_list/automations/settings 等 6 处)经 `eachUiWs` 双槽扇出。
- **审批竞态**:双端同见审批卡,先答者得;未答端卡片残留到下次刷新(不作撤销帧)。denylist 不动。
- **验收**:probe-remote 矩阵 4 新增 6 断言(本体不被顶 + rename 双端 title 帧双流),43 项全绿;远程-远程互顶旧断言不变。

## Related(关联)

- Spec:[docs/architecture/remote-control-spec.md](../../docs/architecture/remote-control-spec.md)
- 顶号/重挂载行为调查:2026-10-16 scout 报告(本会话,结论已并入上文 Context)
- 机器资源与测试 profile 红线:根 AGENTS.md(本特性冒烟全程 `OMP_PROFILE=omp-desktop-test`)
