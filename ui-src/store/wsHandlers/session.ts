// 会话生命周期域帧：列表/归档拆分、创建激活、标题同步、外部写入、模型与思考档、
// 重命名/归档/停止/压缩回执、分叉与条目树导航。自 store/ws.ts onMessage 平移。
import { useAppStore } from "../index";
import { activateSession, clearBranchingMarks, activeOpen, updateSession } from "../session";
import { t } from "../../i18n";
import type { OpenSession } from "../../types/session";
import type { HandlerSlice } from "./types";

export const sessionHandlers = {
  session_list(msg) {
    // 归档条目拆出：不进 diskProjects，单独存 archivedSessions 供侧栏归档区渲染
    const st2 = useAppStore.getState();
    const archived: typeof st2.archivedSessions = [];
    const diskProjects: typeof st2.diskProjects = [];
    for (const p of msg.projects) {
      const sessions = [];
      for (const r of p.sessions) {
        if (r.archived) archived.push({ ...r, cwd: p.cwd });
        else sessions.push(r);
      }
      diskProjects.push({ ...p, sessions });
    }
    archived.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
    const expandedProjects = new Set<string>(msg.expandedProjects ?? []);
    if (st2.isProjectManageMode) {
      for (const p of diskProjects) expandedProjects.add(p.cwd);
    }
    useAppStore.setState((s) => ({
      diskProjects,
      archivedSessions: archived,
      allProjects: msg.allProjects ?? [],
      removedProjects: msg.removedProjects ?? [],
      expandedProjects,
      pinnedSessions: new Set<string>(msg.pinnedSessions ?? []),
    }));
    const st3 = useAppStore.getState();
    if (st3.activePath && !diskProjects.some((p) => p.sessions.some((r) => r.path === st3.activePath))) {
      useAppStore.setState((s) => {
        if (!s.activePath) return {};
        const openSessions = new Map(s.openSessions);
        openSessions.delete(s.activePath);
        return { openSessions, activePath: null };
      });
      useAppStore.getState().showWelcomeScreen(useAppStore.getState().newSessionProject || useAppStore.getState().getAvailableProjects()[0]?.cwd);
    }
  },
  session_created(msg) {
    useAppStore.setState((s) => ({
      openSessions: new Map(s.openSessions).set(msg.path, {
        sessionId: msg.sessionId,
        cwd: msg.cwd,
        items: [],
        pendingApprovals: [],
        assistantDraft: "",
        streaming: false,
        turnStartAt: null,
        subagents: new Map(),
        model: msg.model ?? null,
        thinking: msg.thinking ?? "auto",
        isGit: !!msg.isGit,
        todos: [],
        goal: null, // goal 状态（宿主 goal 帧置位；会话状态卡目标区展示）
        planMode: false, // 计划模式（宿主 plan_mode 帧置位）
        title: msg.title ?? null,
      } as OpenSession),
      selectedSubagent: null,
      selectedFile: null,
      isCreatingNew: false,
    }));
    activateSession(msg.path);
    useAppStore.getState().refreshGitDiff(); // 右栏 Git Diff 页需要 git status 数据，提前预取
    const st3 = useAppStore.getState();
    if (st3.pendingNewPrompt) {
      const { text, files } = st3.pendingNewPrompt;
      useAppStore.setState({ pendingNewPrompt: null });
      const s = st3.openSessions.get(st3.activePath ?? "");
      if (s) {
        const imgPayload: Array<{ type: "image"; data: string; mimeType: string }> = (files ?? [])
          .filter((f) => f.kind === "image" && typeof f.data === "string")
          .map((f) => ({ type: "image", data: f.data as string, mimeType: f.mime || "image/png" }));
        updateSession(s.sessionId, (next) => {
          next.items.push({
            role: "user",
            text,
            ...(imgPayload.length > 0 ? { images: imgPayload } : {}),
          });
          // 同 sendPrompt：发送即置运行态（计时/停止钮不等到宿主 turn_start）
          next.streaming = true;
          next.turnStartAt = Date.now();
        });
        st3.ws!.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text, files }));
        // 钉底跟随由 Chat 组件的滚动 effect 处理
      }
    }
    if (st3.pendingCreate) {
      useAppStore.setState({ pendingCreate: false });
      st3.send({ type: "list_sessions" }); // 新会话已落盘，重拉列表
    }
  },
  session_title_changed(msg) {
    // 1. 更新对应已打开会话的 title（当前激活会话若为此会话也会因此更新）
    updateSession(
      msg.sessionId,
      (s) => {
        s.title = msg.title;
      },
      false,
    );
    // 2. 更新磁盘项目列表中对应会话的 title（保证侧栏等引用的标题同步更新）
    useAppStore.setState((st) => {
      let projectsChanged = false;
      const diskProjects = st.diskProjects.map((p) => {
        let sChanged = false;
        const sessions = p.sessions.map((r) => {
          if (r.id === msg.sessionId) {
            sChanged = true;
            projectsChanged = true;
            return { ...r, title: msg.title };
          }
          return r;
        });
        return sChanged ? { ...p, sessions } : p;
      });

      let archivedChanged = false;
      const archivedSessions = st.archivedSessions.map((r) => {
        if (r.id === msg.sessionId) {
          archivedChanged = true;
          return { ...r, title: msg.title };
        }
        return r;
      });

      const patch: Partial<typeof st> = {};
      if (projectsChanged) patch.diskProjects = diskProjects;
      if (archivedChanged) patch.archivedSessions = archivedSessions;
      return patch;
    });
  },
  // 宿主检出外部进程写入本会话（CLI 对话/改名）：置位提示条，直到重新加载。
  // 会话被前端 LRU 驱逐时帧丢弃，切回走池复用分支时宿主按 entry.externalWrite 补发
  session_external_write(msg) {
    updateSession(
      msg.sessionId,
      (s) => {
        s.externalWrite = true;
      },
      false,
    );
  },
  session_model(msg) {
    updateSession(msg.sessionId, (s) => {
      s.model = msg.model;
      if (msg.thinking) s.thinking = msg.thinking;
    });
  },
  session_thinking(msg) {
    updateSession(msg.sessionId, (s) => {
      s.thinking = msg.level;
    });
  },
  session_renamed(msg) {
    if (msg.ok) {
      useAppStore.getState().toast(t("notify.renamed"));
      useAppStore.getState().send({ type: "list_sessions" }); // 列表数据以宿主为唯一真源，重拉最稳
    } else {
      // 帧形状无 error 字段(ok 恒 true,失败路径仅防御兜底);断言只为补类型,不改运行期读取
      const renamedErr = msg as { error?: string };
      useAppStore.getState().toast(renamedErr.error ?? t("notify.renameFailed"));
    }
  },
  session_archived(msg) {
    if (msg.ok) {
      useAppStore.getState().toast(t(msg.archived ? "notify.archived" : "notify.unarchived"));
      useAppStore.getState().send({ type: "list_sessions" });
    } else {
      const archivedErr = msg as { error?: string }; // 同上:仅防御性兜底
      useAppStore.getState().toast(archivedErr.error ?? t("notify.archiveFailed"));
    }
  },
  session_aborted() {
    useAppStore.getState().toast(t("notify.generationStopped"));
  },
  session_compacted(msg) {
    useAppStore.getState().toast(msg.ok ? t("notify.contextCompacted") : (msg.error ?? t("notify.compactFailed")));
  },
  session_branched(msg) {
    // 分叉回执：清除防连点标记（items mutate,空补丁换引用通知）；transcript 由 load_session 推的 messages 帧重建
    {
      const cur = activeOpen();
      if (cur) {
        clearBranchingMarks(cur.items);
        updateSession(cur.sessionId, () => {});
      }
    }
    if (!msg.ok) {
      useAppStore.getState().toast(msg.error ?? t("notify.forkFailed"));
      return;
    }
    useAppStore.getState().toast(t("notify.forked"));
    if (msg.selectedText) useAppStore.getState().setComposerValue(msg.selectedText, msg.selectedImages, { guard: true });
    useAppStore.getState().send({ type: "load_session", path: msg.newPath }); // 复用磁盘会话加载链路
    useAppStore.getState().send({ type: "list_sessions" });
  },
  session_tree(msg) {
    useAppStore.setState((s) => ({
      rightState: {
        ...s.rightState,
        sessionTree: { sessionId: msg.sessionId ?? s.rightState.treeFor, branches: msg.branches ?? [] },
        sessionTreePending: false,
      },
    }));
  },
  entry_tree(msg) {
    useAppStore.setState((s) => ({
      rightState: {
        ...s.rightState,
        entryTree: { sessionId: msg.sessionId ?? s.rightState.entryTreeFor, leafId: msg.leafId ?? null, roots: msg.roots ?? [] },
        entryTreePending: false,
      },
    }));
  },
  session_navigated(msg) {
    // 树内导航回执：transcript 由 messages 帧重建；成功后条目树作废重拉
    //（被放弃路径已成为兄弟分支，旧树结构失效），user 消息原文回填输入框（重问）
    {
      const cur = activeOpen();
      if (cur) {
        clearBranchingMarks(cur.items);
        updateSession(cur.sessionId, () => {});
      }
    }
    useAppStore.setState((s) => ({
      rightState: { ...s.rightState, entryTreeNav: false, navFrom: null, entryTree: msg.ok ? null : s.rightState.entryTree },
    }));
    if (!msg.ok) {
      useAppStore.getState().toast(msg.error ?? t("notify.navigateFailed"));
      return;
    }
    useAppStore.getState().toast(t("notify.navigated"));
    useAppStore.setState({ mainViewMode: "chat" });
    if (msg.editorText) useAppStore.getState().setComposerValue(msg.editorText, msg.editorImages, { guard: true });
  },
} satisfies HandlerSlice;

// 域键集（供 index 的穷尽断言交叉验证）
export type SessionFrames = keyof typeof sessionHandlers;
