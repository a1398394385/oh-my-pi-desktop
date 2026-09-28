// 会话与项目列表域 RPC：创建/加载/删除/归档/重命名/压缩/分叉/树导航，
// 项目列表增删排序。自 main.ts message 分发平移（第三刀）。
import fs from "node:fs";
import { SessionManager, USER_INTERRUPT_LABEL } from "../bootstrap.ts";
import { H, sessions } from "../state.ts";
import { saveDesktopProjects, mergeHistoryProjects } from "../profile.ts";
import { entriesToTranscript, treeToDisplay, sumRunDurationMs } from "../translate.ts";
import {
  handleCreateSession,
  handleLoadSession,
  sessionPathFromDisk,
  copySessionArtifactsIfAny,
  createSessionCore,
  attachEntry,
} from "../session-lifecycle.ts";
import type { RpcHandler } from "./types";

export async function handleListSessions(ws: any) {
  const all = await SessionManager.listAll(); // 全部 project 目录，pinned 优先
  const byProject = new Map<string, any[]>();
  for (const s of all) {
    const list = byProject.get(s.cwd) ?? [];
    list.push(s);
    byProject.set(s.cwd, list);
  }
  // 内存池兜底：底座懒建会话文件（首条内容才落盘），仅扫磁盘会漏掉刚建、还没写内容的
  // 会话——UI 的「活跃会话不在列表即弹回欢迎页」校验会误杀新建会话。
  // 已被用户移除的项目跳过：活跃会话不能把移除的项目顶回列表（否则 remove 永不生效）。
  const listed = new Set(all.map((s: any) => s.path));
  for (const [sid, entry] of sessions.entries()) {
    if (listed.has(entry.path)) continue;
    if (H.desktopProjects.removedProjects.includes(entry.cwd)) continue;
    const list = byProject.get(entry.cwd) ?? [];
    list.push({
      id: sid,
      path: entry.path,
      title: entry.title, // 懒建未落盘的会话走内存兜底（含 rename 后的标题）
      firstMessage: "",
      modified: new Date(),
      messageCount: 0,
      cwd: entry.cwd,
    });
    byProject.set(entry.cwd, list);
    listed.add(entry.path);
  }
  // 历史扫描：新出现的 project 并入所有项目列表（启动/UI 重连时都会走到这里）
  if (mergeHistoryProjects([...byProject.keys()])) await saveDesktopProjects();
  const projects = [...byProject.entries()]
    .map(([cwd, list]) => ({
      cwd,
      sessions: list
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .map((s) => ({
          id: s.id,
          path: s.path,
          title: s.title ?? null,
          firstMessage: s.firstMessage.slice(0, 80),
          modified: s.modified.toISOString(),
          messageCount: s.messageCount,
          archived: H.desktopProjects.archivedSessions.includes(s.path),
        })),
    }))
    .sort((a, b) => Date.parse(b.sessions[0].modified) - Date.parse(a.sessions[0].modified));
  ws.send(
    JSON.stringify({
      type: "session_list",
      projects,
      allProjects: H.desktopProjects.allProjects,
      removedProjects: H.desktopProjects.removedProjects,
      expandedProjects: H.desktopProjects.expandedProjects,
      pinnedSessions: H.desktopProjects.pinnedSessions,
    }),
  );
}

