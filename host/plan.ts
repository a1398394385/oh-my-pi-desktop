// 计划模式域：/plan 命令分发、plan_mode 状态帧、提案审批闭环（xd://propose）、
// 落盘 mode_change 恢复。审批/自动保存语义对齐底座 plan-mode（resolveApprovedPlan /
// autosaveApprovedPlan）；桌面差异 = 无 paused 中间态、审批走 requestApproval WS 桥。
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  resolveApprovedPlan,
  autosaveApprovedPlan,
  resolveLocalUrlToPath,
  normalizeLocalScheme,
} from "./bootstrap.ts";
import { pushCommandOutput, requestApproval, type PoolEntry } from "./state.ts";

const PLAN_MODE_NAME = "plan";
const PLAN_FILE_URL = "local://PLAN.md"; // 与 ACP 默认计划文件同址
const PLAN_APPROVE = "批准并执行";
const PLAN_REFINE = "继续修改";

/** 计划模式状态帧：UI 据此显示/隐藏权限胶囊右侧的「计划」退出按钮。 */
export function pushPlanMode(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry) {
  const state = entry.session.getPlanModeState();
  ws.send(
    JSON.stringify({
      type: "plan_mode",
      sessionId,
      enabled: state?.enabled === true,
      planFilePath: state?.planFilePath ?? null,
    }),
  );
}

/** local:// 计划文件的磁盘路径（对齐 ACP 的 #resolveAcpPlanFilePath） */
function planFilePathOnDisk(entry: PoolEntry, url: string): string {
  const normalized = url.startsWith("local:") ? normalizeLocalScheme(url) : url;
  return resolveLocalUrlToPath(normalized, {
    getArtifactsDir: () => entry.session.sessionManager.getArtifactsDir(),
    getSessionId: () => entry.session.sessionManager.getSessionId(),
  });
}

/** 读计划文件内容；不存在返回 null（resolveApprovedPlan 据此走兜底） */
async function readPlanContent(entry: PoolEntry, url: string): Promise<string | null> {
  try {
    return await Bun.file(planFilePathOnDisk(entry, url)).text();
  } catch {
    return null;
  }
}

/** 会话本地根下的计划文件（最新优先）：agent 丢了 extra.title 时 resolveApprovedPlan 的兜底 */
async function listPlanFilesOf(entry: PoolEntry): Promise<string[]> {
  try {
    const dir = planFilePathOnDisk(entry, "local://");
    const files = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && /plan\.md$/i.test(d.name));
    const stamped = await Promise.all(
      files.map(async (d) => ({ name: d.name, mtime: (await stat(path.join(dir, d.name))).mtimeMs })),
    );
    return stamped.sort((a, b) => b.mtime - a.mtime).map((f) => `local://${f.name}`);
  } catch {
    return [];
  }
}

// 提案处理器：agent 写 xd://propose 后由底座调用（返回的 tool result 回到模型侧）。
// 批准 → 记计划引用 + 自动保存计划 + 退出计划模式；驳回 → 保持计划模式继续打磨。
async function handlePlanProposal(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  title: string,
) {
  const state = entry.session.getPlanModeState();
  if (!state?.enabled) throw new Error("计划模式未激活");
  const { planFilePath, title: resolvedTitle } = await resolveApprovedPlan({
    suppliedTitle: title,
    statePlanFilePath: state.planFilePath,
    readPlan: (url: string) => readPlanContent(entry, url),
    listPlanFiles: () => listPlanFilesOf(entry),
  });
  const details = { planFilePath, title: resolvedTitle, planExists: true };
  const answer = await requestApproval(ws, sessionId, `计划待审批：${resolvedTitle}\n${planFilePath}`, [
    PLAN_APPROVE,
    PLAN_REFINE,
  ]);
  if (answer !== PLAN_APPROVE) {
    // 驳回：把刚评审的路径提为状态路径，下一轮提案针对这份计划继续改
    if (state.planFilePath !== planFilePath) entry.session.setPlanModeState({ ...state, planFilePath });
    return {
      content: [{ type: "text" as const, text: `计划需要修改：更新 ${planFilePath} 后再次写入 xd://propose。` }],
      details,
    };
  }
  entry.session.setPlanReferencePath(planFilePath); // 下一轮把计划正文作为上下文注入
  const planContent = (await readPlanContent(entry, planFilePath)) ?? "";
  try {
    await autosaveApprovedPlan({
      settings: entry.session.settings,
      cwd: entry.session.sessionManager.getCwd(),
      title: resolvedTitle,
      planContent,
    });
  } catch (err) {
    process.stderr.write(`[host] 计划自动保存失败: ${String(err)}\n`);
  }
  setPlanMode(ws, sessionId, entry, false);
  return {
    content: [{ type: "text" as const, text: `计划已批准（${planFilePath}）。计划模式已退出，按计划开始实施。` }],
    details,
  };
}

