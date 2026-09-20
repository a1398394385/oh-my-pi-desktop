# Issue tracker:本地 Markdown

本仓库使用本地 Markdown 跟踪 agent 可执行工作,不依赖外部 issue tracker。

## `/to-tickets` 约定

- 当前实施队列发布到仓库根目录 `tickets.md`
- ticket 按依赖顺序排列,每项显式声明 `Blocked by`
- 无 blocker 或 blocker 均完成的 ticket 构成当前 frontier
- ticket 的完成状态以验收条件 checkbox 为准
- agent 每次只接手一个 frontier ticket,完成验证后再进入下一个

## 其他本地 issue

需要独立保存的长期 issue 使用 `.scratch/<feature>/issues/<NN>-<slug>.md`。`tickets.md` 是当前实施队列,不替代长期 issue 历史。

## 队列执行纪律

> 源自 etower-agent CS2 队列复盘(一张验收票跨 3 个 agent、3+ 小时、近百万 token)的教训沉淀。发布队列与逐票接手时对照检查。

1. **Spec/队列发布前回答跨层接线问题**:凡引入新接缝(工具从哪拿 per-session 上下文、host 与 ui 的协议锚点在哪),Spec 审阅时必须有明确答案;没有就先补设计票,不带「开工后现设计」的票进队列。
2. **票绿即 commit**:focused 验证(冒烟/typecheck)通过后立即提交;commit 是回滚边界,批量补提交会让边界模糊。
3. **验证增量运行**:每完成一个可验证单元就跑一次;禁止产出从未运行过的大块改动再交接。
4. **adapter/外部系统票配真机冒烟**:mock 外部系统(omp SDK / Tauri IPC)的响应形状必须来自真机实测;实现与 mock 同源的测试恒绿但真机必挂。
5. **慢基础设施在首张相关票开工时启动**:镜像构建等慢操作一次性、带版本锁启动,不留到验收阶段才开始。
6. **上下文过半且剩整票时拆票或交接**:上下文打满后交接,接收方要重建全部状态;早交接小 scope 优于晚交接大 scope。
