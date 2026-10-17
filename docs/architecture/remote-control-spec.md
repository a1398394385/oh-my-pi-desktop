# 局域网远程控制 · 实施 Spec

> **Status**: Implemented(2026-10-16) · 矩阵 1-10 已过(矩阵 11 真机项待手动)
> **审阅结论**: READY(2026-10-16 复审 R1)——首轮 4 个硬反例(denylist 漏网 30+、配置存储介质、resources `_up_` 规则、RPC 注册门禁)已全部修订入文档并逐条复核。
> **决策 SSOT**: [ADR-0008](../../.agents/notes/0008-remote-control-lan-single-connection.md)

## 1. 目标与非目标

**目标**:
1. 桌面端开启「远程控制」后,局域网设备浏览器访问 `http://<本机IP>:<port>/?t=<key>` 即得本应用界面,能力等同桌面端(发 prompt、批准、浏览会话与右栏)。
2. 桌面浏览器访问 = 当前应用主页;viewport ≤768px = 单栏(默认中栏,底部 tab 切左/中/右)。
3. 分通道顶号:远程连接之间互顶(同时只许一个远控),但远程接入**不顶**本地桌面——本地本体与远程端可同时在线;被顶的远程端看到「已被接管」提示且不自动重连,可手动「重新接管」。
4. 远程端无设置页,设置/凭据/扩展/profile 写操作在 host 侧按连接拒绝。
5. 鉴权固定:一次生成、持久化、可一键重置的访问密钥。

**非目标**:
- 不做跨通道顶号:远程连接永远不顶本地桌面(本体与远控共存,事件双流);同一通道内仍是单连接。不做 mDNS/IP 发现(绑 0.0.0.0,IP 用户自理);不做 https/自签证书。
- 远程端不提供语音/STT(http 非 secure context,麦克风不可用),语音按钮远程不渲染。
- 不改 Tauri 主 WS 服务(动态端口、无 token、行为不变)。
- 远程端对 `open_folder`/`open_with` 等本机动作不做限制(属会话能力,非设置)。

## 2. 术语表

| 术语 | 定义 |
|---|---|
| 主服务 | 既有 `Bun.serve`(host/main.ts,动态端口,Tauri 专用) |
| 远程服务 | 新增 `host/remote.ts` 的第二个 `Bun.serve`(固定端口,0.0.0.0) |
| 访问密钥 | `remote.accessKey`,128-bit 随机,持久化于 profile 设置 |
| 顶号 | 分通道:本地槽(`activeWs`)与远程槽(`activeRemoteWs`)各只留一个连接;新 open 只踢本通道旧值:发 `kicked` 帧 + close code 4001 |

## 3. host 契约

### 3.1 配置项(omp-desktop.json 顶层 `remote` 段)

存储介质:**omp-desktop.json**(per-profile),经 `writeDesktopSection("remote", …)` 落盘,完整先例 `writeKeepaliveConfig`(`host/keepalive-config.ts:288` → `host/desktop-json.ts:65` read-modify-write)。**不走 `settings.values`**——底座注册表(`registry.ts`)无 remote 键、host 侧无 register 先例,`settingsSet` 对未注册键无效。

| 段.字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `remote.enabled` | bool | false | 开机(profileReady 后)自启远程服务 |
| `remote.port` | number | 16800 | 监听端口 |
| `remote.accessKey` | string | 开启时生成 | 128-bit hex;`remote_regenerate_key` 重置 |

### 3.2 新 RPC(本地/远程均可调;均不在 denylist——配置远程本身不算"修改设置"禁区,由设置页驱动)

| RPC | 载荷 | 应答 | 行为 |
|---|---|---|---|
| `set_remote_config` | `{enabled?: bool, port?: number}` | `{type:"remote_config", enabled, port, error?: string}` | 启停/换绑远程服务;端口占用等失败在 `error` 返回且服务保持原状;成功后推 settings 帧 |
| `remote_regenerate_key` | 无 | `{type:"remote_key", key}` | 重新生成 `remote.accessKey` 并持久化;旧 key 立即失效(新连接校验不过;已连上的不断开) |

**注册门禁(两道,缺一不可)**:`scripts/check-capabilities.mjs` 双向 diff 要求每个新 handler key 登记进 `host/capabilities.json`(`methods[].id` + 合法 `kind`),wire 一致性要求同步 `host/wire/requests.ts:11-38` 的 `HostRequestMethod` union。漏任一处 `bun run check` 即红。

### 3.3 远程服务 fetch 行为(host/remote.ts)

