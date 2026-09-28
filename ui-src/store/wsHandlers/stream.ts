// 会话运行态域帧：审批卡、事件流重建、本地 bash、斜杠命令输出、子代理流、
// 待办/goal/排队、上下文用量与统计、错误落地。自 store/ws.ts onMessage 平移。
import { useAppStore } from "../index";
import {
  applyDelta,
  applyEvent,
  applySteerConsumed,
  findBySessionId,
  notifyDesktop,
  rebuildMessages,
  updateSession,
} from "../session";
import type { HandlerSlice } from "./types";

// 工具行文件清单去重（subagent_event 的 tool_update 分支用）
function uniqueFiles(files: string[] | null | undefined): string[] {
  return [...new Set(files ?? [])];
}

export const streamHandlers = {
  plan_mode(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.planMode = !!msg.enabled;
      },
      false,
    );
  },
  approval_request(msg) {
    updateSession(msg.sessionId, (s) => {
      s.pendingApprovals ??= [];
      s.pendingApprovals.push({
        requestId: msg.requestId,
        title: msg.title,
        options: msg.options,
        editable: !!msg.editable,
        prefill: msg.prefill ?? "",
        answer: null,
      });
    });
    const s = findBySessionId(msg.sessionId);
    if (s) notifyDesktop("approval", s, "等待审批", msg.title);
  },
  approval_resolved(msg) {
    useAppStore.setState((st2) => {
      const openSessions = new Map(st2.openSessions);
      for (const [p, s] of openSessions) {
        if (s.pendingApprovals) {
          openSessions.set(p, { ...s, pendingApprovals: s.pendingApprovals.filter((request) => request.requestId !== msg.requestId) });
        }
      }
      return { openSessions };
    });
  },
  event(msg) {
    applyEvent(msg);
  },
  messages(msg) {
    rebuildMessages(msg);
  },
  // ---- 输入框 sigil：本地 bash 执行帧（! 前缀，宿主 bash_exec 驱动） ----
  bash_start(msg) {
    updateSession(msg.sessionId, (s) => {
      s.items.push({ role: "bash", text: msg.command, output: "", running: true, excludeFromContext: !!msg.excludeFromContext });
    });
  },
  bash_chunk(msg) {
    const s = findBySessionId(msg.sessionId);
    if (!s) return;
    const it = [...s.items].reverse().find((x): x is Extract<(typeof s.items)[number], { role: "bash" }> => x.role === "bash" && !!x.running);
    if (it) {
      // 流式输出合并渲染（与 text_delta 同款 100ms 节流:就地 mutate,窗口 flush 换引用）
      applyDelta(msg.sessionId, (next) => {
        const target = [...next.items].reverse().find((x): x is Extract<(typeof next.items)[number], { role: "bash" }> => x.role === "bash" && !!x.running);
        if (target) target.output = (target.output || "") + msg.chunk;
      });
    }
  },
  bash_done(msg) {
    updateSession(msg.sessionId, (s) => {
      const it = [...s.items].reverse().find((x): x is Extract<(typeof s.items)[number], { role: "bash" }> => x.role === "bash" && !!x.running);
      // bash_abort 会先收到一帧 cancelled:true 的 done，可能与正式 done 重复——
      // 以最后一次为准，第二次找不到 running 项时静默忽略
      if (!it) return;
      it.running = false;
      if (msg.error != null) {
        it.error = String(msg.error);
      } else {
        it.output = msg.output ?? it.output;
        it.exitCode = msg.exitCode ?? null;
        it.cancelled = !!msg.cancelled;
        it.timedOut = !!msg.timedOut;
        it.truncated = !!msg.truncated;
      }
    });
  },
  // 斜杠命令的文本输出（如 /model 的 Current model 回显）：落一条 meta 行
  command_output(msg) {
    updateSession(msg.sessionId, (s) => {
      s.items.push({ role: "meta", text: String(msg.text ?? "") });
    });
  },
  // 后台命令阶段行:start 插入执行中行;fail 撤该命令的执行中行。
  // 完成态不走瞬时帧:由落盘痕转出的 phase 行随 messages 重建到达(单一事实来源)
  command_phase(msg) {
    updateSession(msg.sessionId, (s) => {
      if (msg.phase === "start") {
        s.items.push({ role: "phase", phase: "start", command: msg.command, text: String(msg.text ?? "") });
      } else {
        const pending = s.items.findIndex(
          (it) => it.role === "phase" && it.phase === "start" && it.command === msg.command,
        );
        if (pending >= 0) s.items.splice(pending, 1);
      }
    });
  },
  // 斜杠命令被宿主本地消费：撤回乐观插入的 user 气泡（无 entryId 的最后一条同文本）
  command_result(msg) {
    updateSession(msg.sessionId, (s) => {
      if (msg.consumed) {
        for (let i = s.items.length - 1; i >= 0; i--) {
          const it = s.items[i];
          if (it.role === "user" && it.text === msg.text && !it.entryId) {
            s.items.splice(i, 1);
            break;
          }
        }
      }
    });
  },
  subagent_lifecycle(msg) {
    updateSession(msg.sessionId, (s) => {
      // 底座在结束时（completed/failed/aborted）会用同一 subagentId 重发 lifecycle——
      // 只更新状态保留累积内容，否则完成后详情被清空
      const prev = s.subagents.get(msg.subagentId);
      s.subagents.set(msg.subagentId, {
        agent: msg.agent,
        description: msg.description ?? "",
        status: msg.status,
        // host 补齐的派生字段：显示名 / 父 agent / 注册时刻
        name: msg.name ?? prev?.name,
        parent: msg.parent ?? prev?.parent,
        registeredAt: msg.registeredAt ?? prev?.registeredAt,
        text: prev?.text ?? "",
        tools: prev?.tools ?? [],
        streaming: msg.status === "started",
        // progress 帧累积的用量字段（lifecycle 重发时保留）
        usage: prev?.usage,
      });
    });
  },
  subagent_progress(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        // 聚合用量帧（host 已 500ms 节流）：成本/时长/请求/工具数/token/上下文/当前步骤
        const prev = s.subagents.get(msg.subagentId);
        if (!prev) return;
        prev.usage = {
          cost: msg.cost,
          durationMs: msg.durationMs,
          requests: msg.requests,
          toolCount: msg.toolCount,
          tokens: msg.tokens,
          contextTokens: msg.contextTokens,
          contextWindow: msg.contextWindow,
          currentTool: msg.currentTool,
          currentToolArgs: msg.currentToolArgs,
          currentToolStartMs: msg.currentToolStartMs,
          lastIntent: msg.lastIntent,
          resolvedModel: msg.resolvedModel,
          resolvedThinkingLevel: msg.resolvedThinkingLevel,
          recentTools: msg.recentTools,
        };
        if (msg.status) prev.status = msg.status;
        if (msg.name && !prev.name) prev.name = msg.name;
        if (msg.parent && !prev.parent) prev.parent = msg.parent;
        if (msg.registeredAt && !prev.registeredAt) prev.registeredAt = msg.registeredAt;
      },
      false,
    );
  },
  subagent_event(msg) {
    // 文本 delta 高频:就地 mutate + 100ms 窗口 flush(与主对话 text_delta 同款)
    if (msg.kind === "text_delta") {
      applyDelta(msg.sessionId, (s) => {
        const sub = s.subagents.get(msg.subagentId);
        if (sub) sub.text += msg.text;
      });
      return;
    }
    updateSession(
      msg.sessionId,
      (s) => {
        const sub = s.subagents.get(msg.subagentId);
        if (!sub) return;
        if (msg.kind === "turn_start") sub.streaming = true;
        else if (msg.kind === "tool") sub.tools.push({ name: msg.name, args: msg.args, files: msg.files, toolCallId: msg.toolCallId, running: true });
        else if (msg.kind === "tool_update") {
          const last =
            [...sub.tools].reverse().find((t) => t.toolCallId && t.toolCallId === msg.toolCallId) ||
            [...sub.tools].reverse().find((t) => t.name === msg.name);
          if (last)
            Object.assign(last, {
              files: uniqueFiles(msg.files ?? last.files),
              added: msg.added,
              removed: msg.removed,
              todo: msg.todo,
              output: msg.output ?? last.output,
              details: msg.details ?? last.details,
              diffContent: msg.diffContent ?? last.diffContent,
              running: false,
            });
        } else if (msg.kind === "turn_end") sub.streaming = false;
      },
      false,
    );
  },
  todos(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.todos = msg.phases ?? [];
      },
      false,
    );
  },
  goal(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.goal = msg.goal ?? null;
      },
      false,
    );
  },
  queued(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.queued = msg.followUp ?? [];
        s.steering = msg.steering ?? [];
      },
      false,
    );
  },
  steer_consumed(msg) {
    applySteerConsumed(msg);
  },
  context(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.ctx = { tokens: msg.tokens, window: msg.window, percent: msg.percent };
      },
      false,
    );
  },
  session_stats(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        // 整会话统计（host 在 turn 收尾与加载会话时推送）：输入框下方状态行常驻显示
        s.stats = {
          tokens: msg.tokens,
          cost: msg.cost,
          cacheHitRate: msg.cacheHitRate,
          advisorCost: msg.advisorCost,
          activeMs: msg.activeMs,
        };
      },
      false,
    );
  },
  context_detail(msg) {
    // ringpop 弹卡瞬态数据，CtxCard 订阅重绘（卡收起时更新不重建，移开即弃）
    useAppStore.setState((s) => ({ ctxDetail: msg }));
  },
  error(msg) {
    useAppStore.setState((s) => ({
      gitDiffCache: { ...s.gitDiffCache, loading: false },
      rightState: { ...s.rightState, sessionTreePending: false }, // 分支树请求失败解除挂起，下次渲染重拉
    }));
    // 设置中心资产/记忆读取失败的错误落地（旧版写 aeStatus / 记忆行内态）
    if (msg.kind) useAppStore.setState((s) => ({ assetErr: { kind: msg.kind!, message: msg.message, at: Date.now() } }));
    const md = useAppStore.getState().memoryDetail;
    if (md.status === "loading") {
      useAppStore.setState((s) => ({
        memoryDetail: { ...s.memoryDetail, status: "error", error: msg.message },
      }));
    }
    const sid = msg.sessionId;
    if (sid && findBySessionId(sid)) {
      updateSession(sid, (next) => {
        next.items.push({ role: "error", text: msg.message });
      });
    } else {
      useAppStore.getState().toast(msg.message);
    }
  },
} satisfies HandlerSlice;

// 域键集（供 index 的穷尽断言交叉验证）
export type StreamFrames = keyof typeof streamHandlers;
