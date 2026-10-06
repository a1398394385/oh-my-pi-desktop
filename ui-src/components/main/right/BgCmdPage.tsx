// Background commands page: aggregates session items (hub start/stop pairing + running
// bash/shell/eval) + list + inline expand cards.
// In the old version any global repaint collapsed expanded rows (DOM rebuild); in the React
// version the expanded state is held by component state, so streaming updates keep rows open
// and show the latest output (the liftEl collapse animation is skipped along with the
// conditional rendering).
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../store";
import { t } from "../../../i18n";
import Icon from "../../../Icon";
import { Spin } from "../../chat/parts";

// Session items entry (loose view of the store session structure; to be replaced by the exact
// discriminated union once types/session.ts converges)
interface SessionItemLike {
  role?: string;
  name?: string;
  text?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- host tool args are an open dict (keys vary by tool kind), a genuinely unknown boundary
  args?: Record<string, any>;
  output?: string;
  details?: unknown;
  running?: boolean;
  toolCallId?: string;
}

// Aggregated background task entry
interface BgTask {
  id: string;
  toolCallId?: string;
  op: string;
  procName: string;
  command: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above: host tool args are an open dict
  args: Record<string, any>;
  output: string;
  details?: unknown;
  running: boolean;
  statusText: string;
  cwd?: string;
  timeIndex: number;
  rawItem: SessionItemLike;
}

// Aggregate a session's background tasks: hub tool calls (start/stop/cancel paired by process
// name) + running terminal commands
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
        statusText: t("right.bgDone"),
        cwd: args.cwd || s.cwd,
        timeIndex: i,
        rawItem: it,
      };

      // Task liveness depends only on start/stop/cancel pairing. Don't fall back to
      // it.running: that means "the hub tool is executing" (between the tool frame and
      // tool_update), which list/status also hit — not process liveness
      if (op === "start") {
        taskItem.running = true;
        taskItem.statusText = t("right.bgRunning");
        if (procName) liveProcesses.set(procName, taskItem);
      } else if (op === "stop" || op === "cancel") {
        taskItem.running = false;
        taskItem.statusText = t("right.bgStopped");
        if (procName && liveProcesses.has(procName)) {
          const started = liveProcesses.get(procName)!; // assertion: get always hits after the has check
          started.running = false;
          started.statusText = t("right.bgStopped");
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
        statusText: t("right.bgRunning"),
        cwd: s.cwd,
        timeIndex: i,
        rawItem: it,
      });
    }
  }

  const runningCount = tasks.filter((t) => t.running).length;
  tasks.reverse(); // newest on top
  return { tasks, runningCount };
}

export default function BgCmdPage() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const [openId, setOpenId] = useState<string | null>(null);
  if (!s) {
    return <div className="py-3 text-faint text-ui-base">{t("right.noActiveSession")}</div>;
  }
  const { tasks } = getBgTasksForSession(s);
  if (tasks.length === 0) {
    return <div className="py-3 text-faint text-ui-base">{t("right.noBgCommands")}</div>;
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
                  {task.procName || task.command || t("right.bgCommandFallback")}
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

// Expand card: meta row (op/name/status/collapse) + working directory + command or args + output
function BgCmdExpand({ task, onClose }: { task: BgTask; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="bgcmd-expand">
      {/* 1. Card head / meta row */}
      <div className="bgcmd-meta-row">
        <span>
          <b>{t("right.opLabel")}</b> {task.op}
        </span>
        {task.procName && (
          <span>
            <b>{t("right.nameLabel")}</b> {task.procName}
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
          {t("right.collapse")}
        </button>
      </div>
      {task.cwd && (
        <div className="bgcmd-meta-row" style={{ fontSize: "var(--ui-fs-xs)" }}>
          <span>
            <b>{t("right.workDirLabel")}</b> <span className="path" title={task.cwd}>{task.cwd}</span>
          </span>
        </div>
      )}
      {/* 2. Command line and args */}
      {task.command ? (
        <>
          <div className="bgcmd-meta-row" style={{ marginTop: "8px" }}>
            <b>{t("right.commandInputLabel")}</b>
          </div>
          <div className="font-mono text-[length:var(--code-fs,12px)] bg-panel-2 border border-line-soft rounded-sm py-2 px-2.5 my-1.5 overflow-auto whitespace-pre-wrap break-all text-text leading-[1.5] overscroll-contain" /* style-token-ignore */>{task.command}</div>
        </>
      ) : task.args && Object.keys(task.args).length > 0 ? (
        <>
          <div className="bgcmd-meta-row" style={{ marginTop: "8px" }}>
            <b>{t("right.argsLabel")}</b>
          </div>
          <div className="font-mono text-[length:var(--code-fs,12px)] bg-panel-2 border border-line-soft rounded-sm py-2 px-2.5 my-1.5 overflow-auto whitespace-pre-wrap break-all text-text leading-[1.5] overscroll-contain" /* style-token-ignore */>{JSON.stringify(task.args, null, 2)}</div>
        </>
      ) : null}
      {/* 3. Output and execution result */}
      <div className="bgcmd-meta-row" style={{ marginTop: "8px" }}>
        <b>{t("right.outputLabel")}</b>
      </div>
      <pre className="max-h-[180px] overflow-y-auto overscroll-contain bg-card border border-line-soft rounded-sm py-2 px-2.5 mt-1.5 font-mono text-[length:var(--code-fs,12px)] text-dim whitespace-pre-wrap break-all" /* style-token-ignore */>{task.output || (task.running ? <Spin /> : t("right.noOutput"))}</pre>
    </div>
  );
}
