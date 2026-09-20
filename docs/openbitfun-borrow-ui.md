# OpenBitFun UI 侧借鉴报告（面向 ui/ 层）

> 依据：2026-09-20 对 `/Users/xys/Github/openbitfun`（下称 OBF）源码与文档的实读核查，引用路径相对该仓库根。
> 我方现状：原生 Web（无框架）、v12 已拆 19 个 ESM 模块、token 体系（`ui/tokens.css` 125 行）+ AGENTS.md「设置页一致性规范」（人肉约束）、设置页 pg-* 系列、docs/PITFALLS.md。
> 结论先行：**U1 颜色/token 审计门禁是性价比最高的一项——把已有的 AGENTS.md 规范变成机器执行的 CI；U2 设置页声明式清单次之；U3/U4 是交互细节的即取即用；U5 是文档纪律；U6 外观包系统现阶段明确不做，但「data-* 属性契约」思想可以先占位。**

---

## U1. 颜色 / token 审计门禁：把「设置页一致性规范」变成机器执行（最高优先）

### 1.1 OBF 的机制（自写脚本体系，非 stylelint）

**入口编排**：`scripts/audit-frontend-colors.mjs`（859 行）读注册表 `scripts/frontend-color-surface-registry.json`（每个 UI surface：id/owner/root/audit 引擎 + exclusions + generatedChecks）。`package.json` 暴露 `theme:color-audit` / `theme:color-audit:all`；CI 两步：先跑审计脚本的 node:test 自测，再跑全量审计，fail 即 `process.exitCode = 1` + GitHub annotation。

**raw color 检测 = 纯正则扫描**（`theme-css-var-contract.mjs:88-100`）：

- 模式集：`#RGB/#RRGGBB/#RGBA/#RRGGBBAA`（负向断言排除 HTML 实体）、`rgba()/hsla()` 函数、147 个 CSS 命名色；三种上下文（CSS 声明值、SVG/HTML color 属性、JS 对象 `color:` 字符串字面量）。
- 扫描扩展名：`.css .html .js .mjs .svg .ts .tsx .webmanifest` 等。
- 同时检测：`var(--x, fallback)` 带兜底即 fail（掩盖缺失 token）、未注册的 `--openbitfun-*` 变量、宿主变量重定义、生成 bundle 漂移（byte 级比对）。

**ratchet 型 baseline**（`scripts/theme-color-governance-baseline.json`）：

```json
{ "version": 1,
  "description": "Lower values when debt is removed; do not raise without a documented review reason.",
  "budgets": { "colorScopes.appUi.occurrences": { "max": 0 }, ... },
  "allowlists": { ... } }
```

关键语义：**实际值 > max 报错，实际值 < max 也报错**（要求你把 baseline 降下去）——基线只准降不准升。另有 3 个 surface 用 `policy: "canonical-ui-zero"` 直接强制 27 个指标为 0，不走基线。

**例外三层**，全部要求给出 owner + reason（reason ≥24 字符，太短直接 fail）：
1. 路径例外（monaco/terminal/mermaid 等内嵌渲染器）；
2. registry 级 `exclusions[]`；
3. 窄域 `rawColorOwners[]`（仅限 bespoke-theme/data-viz 等类别，可精确到源码内 startMarker/endMarker 区间 + 行正则；**零匹配的 owner 判 stale 也 fail**——防止例外条目变成僵尸）。

### 1.2 对我们的落地（成本最低、收益最直接）

我们已有：token 体系（--panel-*/--line*/--accent/--err…）+ AGENTS.md 明令「禁止硬编码十六进制」。缺的就是机器执行。**最小版脚本 `scripts/audit-ui-colors.mjs`（预计 100-150 行）**：

1. **检测项**（对应我们规范逐条）：
   - `ui/**/*.css` 与 `ui/*.js` 中的 hex/rgb/hsl 字面量（排除 `ui/tokens.css` 本身——它是唯一 token 定义点，对应 OBF 的 CSS 变量定义权锚定在 design-tokens 包）；
   - `var(--x, fallback)` 兜底写法（我们的 token 全部已定义，兜底只会掩盖拼写错误——记忆里已有教训：`--focus/--ctl-hover/--font-mono` 未定义曾被误用）；
   - 引用未定义变量：收集 `tokens.css` 定义的 `--*` 全集，扫全部 `var(--...)` 引用做 diff。