export const sessionHandlers: Record<string, RpcHandler> = {
  async create_session(ws, msg) {
    await handleCreateSession(ws, msg.cwd, msg.model, msg.thinking);
  },
  async load_session(ws, msg) {
    await handleLoadSession(ws, msg.path);
  },
  mark_seen(ws, msg) {
    // 前端切到某会话（activateSession/openSessionByPath）时通知：已读 = 停缓存保活探测。
    // 已打开会话的前端切换不发 load_session，必须走本 method 才能触达 host
    const p = String(msg.path ?? "").trim();
    if (!p) return;
    for (const entry of sessions.values()) {
      if (entry.path === p) entry.keepaliveWanted = false;
    }
  },
  async reload_session(ws, msg) {
    // 强制从磁盘重建（外部写入提示条的「重新加载」）：池复用分支只推内存快照，
    // 拿不到外部进程写入的内容；释放模式对齐 delete_session（unsubscribe + 出池）
    const p = String(msg.path ?? "").trim();
    if (!p) throw new Error("缺少 path");
    for (const [key, e] of sessions.entries()) {
      if (e.path !== p) continue;
      e.unsubscribe();
      sessions.delete(key);
    }
    await handleLoadSession(ws, p);
  },
  async list_sessions(ws) {
    await handleListSessions(ws);
  },
  async remove_project(ws, msg) {
    // 移出项目列表（会话仍保留在历史中，「最近」视图照常见）
    const cwd = String(msg.cwd ?? "").trim();
    if (!cwd) throw new Error("缺少 cwd");
    if (!H.desktopProjects.removedProjects.includes(cwd)) H.desktopProjects.removedProjects.push(cwd);
    await saveDesktopProjects();
    await handleListSessions(ws);
  },
  async delete_session(ws, msg) {
    // 彻底删除会话（物理文件 + 对应 artifacts 目录 + 内存会话池与置顶记录）
    const p = String(msg.path ?? "").trim();
    if (!p) throw new Error("缺少 path");
    for (const [key, entry] of sessions.entries()) {
      if (entry.path === p) {
        try { entry.unsubscribe(); } catch {}
        sessions.delete(key);
      }
    }
    const pi = H.desktopProjects.pinnedSessions.indexOf(p);
    if (pi >= 0) {
      H.desktopProjects.pinnedSessions.splice(pi, 1);
      await saveDesktopProjects();
    }
    // 归档记录随会话一并清理
    const ai = H.desktopProjects.archivedSessions.indexOf(p);
    if (ai >= 0) {
      H.desktopProjects.archivedSessions.splice(ai, 1);
      await saveDesktopProjects();
    }
    try {
      await fs.promises.unlink(p);
    } catch (err: any) {
      if (err?.code !== "ENOENT") process.stderr.write(`[host] 删除会话文件失败: ${err}\n`);
    }
    if (p.endsWith(".jsonl")) {
      const artifactsDir = p.slice(0, -6);
      try {
        await fs.promises.rm(artifactsDir, { recursive: true, force: true });
      } catch (err: any) {
        if (err?.code !== "ENOENT") process.stderr.write(`[host] 删除会话产物目录失败: ${err}\n`);
      }
    }
    await handleListSessions(ws);
  },
  async set_project_expanded(_ws, msg) {
    // 项目展开态持久化：记录在 omp-desktop.json expandedProjects，未记录的默认收起
    const cwd = String(msg.cwd ?? "").trim();
    const on = !!msg.expanded;
    if (!cwd) throw new Error("缺少 cwd");
    const i = H.desktopProjects.expandedProjects.indexOf(cwd);
    if (on && i < 0) H.desktopProjects.expandedProjects.push(cwd);
    if (!on && i >= 0) H.desktopProjects.expandedProjects.splice(i, 1);
    await saveDesktopProjects();
  },
  async set_session_pinned(_ws, msg) {
    // 置顶会话持久化：记录在 omp-desktop.json pinnedSessions，重启保持
    const p = String(msg.path ?? "").trim();
    const on = !!msg.pinned;
    if (!p) throw new Error("缺少 path");
    const i = H.desktopProjects.pinnedSessions.indexOf(p);
    if (on && i < 0) H.desktopProjects.pinnedSessions.push(p);
    if (!on && i >= 0) H.desktopProjects.pinnedSessions.splice(i, 1);
    await saveDesktopProjects();
  },
  async archive_session(ws, msg) {
    // 归档持久化：按会话文件路径记入 omp-desktop.json archivedSessions（与
    // pinnedSessions 同键，delete_session 同步清理）；归档同时取消置顶。
    // 未打开的历史会话（不在内存池）扫磁盘按底座会话 id 解析路径，同样可归档。
    const on = !!msg.archived;
    const entry = sessions.get(msg.sessionId);
    const p = entry?.path ?? (await sessionPathFromDisk(msg.sessionId));
    const ai = H.desktopProjects.archivedSessions.indexOf(p);
    if (on && ai < 0) H.desktopProjects.archivedSessions.push(p);
    if (!on && ai >= 0) H.desktopProjects.archivedSessions.splice(ai, 1);
    if (on) {
      const pi = H.desktopProjects.pinnedSessions.indexOf(p);
      if (pi >= 0) H.desktopProjects.pinnedSessions.splice(pi, 1);
    }
    await saveDesktopProjects();
    ws.send(JSON.stringify({ type: "session_archived", sessionId: msg.sessionId, ok: true, archived: on }));
  },
  async add_project(ws, msg) {
    // 手动添加：命中已移除列表则移回所有项目列表，否则作为新项目并入（置顶，立即可见）
    const cwd = String(msg.cwd ?? "").trim();
    if (!cwd) throw new Error("缺少 cwd");
    const ri = H.desktopProjects.removedProjects.indexOf(cwd);
    if (ri >= 0) H.desktopProjects.removedProjects.splice(ri, 1);
    if (!H.desktopProjects.allProjects.includes(cwd)) H.desktopProjects.allProjects.unshift(cwd);
    await saveDesktopProjects();
    await handleListSessions(ws);
  },
  async reorder_projects(_ws, msg) {
    // 拖拽排序：以 UI 传来的完整顺序为准；未涵盖的既有项（并发变更兜底）保持原序追加尾部
    const order = Array.isArray(msg.order) ? msg.order.filter((x: unknown) => typeof x === "string") : [];
    if (order.length === 0) throw new Error("缺少 order");
    const set = new Set(order);
    const rest = H.desktopProjects.allProjects.filter((c) => !set.has(c));
    H.desktopProjects.allProjects = [...order, ...rest];
    await saveDesktopProjects();
  },
  async abort_session(ws, msg) {
    // 流式中断当前生成：reason 用 USER_INTERRUPT_LABEL，transcript 能把该轮
    // assistant 消息标记为用户主动中断；空闲会话 abort 同样安全（底座 waitForIdle 立即返回）。
    // 中断后底座自然走到 agent_end/turn 事件，无需额外收尾。
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
    ws.send(JSON.stringify({ type: "session_aborted", sessionId: msg.sessionId, ok: true }));
  },
  async rename_session(ws, msg) {
    // 会话重命名：走底座 SessionManager.setSessionName(source:"user") 落盘
    // （title slot + history.db 标题索引），CLI 等其他入口读到同一标题。
    // 打开中的会话用池内 manager；未打开的历史会话 open 磁盘文件后同样
    // 落盘（title slot 插入/原位更新均由底座处理）。
    // 懒建未落盘的会话仅内存生效，list_sessions 兜底条目经 entry.title 呈现。
    const title = String(msg.title ?? "").trim();
    if (!title) throw new Error("缺少 title");
    const entry = sessions.get(msg.sessionId);
    if (entry) {
      if (!(await entry.manager.setSessionName(title, "user"))) {
        throw new Error("标题无效（清洗后为空或会话已释放）");
      }
      entry.title = title;
    } else {
      const manager = await SessionManager.open(await sessionPathFromDisk(msg.sessionId));
      if (!(await manager.setSessionName(title, "user"))) {
        throw new Error("标题无效（清洗后为空或会话已释放）");
      }
    }
    ws.send(JSON.stringify({ type: "session_renamed", sessionId: msg.sessionId, ok: true, title }));
  },
  async compact_session(ws, msg) {
    // 手动压缩：底座 compact 重写会话历史（LLM 摘要）。空会话前置快速失败
    // （没有可压缩的历史，避免无谓的模型调用）；不可压缩/压缩失败时底座抛错，
    // 以 error 字段回包提示前端；成功则从磁盘 entries 重建 transcript 并推送，
    // 前端立即换压缩后视图。
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    if (entry.transcript.length === 0) {
      ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, error: "会话为空，没有可压缩的历史" }));
      return;
    }
    try {
      await entry.session.compact();
      entry.transcript = entriesToTranscript(entry.manager.getEntries());
      // 重建后的历史已含 mention 行：游标对齐，避免后续回读重发
      entry.mentionScanIndex = entry.manager.getEntries().length;
      ws.send(JSON.stringify({ type: "messages", sessionId: msg.sessionId, messages: entry.transcript }));
      ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, ok: true }));
    } catch (err) {
      ws.send(JSON.stringify({ type: "session_compacted", sessionId: msg.sessionId, error: String(err) }));
    }
  },
  async branch_session(ws, msg) {
    // 复制式会话分叉：以指定条目为锚点截取历史链路，生成独立新会话文件
    // （header.parentSession 指回源文件）。源会话在宿主池中保持不变，新会话加入池并通知前端切换。
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    const entryId = String(msg.entryId ?? "");
    if (!entryId) throw new Error("缺少 entryId");
    try {
      // 确保当前会话的最新数据已落盘
      await entry.manager.flush();
      const parentPath = entry.path ?? (await sessionPathFromDisk(msg.sessionId));
      if (!parentPath) throw new Error("无法定位源会话文件");

      // 用独立的 SessionManager 打开父会话文件进行分支切片，避免污染当前活跃的 entry.manager / entry.session
      const tempManager = await SessionManager.open(parentPath);
      const targetEntry = tempManager.getEntry(entryId);
      if (!targetEntry) throw new Error(`未找到条目: ${entryId}`);

      const isUser = targetEntry.type === "message" && targetEntry.message.role === "user";
      // 若是 user 消息分叉（兼容），分支点取其父节点并将该文本回填；若是 assistant 消息分叉，完整保留该轮回复
      const branchLeafId = isUser && targetEntry.parentId ? targetEntry.parentId : entryId;
      const newSessionFile = tempManager.createBranchedSession(branchLeafId);
      if (!newSessionFile) throw new Error("分叉创建新会话文件失败");

      // 复制工件目录（如存在）
      await copySessionArtifactsIfAny(parentPath, newSessionFile);

      // 为新会话建立独立的 AgentSession 实例并加入 sessions 池
      const newManager = await SessionManager.open(newSessionFile);
      const newEntries = newManager.getEntries();
      const newTranscript = entriesToTranscript(newEntries);
      const peek = await SessionManager.peekSessionInit(newSessionFile);
      const workCwd = peek?.cwd ?? entry.cwd;
      const { sessionId: newSessionId, entry: newEntry, eventBus: newBus } = await createSessionCore(
        workCwd,
        newManager,
        newTranscript,
        entry.session.model,
      );
      newEntry.mentionScanIndex = newEntries.length;
      newEntry.activeMs = sumRunDurationMs(newEntries);
      attachEntry(ws, newSessionId, newEntry, newBus);
      sessions.set(newSessionId, newEntry);

      // 提取选中文本（仅 user 消息需要回填输入框，assistant 回复分叉后输入框保持空白待提问）
      const selectedText = isUser
        ? (typeof targetEntry.message.content === "string"
            ? targetEntry.message.content
            : (targetEntry.message.content ?? [])
                .filter((b: any) => b?.type === "text")
                .map((b: any) => b.text)
                .join("\n"))
        : null;

      // 推送新会话的 messages 快照和 session_branched 回执
      ws.send(JSON.stringify({ type: "messages", sessionId: newSessionId, messages: newTranscript }));
      ws.send(
        JSON.stringify({
          type: "session_branched",
          sessionId: msg.sessionId,
          ok: true,
          newSessionId,
          newPath: newSessionFile,
          selectedText,
        }),
      );
      await handleListSessions(ws); // 列表刷新信号：session_list 帧通知左栏项目树更新
    } catch (err) {
      ws.send(JSON.stringify({ type: "session_branched", sessionId: msg.sessionId, ok: false, error: String(err) }));
    }
  },
  async get_session_tree(ws, msg) {
    // 跨文件分支家族：listAll 扫盘，按 header.parentSession（父文件路径）连图。
    // 从当前会话文件出发向上追根，再自根向下收集全部子孙；title 走 listAll 的
    // 底座解析（与 list_sessions 同源）。找不到会话（未落盘且不在池）回 error 字段。
    const entry = sessions.get(msg.sessionId);
    const curPath = entry?.path ?? (await sessionPathFromDisk(msg.sessionId));
    const all = await SessionManager.listAll();
    const byPath = new Map<string, any>(all.map((s: any) => [s.path, s]));
    const cur = byPath.get(curPath);
    if (!cur) {
      ws.send(JSON.stringify({ type: "session_tree", sessionId: msg.sessionId, ok: false, error: `会话文件不在磁盘上: ${curPath}` }));
      return;
    }
    // 向上追根（seenUp 防脏数据成环）
    let root = cur;
    const seenUp = new Set<string>([curPath]);
    while (root.parentSessionPath && byPath.has(root.parentSessionPath) && !seenUp.has(root.parentSessionPath)) {
      root = byPath.get(root.parentSessionPath);
      seenUp.add(root.path);
    }
    // 自根 BFS 收集家族（同层按修改时间升序，根在前）
    const family: any[] = [];
    const visited = new Set<string>([root.path]);
    const queue = [root];
    while (queue.length > 0) {
      const node = queue.shift()!;
      family.push(node);
      const children = all
        .filter((s: any) => s.parentSessionPath === node.path && !visited.has(s.path))
        .sort((a, b) => a.modified.getTime() - b.modified.getTime());
      for (const c of children) {
        visited.add(c.path);
        queue.push(c);
      }
    }
    ws.send(
      JSON.stringify({
        type: "session_tree",
        sessionId: msg.sessionId,
        ok: true,
        branches: family.map((s) => ({
          sessionId: s.id,
          path: s.path,
          title: s.title ?? null,
          modified: s.modified.toISOString(),
          parentSession: s.parentSessionPath ?? null,
          isCurrent: s.path === curPath,
          messageCount: s.messageCount,
        })),
      }),
    );
  },
  async get_entry_tree(ws, msg) {
    // 会话内条目树（TUI /tree 同款数据源）：manager.getTree() 返回当前文件内
    // 的条目森林（rewind/fork 留下的兄弟分支同文件共存），getLeafId() 标当前叶。
    // 与 get_session_tree（跨文件家族）是两棵树，别混。
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    const leafId = entry.manager.getLeafId();
    ws.send(
      JSON.stringify({
        type: "entry_tree",
        sessionId: msg.sessionId,
        ok: true,
        leafId,
        roots: treeToDisplay(entry.manager.getTree(), leafId),
      }),
    );
  },
  async navigate_tree(ws, msg) {
    // 树内导航（/tree 选中节点）：底座 navigateTree 留在同一文件内把 leaf 移到
    // 目标条目，被放弃路径保留为兄弟分支——与 branch_session（新建文件）不同，
    // 池键/sessionId 不变。成功后照 compact 模式重建 transcript 推 messages 帧；
    // editorText/editorImages 是目标 user 消息的原文，供前端回填输入框（重问）。
    // 简化：不带 allowAskReopen（ask 重答流程是 TUI 交互专属），ask toolResult
    // 目标走底座默认的 plain leaf move。
    const entry = sessions.get(msg.sessionId);
    if (!entry) throw new Error(`会话不存在: ${msg.sessionId}`);
    const entryId = String(msg.entryId ?? "");
    if (!entryId) throw new Error("缺少 entryId");
    // 目标即当前 leaf：底座 navigateTree 直接返回 cancelled:false（既不报错也不移动），
    // 静默"成功"会让 output 尾部的分叉按钮看起来生效实则无变化——这里显式回绝。
    if (entry.manager?.getLeafId() === entryId) {
      ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: "已在当前位置" }));
      return;
    }
    try {
      const result = await entry.session.navigateTree(entryId, { summarize: !!msg.summarize });
      if (result.cancelled) {
        ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: "导航被取消" }));
        return;
      }
      if (result.aborted) {
        ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: "分支摘要已中止" }));
        return;
      }
      // getEntries() 是文件内全部条目（被放弃的分支仍在文件里），
      // 活跃 transcript 只要根→叶路径——与底座 renderInitialMessages 的口径一致
      entry.transcript = entriesToTranscript(entry.manager.getBranch());
      ws.send(JSON.stringify({ type: "messages", sessionId: msg.sessionId, messages: entry.transcript }));
      ws.send(
        JSON.stringify({
          type: "session_navigated",
          sessionId: msg.sessionId,
          ok: true,
          editorText: result.editorText ?? null,
          editorImages: result.editorImages ?? null,
        }),
      );
    } catch (err) {
      ws.send(JSON.stringify({ type: "session_navigated", sessionId: msg.sessionId, ok: false, error: String(err) }));
    }
  },
};