| 请求 | 处理 |
|---|---|
| `GET /ws`(Upgrade 头) | 校验 `?t=`(`crypto.timingSafeEqual` 比 `remote.accessKey`);失败 → `401` 不升级;成功 → `srv.upgrade(req, {data:{remote:true}})` |
| `GET /` | 200 `index.html` |
| `GET /<path>` | dist 内文件 200;规范化后越出 dist(路径穿越)→ 400;不存在 → 404 |
| 其他方法 | 405 |

- 静态根定位:按存在性探测而非字符串判据——先 `dirname(process.execPath)/ui/dist`(编译分发态;`tauri.*.conf.json` 让 ui/dist 与 omp-host 同级),不存在再回落 `import.meta.dir/../ui/dist`(dev 态)。**禁止用 `import.meta.dir` 前缀判编译态**(BUG-082):POSIX 虚拟根由 `/$bunfs/root` 变为 `/$$bunfs/root`,Windows 编译态则是 `B:\~BUN\root`,字符串判据在安装版必失效并回落到不存在的虚拟路径,表现为整站 404。
- 打包分发:平台 resources **map 形式**加 `{"../ui/dist": "ui/dist"}`(`src-tauri/tauri.macos.conf.json` / `tauri.windows.conf.json`)。Tauri v2 中 `../` 开头的**数组**条目会落 `$RESOURCE/_up_/...`,map 形式才落 `Resources/ui/dist`(与 omp-host 同级);写错形式远程静态服务必 404。
- upgrade 后的 open/message/close 与主服务共用同一组处理(ready 握手、`dispatchRpc`);不因来源分叉协议。

### 3.4 顶号(分通道,主服务与远程服务共用 open 逻辑)

`open(ws)`:`ws.data.remote`(upgrade 时打标)决定槽位——远程连接只占远程槽 `activeRemoteWs`,本地连接只占本地槽 `activeWs`。槽内已有旧连接且 ≠ 当前 ws → 向旧 ws 发 `{type:"kicked"}`、`ws.close(4001, "kicked")`,然后占位。远程接入因此永远不顶本地桌面;同一通道内仍是单连接(第二个远控浏览器顶掉第一个)。

`close(ws)`:两个槽各自比对清槽;并把该 ws 从每个池条目的 `uiSockets` 摘除(其 subagent view 一并退订,最后一个观察者离开时 `entry.unsubscribe()` 收掉 core 订阅)。

**事件双流(本体共存的前提)**:会话事件的 core 订阅(`subscribeEntryCore`,session-lifecycle.ts)每个池条目只挂一次,所有发送点扇出到 `entry.uiSockets`——本地与远程打开同一会话时两端都实时收到事件。`load_session` 复用分支只给**未订阅**的 ws 补挂,不再先 unsubscribe 转移订阅。审批卡片双端可见:先到 `approval_response` 者得,另一端卡片残留到下次刷新(host 会把进行中的审批帧重放给新挂载的 UI);plan 流程派生的新会话挂到主 UI(先连者),审批卡本身仍双端可见。

### 3.5 远程写操作 denylist

`dispatchRpc`(host/rpc/index.ts)在 `ws.data?.remote === true` 时拒绝下表,返回 `{type:"error", message:"remote read-only"}`。集合集中在 `host/remote.ts` 导出 `REMOTE_WRITE_DENYLIST: ReadonlySet<string>`。

**圈集依据**:`host/capabilities.json`(160 条,与 handler 表双向 diff 由 `scripts/check-capabilities.mjs` 守门)。写操作定义 = 改 profile 磁盘态 / 外部凭据 / 扩展与资产 / 设置值 / 会话与项目的持久态。2026-10-16 复审后按域全量圈定:

