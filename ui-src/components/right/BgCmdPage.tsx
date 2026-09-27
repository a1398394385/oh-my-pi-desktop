// 后台命令页：会话 items 聚合（hub 启停配对 + 运行中的 bash/shell/eval）+ 列表 + 行内展开卡。
// 原版任何全局重绘都会收起展开行（DOM 重建）；React 版展开态由组件 state 持有，
// 流式数据更新时保留展开并展示最新输出（liftEl 收起动画随条件渲染省略）。
import { Fragment, useState } from "react";
import { useAppStore } from "../../store";
import Icon from "../../Icon";
import { Spin } from "../chat/parts";

// 会话 items 条目（store 会话结构的宽松视图；精确判别联合由 types/session.ts 收口后替换）
interface SessionItemLike {
  role?: string;
  name?: string;
  text?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 宿主工具参数为开放字典（键随工具种类而变），真实不明边界
  args?: Record<string, any>;
  output?: string;
  details?: unknown;
  running?: boolean;
  toolCallId?: string;
}

// 聚合出的后台任务条目
interface BgTask {
  id: string;
  toolCallId?: string;
  op: string;
  procName: string;
  command: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上：宿主工具参数开放字典
  args: Record<string, any>;
  output: string;
  details?: unknown;
  running: boolean;
  statusText: string;
  cwd?: string;
  timeIndex: number;
  rawItem: SessionItemLike;
}

// 聚合会话内的后台任务：hub 工具调用（start/stop/cancel 按进程名配对）+ 运行中的终端命令
function getBgTasksForSession(s: { items?: SessionItemLike[]; cwd?: string } | null | undefined): {
  tasks: BgTask[];
  runningCount: number;
} {
  if (!s || !Array.isArray(s.items)) return { tasks: [], runningCount: 0 };
  const tasks: BgTask[] = [];
  const liveProcesses = new Map<string, BgTask>(); // procName -> taskRef

  for (let i = 0; i < s.items.length; i++) {
    const it = s.items[i];
    if (it.role !== "tool") continue;
    const name = it.name || it.text || "";
    if (name === "hub") {
      const args = it.args || {};
      const op = args.op || "cmd";
      const procName = args.name || args.application || "";
      let taskCommand = "";
      if (args.application) {
        const aList = Array.isArray(args.args) ? args.args : args.args ? [args.args] : [];
        taskCommand = `${args.application} ${aList.join(" ")}`.trim();
      } else if (args.command) {
        taskCommand = args.command;
      } else if (args.text) {
        taskCommand = args.text;
      } else if (procName) {
        taskCommand = procName;
      } else {
        taskCommand = `hub ${op}`;
      }

      const taskItem = {
        id: it.toolCallId || `hub_${i}`,
        toolCallId: it.toolCallId,
        op,
        procName,
        command: taskCommand,
        args,
        output: it.output || "",
        details: it.details,
        running: false,
        statusText: "已完成",
        cwd: args.cwd || s.cwd,
        timeIndex: i,
        rawItem: it,
      };

      // 任务存活态只看 start/stop/cancel 配对。不能回落到 it.running：那是「hub 工具
      // 执行中」（tool 帧到 tool_update 之间），list/status 之类同样命中，不是进程存活态
      if (op === "start") {
        taskItem.running = true;
        taskItem.statusText = "运行中";
        if (procName) liveProcesses.set(procName, taskItem);
      } else if (op === "stop" || op === "cancel") {
        taskItem.running = false;
        taskItem.statusText = "已停止";
        if (procName && liveProcesses.has(procName)) {
          const started = liveProcesses.get(procName)!; // 断言：has 判定后 get 必中
          started.running = false;
          started.statusText = "已停止";
          liveProcesses.delete(procName);
        }
      }

      tasks.push(taskItem);
    } else if (it.running && (name === "bash" || name === "shell" || name === "eval")) {
      tasks.push({
        id: it.toolCallId || `cmd_${i}`,
        toolCallId: it.toolCallId,
        op: "run",
        procName: name,
        command: it.args?.command || it.text || name,
        args: it.args || {},
        output: it.output || "",
        details: it.details,
        running: true,
        statusText: "运行中",
        cwd: s.cwd,
        timeIndex: i,
        rawItem: it,
      });
    }
  }

  const runningCount = tasks.filter((t) => t.running).length;
  tasks.reverse(); // 最新的排在上方
  return { tasks, runningCount };
}