2. **baseline JSON**（`scripts/ui-color-baseline.json`）：初跑时把现状计进 budgets；此后 ratchet——新增 raw color 直接 fail，清偿债务时脚本提示降 baseline。
3. **例外**：`ui/fa-icons.js` 是生成物（svg path 内的颜色）、`app-icon.png` 类资产——注册表里声明 `{id, path, reason}`，reason 必填。
4. **跑法**：先手动 + pre-commit 可选；不急着上 CI（我们还没有 CI），`.local/` 或 scripts/ 均可，关键是 agent 改 UI 时必须跑。

这一步的本质：**AGENTS.md 的「设置页一致性规范」从给 agent 看的散文，变成对人对 agent 都强制的门禁。**

---

## U2. 设置页声明式清单：pg-* 页的注册表化

### 2.1 OBF 的机制

- **场景壳**：`src/web-ui/src/app/scenes/settings/settingsRegistry.ts`，每页一个 manifest：

```ts
SettingsPageManifest = { id, categoryId, labelKey, descriptionKey,
  keywords[], namespaces[], searchPhrases[], views[], load(): lazy import }
```

页 id 形如 `application.general` / `application.appearance`。
- **页面组件四件套**：`<Name>.tsx + <Name>.scss + <Name>.appearance.ts + <Name>.test.tsx` 扁平放 `infrastructure/config/components/`，约 30+ 组。
- **布局原语**：`ConfigPageLayout / ConfigPageHeader / ConfigPageSection / ConfigPageRow / ConfigMessage`——每行 = `ConfigPageRow(label, align) + 受控输入`，输入件来自统一组件库（Select/Switch/NumberInput）。
- **搜索消费链**：生成的前端目录 JSON（含 `searchAcceptance` 验收用例——给定 query 断言首个命中项）被 global-search 静态 import；命中后按 `destination.kind` 分发（settings → 打开对应页）。

### 2.2 对我们的落地

我们的等价物：`ui/settings/` 目录 + 各 `pg-*` 页 + `.tg/.sel/.inp/confirm-btn` 控件语言。**建议最小版**：

1. `ui/settings/registry.js`（或 JSON）：每页一条 `{id, title, icon, controls: [{type: 'tg'|'sel'|'inp', tokenRef}]}`。
2. 用它驱动两件事：设置页左侧导航（现在大概率是 hardcode）与页内搜索/跳转（若有）。
3. 配合逻辑报告 L1 的能力清单：设置页 registry 的每页 id 与 host 侧 capability id 对齐（OBF 的 destination.pageId 思想），UI 跳转与 Agent 命令共用同一坐标系。
4. 生成校验可选：脚本扫 `ui/settings/*.css` 里实际定义的 `.pg-*` 页与 registry diff。

**不抄**：lazy import 路由（我们页面量级不需要）、.appearance.ts（见 U6）。

---

## U3. 分组错误展示：校验失败 ≠ 一条 toast

### 3.1 OBF 的机制

外观包校验失败时：

- **错误对象预分组**：`AppearanceValidationIssue = {path, code, message, context: {surfaceKind, surfaceId, partId, allowedParts}}`；`groupAppearanceValidationIssues()` 按 `component:<id>` / `scene:<id>` / `section:<name>` 聚合，构造时冻结成只读 groups。
- **UI 形态**（AppearancePackageFailurePanel）：外层 `<section role="alert">` + 计数提示；体内每组一个子 section（「组件 X / 场景 Y」标题 + 逐条 issue + `<code>path</code>`），组尾折叠展示 `allowedParts` 合法清单（帮作者自查）。
- **面板管详情、toast 管提醒**：同时只发一条计数摘要 toast，不逐条弹。
- 错误码约 90 个（INVALID_*/UNKNOWN_*/UNSUPPORTED_*/CIRCULAR_*），每类有专属文案映射。