| 域 | RPC |
|---|---|
| settings.ts(18) | `set_setting` `set_locale` `set_ui_prefs` `set_external_browser` `set_computer_provider` `set_computer_default` `set_approval_mode` `set_acp_enabled` `set_acp_config` `set_session_context_enabled` `set_keepalive_enabled` `set_keepalive_config` `set_kimi_auto_thinking` `set_hooks_enabled` `set_plugins_enabled` `set_skills_enabled` `set_desktop_env` `switch_profile` |
| models.ts(2) | `set_enabled_model` `set_model_role` |
| provider-wizard.ts(2) | `save_provider_models` `save_provider_model` |
| login.ts(10) | 全部:`provider_login` `provider_logout` `provider_list_accounts` `provider_disable_account` `provider_enable_account` `provider_reorder_account` `provider_login_cancel` `provider_set_key` `login_prompt_reply` `open_models_config` |
| assets.ts(11) | `asset_file_write` `asset_file_create` `asset_skill_toggle` `asset_plugin_toggle` `asset_skill_delete` `toggle_extension_item` `toggle_extension_provider` `toggle_extension_user_source` `set_mcp_server_enabled` `save_mcp_server` `delete_mcp_server` |
| automations.ts(4) | `automations_create` `automations_update` `automations_delete` `automations_toggle` |
| ssh.ts(3) | `ssh_save_host` `ssh_remove_host` `add_remote_workspace` |
| session.ts(11) | `set_session_pinned` `archive_session` `set_project_expanded` `add_project` `remove_project` `reorder_projects` `delete_session` `rename_session` `compact_session` `branch_session` `fork_session` |

**明确放行(远程会话能力所需,边界项)**:`create_session` `load_session` `mark_seen` `navigate_tree`;`git_*` / `bash_exec` / `terminal_*` / `open_folder` / `open_with` / `stt_*` / `browser_*` / `ui_error` 等会话与本机能力不在表(见 §1 非目标)。

**表外特例 `reload_settings`**:仅从磁盘重读模型设置到内存并回推 models/settings 帧,无任何持久化副作用,且是 UI 打开会话的标准伴随调用(`openSessionByPath` 每次发)——列入表会让远程端点开任意会话即弹 "remote read-only"(BUG-078),故放行。

**约定**:新增写操作类 RPC 必须同步入表(在 remote.ts 注释写明);实施时跑一遍 capabilities 双向 diff 复核,复核结论写进 commit message。

## 4. UI 契约

### 4.1 远程模式判定与连接(ui-src/store/ws.ts)

- `REMOTE = !invoke && !preview`(`?preview=1` 的 ui:dev 样例页除外,不连)。远程模式下 WS 地址 = `ws(s)://location.host/ws?t=<key>`;key 来源:URL `?t=`(首次)→ 存 localStorage → `history.replaceState` 抹掉 query;无 key 时显示密钥输入占位(简单全屏表单,提交即跳带参 URL)。
- 收到 `{type:"kicked"}` 或 onclose `code === 4001` → `kickedByOther = true`、**不** `scheduleReconnect`;由 App 顶层挂载整页接管屏 `KickedScreen`(全屏遮罩卡片:警示图标 + 「设备接管」pill + 标题/说明 + 下一步列表 + `Relay 返回 / KICKED` 状态框 + 主按钮「重新连接」),覆盖列表/会话/面板任一页;点击按钮置 false 并 `connect()`(会顶掉当前持有者)。
- `connect()` 现有 `!invoke` 直接失败分支替换为上述远程分支。**注意**:现 `!invoke` 分支不排程重连(ws.ts:51-54),远程直连 URL 拿不到时会永久停在 noHost——远程分支必须自带退避重试(复用 `scheduleReconnect` 阶梯),仅下面 kicked 门控抑制重连。

### 4.2 设置隐藏(REMOTE 时)

`App.tsx` 不挂 `<Settings/>`;侧边栏/头部的设置入口不渲染;`openSettings` 置为 no-op。host denylist 为兜底(§3.5),UI 隐藏只是体验层。

### 4.3 单栏布局(≤768px,响应式,不看 UA)

导航模型对齐 ZCode 远程端(2026-10-17 改造,取代此前的底部三段 tab;右栏由浮动抽屉改为整页):

- store 增 `mobileCol: "left" | "main" | "right"`(默认:窄屏远程客户端 `"left"`,桌面窗口拖窄 `"main"`);`narrow` 由 matchMedia 监听(断点 768px)。
- `narrow` 时 `App.tsx` 只渲染一页:会话列表(`left`)、会话页(`main`)或右栏(`right`);`#left-resizer`/`#right-resizer` 不渲染。三页互斥替换,无浮动层、无底部常驻 tab。
- 导航入口:
  - 会话页 header 左端「返回」(`chevronLeft`)→ `mobileCol = "left"`;
  - 会话页 header 右端「面板」(`panelRight`)→ `mobileCol = "right"`;
  - 右栏 `sp-head` 左端「返回」(`chevronLeft`)→ `mobileCol = "main"`;桌面端的收起按钮窄屏不渲染。