export default function BgCmdPage() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const [openId, setOpenId] = useState<string | null>(null);
  if (!s) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">（无活跃会话）</div>;
  }
  const { tasks } = getBgTasksForSession(s);
  if (tasks.length === 0) {
    return <div className="py-3 px-2.5 text-faint text-ui-base">当前会话暂无后台命令</div>;
  }
  return (
    <div className="slist" style={{ padding: "4px 0" }}>
      {tasks.map((task) => (
        <Fragment key={task.id}>
          <div
            className={"srow bgcmd-row" + (openId === task.id ? " on" : "")}
            onClick={() => setOpenId(openId === task.id ? null : task.id)}
          >
            <span className={"bgcmd-dot" + (task.running ? " running" : "")} />
            <div className="stext">
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <b style={{ color: "var(--text)" }}>{task.op.toUpperCase()}</b>
                <span className="path" title={task.command || task.procName || ""}>
                  {task.procName || task.command || "后台命令"}
                </span>
              </div>
            </div>
            <span className={"bgcmd-meta-tag" + (task.running ? " running" : "")}>{task.statusText}</span>
            <span className="bgcmd-caret">
              <Icon name="caretSlim" />
            </span>
          </div>
          {openId === task.id && <BgCmdExpand task={task} onClose={() => setOpenId(null)} />}
        </Fragment>
      ))}
    </div>
  );
}

// 展开卡：元信息栏（操作/名称/状态/收起）+ 工作目录 + 命令或参数 + 输出
function BgCmdExpand({ task, onClose }: { task: BgTask; onClose: () => void }) {
  return (
    <div className="bgcmd-expand">
      {/* 1. 卡片头 / 元信息栏 */}
      <div className="bgcmd-meta-row">
        <span>
          <b>操作:</b> {task.op}
        </span>
        {task.procName && (
          <span>
            <b>名称:</b> {task.procName}
          </span>
        )}
        <span className="flex-1"></span>
        <span className={"bgcmd-meta-tag" + (task.running ? " running" : "")}>{task.statusText}</span>
        <button
          type="button"
          className="save-btn"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          收起
        </button>
      </div>
      {task.cwd && (
        <div className="bgcmd-meta-row" style={{ fontSize: "var(--ui-fs-xs)" }}>
          <span>
            <b>工作目录:</b> <span className="path" title={task.cwd}>{task.cwd}</span>
          </span>
        </div>
      )}
      {/* 2. 命令行与参数 */}
      {task.command ? (
        <>
          <div className="bgcmd-meta-row" style={{ marginTop: "8px" }}>
            <b>命令 / 输入:</b>
          </div>
          <div className="font-mono text-[length:var(--code-fs,12px)] bg-panel-2 border border-line-soft rounded-sm py-2 px-2.5 my-1.5 overflow-auto whitespace-pre-wrap break-all text-text leading-[1.5] overscroll-contain" /* style-token-ignore */>{task.command}</div>
        </>
      ) : task.args && Object.keys(task.args).length > 0 ? (
        <>
          <div className="bgcmd-meta-row" style={{ marginTop: "8px" }}>
            <b>参数:</b>
          </div>
          <div className="font-mono text-[length:var(--code-fs,12px)] bg-panel-2 border border-line-soft rounded-sm py-2 px-2.5 my-1.5 overflow-auto whitespace-pre-wrap break-all text-text leading-[1.5] overscroll-contain" /* style-token-ignore */>{JSON.stringify(task.args, null, 2)}</div>
        </>
      ) : null}
      {/* 3. 输出与执行结果 */}
      <div className="bgcmd-meta-row" style={{ marginTop: "8px" }}>
        <b>输出 / 响应:</b>
      </div>
      <pre className="max-h-[180px] overflow-y-auto overscroll-contain bg-card border border-line-soft rounded-sm py-2 px-2.5 mt-1.5 font-mono text-[length:var(--code-fs,12px)] text-dim whitespace-pre-wrap break-all" /* style-token-ignore */>{task.output || (task.running ? <Spin /> : "（无输出）")}</pre>
    </div>
  );
}