### 3.2 对我们的落地

即取即用的场景：MCP 连接失败列表（多 server 多错误）、skills 加载失败、设置保存校验。形态贴合我们现有语言：

- 用 `.mem-expand` 行内延展（符合 AGENTS.md「禁模态」规范）承载分组面板：每个失败对象一组，组内逐条 `错误码 + 路径 + 摘要`；
- toast 只报「N 项失败，展开查看」；
- 错误对象结构直接抄 `{path, code, message, context}` 四字段——host 侧错误透传时就这么拼，ui 不用二次解析字符串。

---

## U4. 交互性能：流式渲染与长列表的即取即用件

### 4.1 OBF 的机制（03-interaction-fluency.md + 实现核实）

**「已做对、勿回退」清单要点**（对我们适用度标注）：

| OBF 实践 | 实现 | 对我们 |
|---|---|---|
| 流式事件合批：文本 32ms / 其他 100ms 上限，`setTimeout→rAF` 两段式 flush，同 key 事件 accumulate/replace，flush 超 10ms 告警 | EventBatcher.ts | ⭐ 直接适用：chat.js 流式 append 目前逐事件插 DOM，可按同款参数合批 |
| 自适应打字机：基速 90 字/s，积压每字符 +2、上限 720；每 paint 最小 16ms 间隔 + 字符硬上限，防全量重解析 | useTypewriter.ts | ⭐ 若做流式 markdown 渐显可直接抄参数；respect prefers-reduced-motion 同样要 |
| 虚拟化：消息列表从 react-virtuoso 迁到 @tanstack/react-virtual——理由是**行高差异大（38px~5012px）时，逐项高度估计 + 按 key 缓存测量**远胜单标量 lastSize；prepend 历史不移动已测量项 | FLOWCHAT_VIRTUALIZATION.md | ⭐ 核心洞察可抄：我们的消息行高差异同样巨大；若自研虚拟化，「测量按 key 缓存」是关键 |
| 内容分组做虚拟行：以 round（回合）为虚拟行、回合内工具卡折叠，高度按数据形状估算（文本/思考/工具族分类估算器） | virtualItemHeightEstimators.ts | ⭐ 与我们 turn_end 收起 loop 组同构——折叠态高度可预算，正是虚拟化可行的前提 |
| PTY/终端输出直写 xterm 绕过 React、键入合并批量 IPC（macOS 逐键 invoke 会丢字符） | ConnectedTerminal.tsx | 我们无终端，但「高频外部输出直挂 DOM、不经状态机」的原则适用于工具输出预览 |
| follow-output 是唯一连续写 scrollTop 的角色 | VirtualMessageList.tsx 头注释 | ⭐ 防滚动打架：我们多来源滚动（自动到底/用户滚动/行号滚顶）应收敛到单一 owner |
| Monaco worker 化、mermaid 动态 import、diff 有界且 completed 后算一次、无全局 `* transition` | 各文件 | markdown.js 的 mermaid/highlight 类重渲染同款原则 |

**报告方法论本身**（发现总览表列：`# | 问题 | 位置 | 用户可感知影响 | 收益`；F1-F16；任务表 T1-T17 含验收标准）见逻辑报告 L6。

### 4.2 对我们的落地顺序

1. **流式 append 合批**（chat.js）：rAF + 32ms 上限，同 key accumulate。工具行/文本分别处理。预计 1 天，收益最直观（长输出时主线程占用下降）。
2. **滚动所有权收敛**：审一遍现有 scrollTop 写点，自动跟随逻辑独占化 + 「有余量才显隐」（v13 已做一半）。
3. **消息历史虚拟化**（远期）：先落「折叠态高度可预算」这个前提——loop 组收起后的汇总行高度固定，天然是虚拟化的友好形态。

---

## U5. 「已做对、勿回退」清单：零成本纪律

OBF 用一张两列表（已有优化 | 位置）防止后人好心重构拆掉性能基线。我们已有大量同款资产散在记忆与 PITFALLS.md，值得集中一节并持续追加，候选首批：