- 会话列表是根页面:点击会话行 / 点「新建任务」/ 点项目「+」/ 搜索结果 / 定时任务 / `openSessionByPath` → `mobileCol = "main"`(SessionRow、Sidebar、SidebarSearch、ProjGroup、store/session.ts 统一)。
- 会话页(中栏)窄屏:隐藏消息 rail(`#msgRail`,`display:none`)——左侧 tick 竖条是桌面 affordance;消息列 / 输入卡 / 统计行取消居中列宽限制,改为左右各 12px 内边距拉满;`.chat-head` 左右 padding 12px;底部安全区由 `env(safe-area-inset-bottom)` 承担。
- 会话列表页(ZCode 任务首页样式,保留本仓 UI 语言):顶部 header 卡片(标题 + 右上角主题切换 / 缩放 `− 100% +`,无连接说明副标题);新建任务 / 定时任务 / 搜索并排一行三枚等宽按钮(`.ms-nav`,搜索按钮展开输入框并自动聚焦);视图固定为项目形式(`effView = narrow ? "project" : viewMode`,窄屏不渲染最近/归档 seg,也不改写 store,桌面端选择保持不变);每个项目与每个会话各自一张圆角卡片(`--panel-2` 底 + `--line-soft` 描边 + `r-md`);项目卡片内显示任务数(`sidebar.taskCountN`);项目展开的子会话卡片缩进 8px。远程客户端侧栏顶部内边距 10px(`.ms-remote`),macOS 桌面窄窗口保留 40px 红绿灯避让。
- 右栏整页:与中栏同一卡片几何(`margin: var(--shell-gap) 12px`),内部 `sp-head` 全宽;空态即 `StartPage`(打开标签页列表)。主题/缩放偏好属本地态:远程端 `saveTheme` 不发送 `set_ui_prefs`(否则触发 denylist 的 remote read-only),主题取 localStorage 本地值,首次访问才采纳 host 设置;缩放经 `applyZoom` 在页面切换后重新落到新挂载的列上。
- 窄屏隐藏桌面专用控件:侧栏收起按钮(`.side-collapse`)、`⌘N` 快捷键提示、header 的收起/展开面板按钮、项目/分支 chip(`.chat-head .head-chip`)。
- **作用域**:本节所有手机端改造(单页导航、卡片列表、两行统计、右栏 tab 三枚后横向滚动、左栏紧凑导航行)只在 `narrow`(≤768px)生效;桌面端(≥769px)保持原三栏布局与 desktop 主页一致 —— stats 单行 + 容器查询裁剪(`@media (min-width:769px)` 包裹),右栏 tab 恢复 `flex: 1 1 0; min-width:56px` 等宽压缩。
- 新样式域 `ui/css/main/remote.css`,`style.css` 的 `main/` 域段内 import(**不挂真正末尾**:末尾是四套主题覆盖,`style.css:85` 注释确立「主题覆盖必须在末尾」的约定;remote.css 是布局规则,应被主题压过,不能反向覆盖主题变量)。

### 4.4 Composer 窄屏压缩

- `BAR_STAGES` 5→7;新档 CSS 续 `.bar-1..5` 既有命名。**非纯 CSS 改动**:`Composer.tsx` 两处必须同改——`:73` `BAR_STAGES` 常量 5→7,`:724` `fit()` 的 `classList.remove("bar-1",…,"bar-5")` 列表补 bar-6/7(否则新档永远加不上、旧档类清不掉):
  - `.bar-6`:mode/think/model 三 pill 全 icon-only(藏全部 label 与 caret;model 用既有 `#modelIcon` 先例,另两个补等价图标);
  - `.bar-7`:藏 plan pill 与 `planSep`、藏 mic/screen 图标钮。
- `remote.css` 窄屏补充:composer 卡片 padding 收紧;编辑区字号 ≥16px(防 iOS 聚焦放大);cbar 允许 `flex-wrap` 兜底换行;底部 tab 与 dock 垫 `env(safe-area-inset-bottom)`。
- REMOTE 时 mic(语音)按钮不渲染;`voiceMode` 订阅结果在 REMOTE 下视为 false。

### 4.5 index.html

viewport meta 改为 `width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content`。

### 4.6 设置页「远程控制」组(仅本地可见)

风格遵循根 AGENTS.md 设置页一致性规范(`.srow.set-row` + `.tg` 开关 + `.inp` + `.save-btn`):开关行(启用)、端口行(数字输入+保存)、密钥行(脱敏显示 + 复制 URL + 「重新生成」危险钮)、状态行(监听中/错误文案来自 `remote_config.error`)。全部文案走 `ui-src/i18n` 语言包,禁止硬编码中文。

