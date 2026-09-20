# 防回归铁律 (RULEs)

> 本文件列出本仓库"被破坏过"或"绕过代价极大"的规则。AI 改代码前**必须**先读本文件;review 时**必须**检查是否违反。
>
> 当前 3 条:体系随 [documentation.md §8](../docs/documentation.md) 建立于 2026-09-20,新 RULE 待真实事故或 Accepted ADR 背书后立入(判据:背书真实 + 可执行,见 §8「何时新增 RULE」)。

## 规则总览

| 编号 | 规则 | 影响范围 |
|------|------|---------|
| RULE-001 | 新增/修改工具标签必须同步扩展 host/translate.ts 的参数白名单与结果摘要 | 前端渲染 + 宿主转发 |
| RULE-002 | 新增内嵌滚动容器必须 `overscroll-behavior: contain`,装饰元素不得放进滚动节点内 | 全部 UI 样式 |
| RULE-003 | 渲染函数必须纯渲染,RPC 请求只能由视图入口/事件处理器发起 | 全部 UI 渲染 + RPC |

---

## 规则详情

### RULE-001: 新增/修改工具标签必须同步扩展 host/translate.ts 的两处转发白名单

**规则**:在 `ui/tool-labels.js` 给新工具加标签行(或改既有标签的摘要字段)时,必须同步检查并扩展 `host/translate.ts`:
1. `toolArgsForUi()` —— 按工具白名单放行参数,新工具不加分支则前端只收到 `{}/path/files/content`;
2. `summarizeResult()` —— 按工具提取 `output/details`,新工具不加分支则展开卡永远「(无输出)」。

**Why**:UI 标签三层数据链路「底座事件 → translate.ts 过滤 → 前端渲染」中,行能渲染 ≠ 有数据。BUG-001:新标签行渲染正常但展开卡全是 `{}` 与「(无输出)」,根因就是只改了渲染层。

**How to apply**:改 `ui/tool-labels.js` 时 grep `toolArgsForUi` 与 `summarizeResult`,确认新工具名在两处都有分支且字段与 UI 摘要一致;大参数(questions/memories 等)过 `capValue()`。review  checklist:标签行出现新工具名 ↔ translate.ts 同名词条成对出现。

**关联**:BUG-001

### RULE-002: 新增内嵌滚动容器必须 `overscroll-behavior: contain`,装饰元素不得放进滚动节点内

**规则**:给任何元素加 `overflow: auto/scroll` 使其可滚动时,必须同时判定它是否「内嵌」——祖先链上存在另一个滚动容器(本仓:`#stream`/`#rightBody`/`#setBody`/`#tasklist`/`#setNav`/`.welcome-screen` 等)即为内嵌,必须加 `overscroll-behavior: contain`。同时,装饰性元素(区域竖线、角标、装饰背景)必须用绝对定位伪元素等手段放在**外层非滚动节点**上,不得直接挂在滚动容器内。

**Why**:BUG-002 真实踩过两个坑,根因都是把滚动容器当成普通盒子:
1. scroll chaining——内嵌容器滚到顶/底后,剩余滚轮量与触控板惯性继续传给外层滚动区,用户滚一个小卡片却带动了整个会话流;
2. 绝对定位装饰(`.think-body::before` 竖线)属于滚动内容,随内容一起滚出视口。

**How to apply**:写 `overflow-y: auto` 时自问一句「它的祖先里有谁会滚?」——有 → 同行加 `overscroll-behavior: contain`;需要伪元素装饰 → 拆内层滚动节点,装饰留外层。豁免(不加):顶层滚动区(自身即区域唯一滚动层)、fixed 定位浮层菜单(无滚动祖先)、纯横向溢出容器(横向手势不会纵向传递)。review checklist:新增 `overflow(-y)?: auto|scroll` ↔ 相邻可见 `overscroll-behavior: contain` 或明确豁免理由。

**关联**:BUG-002

### RULE-003: 渲染函数必须纯渲染,RPC 请求只能由视图入口/事件处理器发起

**规则**:`render*()` 渲染函数体内禁止 `send(...)` 发 RPC 请求;数据拉取只能放在视图入口(按钮点击、页面激活、相关 done 消息处理器)发起。判据:若某消息 type 的响应处理器会调用渲染函数 R,则 R 体内不得发出触发该消息的请求——否则形成「渲染 → 请求 → 响应 → 再渲染」无限循环。

**Why**:BUG-003 真实事故——为让「已配置」徽标在登出后收敛,把 `send(get_all_providers)` 放进 `renderAddProviderView()`,而 `all_providers` 响应处理器也调用它,形成无限重绘:DOM 不断重建,hover 高亮闪烁、点击被吞。

**How to apply**:给渲染函数加请求前,先在 core.js grep 该消息 type 的响应处理器——若会调回本渲染函数,请求必须上移到入口。症状识别:UI hover 闪烁 + 点击无反应 ≈ 无限重绘。review checklist:渲染函数体内出现 `send(` ↔ 该消息的响应处理器不调回同一渲染函数。

**关联**:BUG-003