- placeMenu() 除以 zoomLevel 补偿界面缩放；
- turn_end 同构重建历史 loop 组（汇总行 + usage）；
- 读取标签 → 文件页整文件展示 + reqRange 行号高亮；
- 隐藏窗口 timer 节流四征判别法；
- 探针法 DOM 断言（窗口不可见时的 GUI 验证正解）；
- app-icon 打包后系统自动规范化 80.5%（源图勿加边距）。

维护位置：docs/PITFALLS.md 新开一节，或独立 `docs/perf/dont-regress.md`。

---

## U6. 外观包系统与 data-* 属性契约：现阶段不做，先占两个思想位

### 6.1 OBF 的机制（摘要，供将来检索）

- **边界**：外观包 = ZIP + `appearance.json`（schema v2），只含强类型数据（~110 个结构化样式属性：颜色/盒模型/多层背景/动效枚举），禁 CSS 字符串、DOM 选择器、JS、外部 URL、可执行资源；值是结构化对象（`{kind:'hex', ...}`）而非字符串，从根上杜绝注入。
- **契约**：组件侧手写 `data-openbitfun-component/part/variant/state` 属性（全库 3858 处、226 个组件 id，无 helper）；宿主 Registry 冻结 descriptor（parts 白名单属性 + visualRole + states）；**选择器只由宿主编译器生成**（`:root[data-openbitfun-appearance="id"][data-openbitfun-appearance-revision="N"] [data-openbitfun-component=...][data-openbitfun-part=...]`）——外观包永远摸不到实现 class。
- **安全底线**：`display:none/visibility/pointer-events` 不属于外观能力，包不能隐藏交互入口或改事件语义。
- **事务激活**：新 `<style>` 先 append → renderer adapter 逐个 commit（每个包 {commit, rollback}）→ 翻转 revision 属性（所有选择器 revision-scoped，翻转即全量切换）→ 删旧 style；任一步失败逆序回滚 + 恢复配置持久化，全败则 status='degraded' 保留 lastError。
- **编译期内置 lint**：对比度 <3:1 警告、循环引用 throw、override 越权属性降级警告。

### 6.2 对我们的判断

我们的主题 = tokens.css 单文件 + 深浅双主题，没有第三方外观扩展需求，**整套系统是负资产**。但两个思想值得先占位：

1. **「选择器只由宿主生成」**：将来若做用户自定义主题/皮肤，接受的数据形态应是「token 值覆盖表」（`{"--accent": "#..."}` 级别的强类型数据），而不是任何 CSS 片段。我们的 token 体系天然支持这个边界。
2. **「结构性属性做钩子」**：我们现有 DOM 若逐步补上 `data-ui-component="..."` 类稳定属性，将来任何主题/测试/自动化断言都不再依赖易变的 class 名。不必现在全量铺（OBF 也是手写 + AST 校验保证一致性），但在改到某块 DOM 时顺手加上即可，成本近零。

---

## 优先级与成本总结

| 项 | 价值 | 成本 | 建议时机 |
|---|---|---|---|
| U1 颜色审计脚本 + baseline | 高（规范变门禁） | 1 天 | **立即** |
| U5 勿回退清单 | 中高 | 半天 | 立即（纯文档） |
| U4.1 流式 append 合批 | 高（可感知流畅度） | 1 天 | 下一轮 chat.js 迭代 |
| U3 分组错误面板 | 中 | 1 天 | MCP/skills 错误展示改版时 |
| U4.2 滚动所有权收敛 | 中 | 半天 | 同上窗口 |
| U2 设置页 registry | 中 | 1-2 天 | 设置页再次扩张前 |
| U4.3 消息虚拟化 | 中 | 3-5 天 | 长会话卡顿成为实际投诉后 |
| U6 外观包 | — | — | 明确不做；data-* 属性顺手加 |

---

## 与逻辑报告的交叉引用

- 设置页 registry（U2）与 host 能力清单（逻辑报告 L1）共用同一 id 坐标系；
- 「勿回退」清单（U5）与性能审计三件套（逻辑报告 L6）同属文档纪律，建议一次整理；
- 颜色审计（U1）与 L5 边界脚本可放进同一个 scripts/ 目录与检查入口。