## 5. 验收矩阵

全程 `OMP_PROFILE=omp-desktop-test`;host 侧集成进新 `scripts/probe-remote.ts`(仿 probe-extensions 模式,真 host WS 断言),UI 侧用 happy-dom 冒烟先例(scripts/smoke-computer-permission.tsx 模式)。

| # | 场景 | 验收 |
|---|---|---|
| 1 | 无 `?t=` / 错误 key 连 `/ws` | 返回 401,无 upgrade,无 ready 帧 |
| 2 | 正确 key 连 `/ws` | 收到 ready 帧;`list_sessions` 正常应答 |
| 3 | 远程连接发 `set_setting`/`set_approval_mode`/`delete_session` 等 denylist RPC | error 帧;`get_settings` 复查值未变 |
| 4 | 第二连接(任意来源)open | 远程接入后**本地**未收 `kicked`、RPC 仍可用(本体不被顶);两端打开同一会话时事件帧双端到达(双流);第二个**远程**连接 open 时旧远程连接收到 `kicked` 帧且 close code=4001,被顶端 UI 显示接管提示、3s 后仍未重连(无互顶);点「重新接管」后新端被顶 |
| 5 | 静态服务 | `GET /` 200 且为 index.html;存在资产 200;`GET /../host/main.ts` 400;不存在路径 404 |
| 6 | 设置页开关/换端口 | 开启→端口监听(WS 可连);关闭→连接被拒;换端口→新端口生效旧端口释放;占用端口→`remote_config.error` 非空且原状态不变 |
| 7 | `remote_regenerate_key` | 应答新 key;旧 key 升级被拒;profile 设置持久化(重启 host 后新 key 仍有效) |
| 8 | 窄屏(≤768px 模拟) | 远程客户端默认会话列表页;点会话/新建任务进入会话页;header 返回回列表;面板按钮开右栏抽屉、遮罩或 ✕ 关闭;无底部 tab;无横向滚动 |
| 9 | Composer 逐级压窄 | bar-1..7 依次生效;最窄档剩 `+`、icon-only pills、ctxRing、send;不出现按钮溢出/重叠 |
| 10 | 回归 | Tauri 桌面端既有冒烟(`smoke:react` 及现有 probe)全绿;桌面 WS 无 token 要求、行为不变 |
| 11 | 真机手动项(不计入自动冒烟) | iOS/Android:软键盘弹出 composer 不被顶飞出视口;聚焦不整页放大;锁屏回前台自动重连;安全区不遮底栏 |

## 6. 实施顺序(建议)

1. `host/remote.ts`(静态 + token + upgrade 打标)+ 主/远程 open 顶号 + denylist → probe-remote.ts 覆盖矩阵 1-7。
2. `ui-src/store/ws.ts` 远程连接分支 + kicked 门控 + 接管提示 → happy-dom 冒烟覆盖矩阵 4。
3. 设置页「远程控制」组 + `set_remote_config`/`remote_regenerate_key` 接线 → 矩阵 6、7。
4. 单栏布局 + 底部 tab + remote.css → 矩阵 8。
5. Composer bar-6/7 + 窄屏适配 + index.html viewport → 矩阵 9。
6. 打包态验证:resources 落位 + 编译产物静态服务(矩阵 5 在 release 布局复跑)+ 真机矩阵 11。

## 7. 风险与开放问题

- **顶号竞态**:host 发 `kicked` 后立即 close,旧端可能收不到帧;close code 4001 兜底。probe 断言两者至少其一到达。
- **Resources 落位**:平台 resources 用 map 形式 `{"../ui/dist": "ui/dist"}` 后按 Tauri v2 规则落 `Resources/ui/dist`(数组形式的 `../` 条目会落 `$RESOURCE/_up_`,已排除);首次打包仍实测验证一次。若 Tauri 行为有出入,只改 host/remote.ts 的编译态定位一处。
- **denylist 完备性**:§3.5 已按 capabilities.json 全量圈定(51 项 + login.ts 10 项,共 61 项,`reload_settings` 表外特例见 §3.5);边界取舍(`create_session`/`load_session`/`mark_seen`/`navigate_tree` 放行)若日后收紧,只改 remote.ts 一处。新增写操作类 RPC 的约定 = 必须同步入表(在 remote.ts 注释写明)。
- **互顶回归**:任何让 `connect()` 在 kicked 后自动重试的改动都会复活互顶循环;kicked 门控是行为契约,改 ws.ts 重连逻辑前先读本节。