/**
 * 进出计划模式。persist=false 用于从落盘 mode_change 恢复（不重复记账）。
 * 进模式后提案处理器负责 xd://propose 的审批闭环——不装它，agent 的提案无人接收。
 */
export function setPlanMode(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  enabled: boolean,
  options?: { planFilePath?: string; persist?: boolean },
) {
  const persist = options?.persist !== false;
  if (enabled) {
    const previous = entry.session.getPlanModeState();
    const planFilePath = options?.planFilePath ?? previous?.planFilePath ?? PLAN_FILE_URL;
    entry.session.setPlanModeState({
      enabled: true,
      planFilePath,
      workflow: previous?.workflow ?? "parallel",
      reentry: previous !== undefined,
    });
    entry.session.setPlanProposalHandler?.((title: string) => handlePlanProposal(ws, sessionId, entry, title));
    if (persist) entry.manager.appendModeChange?.(PLAN_MODE_NAME, { planFilePath });
  } else {
    entry.session.setPlanProposalHandler?.(null);
    entry.session.setPlanModeState(undefined);
    if (persist) entry.manager.appendModeChange?.("none");
  }
  pushPlanMode(ws, sessionId, entry);
}

/**
 * /plan 的 args 分发（底座 TUI handlePlanModeCommand 的裁剪版：桌面无 paused 中间态，
 * 退出即清状态）。无参 = 反转当前状态；带 prompt = 开启后把 prompt 当首个计划轮次。
 * 返回 prompt（调用方转正常 prompt 链路）或 null（已消费）。
 */
export function handlePlanCommand(
  ws: { send(data: string): unknown },
  sessionId: string,
  entry: PoolEntry,
  args: string,
): string | null {
  if (entry.session.getGoalModeState()) {
    pushCommandOutput(sessionId, "目标模式下无法使用计划模式，先 /goal drop 退出目标模式。");
    return null;
  }
  if (!entry.session.settings.get("plan.enabled")) {
    pushCommandOutput(sessionId, "计划模式未启用：在设置中打开 plan.enabled 后再试。");
    return null;
  }
  if (entry.session.getPlanModeState()?.enabled) {
    setPlanMode(ws, sessionId, entry, false);
    pushCommandOutput(sessionId, "计划模式已退出。");
    return null;
  }
  setPlanMode(ws, sessionId, entry, true);
  const prompt = args.trim();
  if (prompt) return prompt;
  pushCommandOutput(
    sessionId,
    `计划模式已开启：只读探索后把计划写入 ${PLAN_FILE_URL} 并提案审批。退出：/plan（或权限胶囊右侧「计划」按钮）。`,
  );
  return null;
}

/** 会话重开时按最后一条 mode_change 恢复计划模式（TUI #reconcileModeFromSession 的桌面版） */
export function reconcilePlanMode(ws: { send(data: string): unknown }, sessionId: string, entry: PoolEntry, entries: any[]) {
  const last = [...entries].reverse().find((e) => e?.type === "mode_change");
  if (last?.mode !== PLAN_MODE_NAME) {
    pushPlanMode(ws, sessionId, entry); // 非计划模式也要推帧：UI 需要明确置 false
    return;
  }
  const planFilePath = typeof last.data?.planFilePath === "string" ? last.data.planFilePath : PLAN_FILE_URL;
  setPlanMode(ws, sessionId, entry, true, { planFilePath, persist: false });
}
