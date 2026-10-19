# 前端子系统手册（ui-src + ui/）

> 活文档：跨文件链路地图 + 不可从代码直接推断的约定。登记见 [documentation.md](../documentation.md) §2「子系统手册」。
> 事实以代码为 SSOT；本手册只记入口、约束与坑。UI 视觉/控件约定见 [ui-conventions.md](ui-conventions.md)，开发与验证通道见 [DEVELOPMENT.md](../DEVELOPMENT.md)。

## 1. 一句话架构

Tauri 外壳加载 `ui/dist` 构建产物（入口 `ui/index.html`，由 `ui/style.css` + `ui-src/main.tsx` 组成），前端通过动态端口的主 WebSocket 连 Bun 宿主；`?preview=1` 只加载样例数据、不连 host，不是真机通道。

## 2. 文件地图

| 层 | 位置 | 职责 |
|---|---|---|
| HTML 入口 | `ui/index.html` | 只引 `style.css` 与 `../ui-src/main.tsx`；`#bootSplash` 静态启动遮罩 |
| 样式入口 | `ui/style.css` | 唯一 CSS 入口：Tailwind v4 base + 按级联顺序 `@import` 各域文件 |
| 样式实体 | `ui/css/global/`、`shared/`、`main/`、`settings/` | token/重置/全站控件/浮层；公共模型与代码视图；三栏布局与各页面；设置页外壳与子页 |
| 图标 | `ui/icons.js`、`ui/fa-icons.js`、`ui/lucide-icons.js`、`ui/file-icons.js` | 注册表与三层覆盖（FA 为生成物，禁止手改） |
| React 根 | `ui-src/main.tsx`、`ui-src/App.tsx` | 挂载、主题/缩放恢复、图标注册表引入 |
| 页面组合 | `ui-src/components/main/` | 左栏 `sidebar/`、中栏 `MainColumn.tsx`（`chat/` 消息、`tree/` 会话树、Agent Hub）、右栏 `right/` |
| 设置页 | `ui-src/components/settings/` | 全屏设置中心与 `pg-*` 子页 |
| 跨页控件 | `ui-src/components/shared/` | 模型选择、代码视图、子代理控件 |
| 状态 | `ui-src/store/` | 单一 zustand store，`index` 组合 ui/session/projects/right/settings/ws/models/entry-tree slice |
| 语言包 | `ui-src/i18n/` | 前端与宿主文案；规范见 `ui-src/i18n/README.md` |

## 3. 技术栈

React 19 + TypeScript + Vite 8 + Tailwind v4 + zustand。markdown 渲染 streamdown（cjk/code 插件，`chat/AssistantMsg.tsx`）；输入框 Lexical（`Composer.tsx` + `composer/lexical/`）；shadcn/Radix 基件在 `components/ui/`（`cn` = clsx + tailwind-merge）。

## 4. 样式约定（不可从代码推断的部分）

1. **未导入 Preflight**：Tailwind 只引 theme 与 utilities；border utility 需显式 border-style 语义。
2. **复合类语言保留 CSS 定义**（`.srow` `.pill-btn` `.tg` `.sel` `.inp` `.add-btn` `.confirm-btn` `.mem-expand` 及布局骨架），不要改写成 utilities。
3. **@import 顺序 = 级联顺序**：跨域移动文件或调整导入顺序必须验证渲染等价。
4. **公共规则唯一声明**，专属规则归对应页面；禁止在页面里写私有覆盖来绕过基类。

## 5. 状态约定（硬约束）

1. 组件一律 `useAppStore(selector)` 订阅；写入用 `setBump({...})`（setState 别名）或 slice action。
2. 容器（Map/Set/数组）变更必须换新引用，禁止原地 mutate。
3. selector 禁止返回新构造对象；需要组合时用 `useShallow`。
4. 禁止在 zustand `subscribe` 回调里 `set`（React 19 会死循环）。
5. 高频通道不经 zustand：终端帧总线 `terminal`、组展开通道 `groupExpand`。

## 6. 构建与验证入口

```bash
bun run ui:build       # 构建 ui/dist（Tauri dev 也读产物，无 HMR）
bun run ui:typecheck   # tsc --noEmit
bun run ui:dev         # 浏览器预览；?preview=1 仅样例，不连 host
bun run ui:watch       # 产物 watch，配合 CDP 连 Tauri dev 窗口
```

真机调试通道（`dev:browser` / CDP / 远程控制边界）与 profile 隔离见 [DEVELOPMENT.md](../DEVELOPMENT.md)。

## 7. 图标系统（操作手册）

1. **结构**：
   - `ui/icons.js`：注册表与取用入口；自定义图标（目前仅 `logo`）直接写在 `ICONS` 里，末尾 `Object.assign(ICONS, FA_ICONS)` 让 FA 层同名覆盖。
   - `ui/fa-icons.js`：**自动生成，禁止手改**；由 `.local/build-fa-icons.py` 从本机 Font Awesome 源码提取（FA Free 7.3.1，图标 CC BY 4.0）。
   - `.local/`：本地开发脚本目录，不入库，用法见其 `README.md`。
2. **取用（禁止内联 SVG 字面量）**：
   - JS：`icon("folder")` / `icon("caret", 12)`（第二参数覆盖尺寸，viewBox 不变）。
   - JSX：`<Icon name="folder" size={23} />`（`ui-src/Icon.tsx` 把注册表 svg 注入承载 span，`class`/`id`/`style`/`title` 透传）。
   - 动态图形（ctxRing 进度环、统计页图表）不是图标，现为组件内联渲染（`components/Composer.tsx`、`components/settings/stats/charts/`）。
3. **新增/换图标**：改 `.local/build-fa-icons.py` 顶部 `MAPPING`（注册表名 → FA 子目录/图标名/尺寸），跑 `python3 .local/build-fa-icons.py` 重新生成；FA 没有的自定义图标才写进 `ui/icons.js`。
4. **方向与状态语义**：
   - 可展开尖角一律用 `caret` 系列，方向与弹出方向一致：向上弹出的菜单默认尖角朝上、展开时旋转 180°；向下弹出的 `.sel` 默认朝下、展开时旋转。
   - 展开/收起图标随状态切换（`collapseLeft`/`collapseRight`，见 `ui-src/App.tsx`），React 侧由状态驱动重渲染。
   - 主对话区展开图标原地旋转（思考行 chevron 90°、工具行 `.ed-arrow` 90°、changebar `#chv` 180°），禁止换元素。
5. **引入方式**：`ui/icons.js` 顶部静态 `import` 三个层文件（fa / lucide / file-icons），层叠覆盖顺序固定在该文件内。

## 8. 已知死代码（待确认后删除，不参与注释优化）

`ui/markdown.js`、`ui/prov-logos.js`、`ui/prototypes/` 全仓无运行入口引用（仅文档与历史注释提及）；`ui/themes/` 仍被 `ui/style.css` 间接引用，需单独确认。删除批见 [comment-style.md](../comment-style.md) §8.2 W0。
