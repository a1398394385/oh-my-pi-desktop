// 输入区：附件行 + Lexical 编辑器 + cbar（添加/权限模式/后台任务/子智能体/上下文环/模型/
// 思考/发送）+ 三个弹出菜单 + sigil 补全面板。迁移自 ui/composer.js（578 行），P7 起基于
// Lexical（RichText + History + TypeaheadMenuPlugin）。
// 契约：草稿为模块级单例（EditorState 快照 + 压平纯文本，见 composer/lexical/draft.ts，
// 欢迎页 ↔ dock 两个挂载位切换不丢值）；composerSetSignal（seq 信号）effect 回填（含图片）；
// 发送/停止合一（流式且无草稿 → 停止）；模型/思考菜单读 store 的 modelNames/modelEfforts；
// 补全选中插 ChipNode（decorator 原子节点），序列化文本与旧 textarea 的插入文本逐字节一致，
// 编辑器压平视图（composer/lexical/flat.ts）保证 WS 发送的 prompt 内容格式不变。
// 排队卡不在此处：由 App 在 .dock 前作相邻兄弟渲染（ZCode 负 margin 二级重叠卡，见 ui/style.css）。
import { useEffect, useLayoutEffect, useReducer, useRef, useState, useMemo, useCallback } from "react";
import type { ChangeEvent, MouseEvent, Ref } from "react";
import { useAppStore, setBump, send, toast } from "../store";
import { updateSession } from "../store/session";
import type { PromptAttachment } from "../types/frames";
import { closeAllMenus } from "../shell";
import Icon from "../Icon";
import AttachRow from "./composer/AttachRow";
import ModeMenu, { MODE_META } from "./composer/ModeMenu";
import ModelMenu from "./composer/ModelMenu";
import ThinkMenu from "./composer/ThinkMenu";
import PaletteMenu from "./composer/PaletteMenu";
import type { PaletteItem, CommandItem } from "./composer/PaletteMenu";
import { detectTrigger, isBashMode, insertFile, insertCommand } from "./composer/trigger";
import CtxCard from "./chat/CtxCard";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { LexicalTypeaheadMenuPlugin, MenuOption } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import type { TriggerFn, MenuRenderFn } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import type { TextNode } from "lexical";
import { $createChipNode, ChipNode } from "./composer/lexical/ChipNode";
import { $flattenWithCaret, $leafStart, $selectAfter } from "./composer/lexical/flat";
import { getDraftState, getDraftText, CONTENT_EDITABLE_OK } from "./composer/lexical/draft";
import ComposerPlugin from "./composer/lexical/ComposerPlugin";
import type { ComposerHandle } from "./composer/lexical/ComposerPlugin";

// 斜杠命令候选过滤：空 query 全量按 source 分组排序（builtin→skill→extension→custom→其他）；
// 非空先 name/aliases 前缀命中、次之 includes、再按 source 序兜底；上限 50
const SRC_RANK: Record<string, number> = { builtin: 0, skill: 1, extension: 2, custom: 3, file: 4 };
function filterCommands(list: CommandItem[] | null | undefined, query: string): CommandItem[] {
  if (!Array.isArray(list) || !list.length) return [];
  const rank = (c: CommandItem) => SRC_RANK[c.source ?? ""] ?? 9;
  const q = (query || "").toLowerCase();
  if (!q) return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 50);
  const pre: CommandItem[] = [];
  const incl: CommandItem[] = [];
  for (const c of list) {
    const names = [c.name, ...(c.aliases || [])].map((n) => n.toLowerCase());
    if (names.some((n) => n.startsWith(q))) pre.push(c);
    else if (names.some((n) => n.includes(q))) incl.push(c);
  }
  const byRank = (a: CommandItem, b: CommandItem) => rank(a) - rank(b) || a.name.localeCompare(b.name);
  return [...pre.sort(byRank), ...incl.sort(byRank)].slice(0, 50);
}

// 待发送附件上限：图片走 ImageContent（base64），文本类文件内联进 prompt
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

// 供应商符号（复制自 ui/settings/index.js PROV_IC；该模块顶层有设置页绑定副作用，不宜引入）
const PROV_IC: Record<string, string> = { deepseek: "▲", "kimi-code": "✕", "minimax-code-cn": "◆", "opencode-zen": "✦", llama: "●", "local-proxy": "▣" };

// 上下文环周长：2π×6.5（与 CSS dasharray 一致）
const RING_C = 40.84;

// 底栏分级收缩的最大级数（权限模式/思考/模型→纯图标、隐藏子智能体、隐藏后台任务）
const BAR_STAGES = 5;

// 组装随 prompt 下发的附件载荷（发送后由调用方清空 pendingFiles）
function buildAttachPayload(): PromptAttachment[] {
  return useAppStore
    .getState()
    .pendingFiles.map((f) =>
      f.kind === "image"
        ? { kind: "image", mime: f.mime, data: f.data }
        : { kind: "text", name: f.name, text: f.data },
    );
}

// 会话工具行的结构子集（bgTaskCount 只读这些字段；全量形态见 store）
type BgToolItem = {
  role?: string;
  name?: string;
  text?: string;
  args?: { op?: string; name?: string; application?: string };
  running?: boolean;
};

// 后台命令运行计数（原 right.js getBgTasksForSession 的 runningCount 部分平移：
// 只遍历 s.items 顶层——封进 loop 组的工具不再计；hub start 计入、stop/cancel 抵消同名进程）
function bgTaskCount(s: { items?: BgToolItem[] } | null | undefined) {
  if (!s) return 0;
  let n = 0;
  const live = new Set<string>();
  for (const it of s.items ?? []) {
    if (it.role !== "tool") continue;
    const name = it.name || it.text || "";
    if (name === "hub") {
      const args = it.args || {};
      const op = args.op || "cmd";
      const proc = args.name || args.application || "";
      // 只按 start/stop/cancel 配对计后台进程。不能回落到 it.running：那是「hub 工具
      // 执行中」（tool 帧到 tool_update 之间），list/status 之类同样命中，不是进程存活态
      if (op === "start") {
        n++;
        if (proc) live.add(proc);
      } else if ((op === "stop" || op === "cancel") && proc && live.has(proc)) {
        n--;
        live.delete(proc);
      }
    } else if (it.running && (name === "bash" || name === "shell" || name === "eval")) {
      n++;
    }
  }
  return Math.max(0, n);
}

// 运行中子智能体计数（原 right.js getRunningSubagentCount 平移）
function subagentCount(s: { subagents?: Map<string, { streaming?: boolean; status?: string }> } | null | undefined) {
  if (!s?.subagents) return 0;
  return [...s.subagents.values()].filter((x) => x.streaming || x.status === "started").length;
}

type MenuName = "mode" | "model" | "think";

// Typeahead 候选项包装：data 带原始候选（FileItem / CommandItem），key 取 path / name
class PalOption extends MenuOption {
  data: PaletteItem;
  constructor(data: PaletteItem) {
    super("path" in data ? data.path : data.name);
    this.data = data;
  }
}

type ComposerProps = {
  inWelcome: boolean;
  blocking?: boolean;
};

export default function Composer({ inWelcome, blocking = false }: ComposerProps) {
  // ---- store 订阅（selector 逐字段，禁止 selector 内构造新对象/数组） ----
  // 当前会话（updateSession 帧处理换 session/Map 引用，selector 按引用感知）
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const pendingFiles = useAppStore((st) => st.pendingFiles);
  const escArmedUntil = useAppStore((st) => st.escArmedUntil);
  const composerSetSignal = useAppStore((st) => st.composerSetSignal);
  const menuSignal = useAppStore((st) => st.menuSignal);
  const isCreatingNew = useAppStore((st) => st.isCreatingNew);
  const newSessionModel = useAppStore((st) => st.newSessionModel);
  const newSessionThinking = useAppStore((st) => st.newSessionThinking);
  const commands = useAppStore((st) => st.commands);
  const mentionResult = useAppStore((st) => st.mentionResult);
  const approvalMode = useAppStore((st) => st.approvalMode);
  const rightCollapsed = useAppStore((st) => st.rightCollapsed);
  const rightTab = useAppStore((st) => st.rightTab);
  // 无赋值订阅：模型目录在 models/ready 帧到达时换 Map 引用，订阅引用才能在目录
  // 刷新后重渲染（下方 modelShort 内部 getState 读最新表）。commandsSessionId 与 commands
  // 同帧写入（ws.ts list_commands 回包），归属判定在 onQueryChange 内 getState 现取
  useAppStore((st) => st.modelNames);

  const rootRef = useRef<HTMLDivElement>(null); // #composer
  const [ctxRingEl, setCtxRingEl] = useState<HTMLSpanElement | null>(null); // #ctxRing 元素（callback ref,环后渲染也挂得上 hover）
  const lexRef = useRef<ComposerHandle | null>(null); // 编辑器句柄（focus/setText/clear）
  const cbarRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null); // filePicker
  const modeBtnRef = useRef<HTMLButtonElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const thinkBtnRef = useRef<HTMLButtonElement>(null);
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null); // "mode" | "model" | "think" | null（互斥）
  const [stopPending, setStopPending] = useState(false); // 停止钮防连点（turn_end 复位）
  const barStageRef = useRef(0); // 上次收缩级数（变化时收起打开中的菜单）
  // 编辑器文本镜像（模块级 draftText 的渲染态）：输入后刷新发送钮 ready 态与 bash-mode 类，
  // 等价原 onInput 里的 notify/forceRender
  const [text, setText] = useState(() => getDraftText());
  const onTextChange = useCallback((t: string) => setText(t), []);

  // ---- sigil 补全面板（TypeaheadMenuPlugin 受控态） ----
  const [taKind, setTaKind] = useState<"file" | "command" | null>(null); // 触发种类（打开中）
  const [taQuery, setTaQuery] = useState("");
  const [taReqId, setTaReqId] = useState(0); // @ 候选请求序号（与 mentionResult.reqId 配对）
  const [taOpen, setTaOpen] = useState(false); // 面板开合（键盘命令让路判定）
  const taOpenRef = useRef(false);
  useEffect(() => {
    taOpenRef.current = taOpen;
  }, [taOpen]);
  // 关闭通道：TypeaheadMenuPlugin 无受控 close，用 key 重挂清 resolution；同时复位开合标记
  // 与去重键（重开 = 重新触发 = 重新请求，对齐旧版 setPalette(null) 语义）
  const [closeTick, bumpClose] = useReducer((x: number) => x + 1, 0);
  const closeTypeahead = useCallback(() => {
    if (!taOpenRef.current) return;
    taOpenRef.current = false;
    setTaOpen(false);
    lastKeyRef.current = null;
    bumpClose();
  }, []);
  const mentionTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // @ 候选 150ms 防抖
  // 最近一次触发的 kind/quoted（triggerFn 写，onQueryChange/onSelectOption 读）
  const lastTriggerRef = useRef<{ kind: "file" | "command"; quoted: boolean } | null>(null);
  // 触发态去重键：Lexical 的 updateListener 连 selection-only 更新也会回调 onQueryChange，
  // 同一触发态只执行一次请求副作用（对齐旧版只在文本 input 时跑 updatePalette）
  const lastKeyRef = useRef<string | null>(null);

  const hasDraft = text.trim().length > 0 || pendingFiles.length > 0;
  // 运行中的本地 bash 行（! 前缀命令）：停止形态同样覆盖——点停止发 bash_abort 而非 abort_session
  const bashRunning = !!s?.items?.some((x: { role?: string; running?: boolean }) => x.role === "bash" && x.running);
  const stopping = (!!s?.streaming || bashRunning) && !hasDraft;
  // Esc 二次确认窗口内：有草稿时发送钮短暂显示取消图标（再按一次 Esc 即中断生成）
  const escArmed = Date.now() < (escArmedUntil ?? 0);
  const canAbort = stopping || escArmed;

  // ---- 外部回填信号（分叉 selectedText / 排队消息编辑），对齐原 setComposerValue（含图片） ----
  useEffect(() => {
    const sig = composerSetSignal;
    if (!sig || !lexRef.current) return;
    if (!sig.text && (!sig.images || sig.images.length === 0)) {
      lexRef.current.clear();
      useAppStore.setState({ pendingFiles: [], composerSetSignal: null });
      lexRef.current.focus();
      return;
    }
    lexRef.current.setText(sig.text);
    // 底座 ImageContent[] 转本地附件 chip：字段形态 { type:"image", data, mimeType }，兼容嵌套 source 形态
    interface BackfillImage {
      name?: string;
      data?: string;
      mimeType?: string;
      mediaType?: string;
      source?: { type?: string; data?: string; mimeType?: string; mediaType?: string };
    }
    // 形状随底座 SDK(frames.ts selectedImages/editorImages TODO),只约束本 effect 读取的字段
    const backfillImages = (sig.images ?? []) as BackfillImage[];
    // 附件追加 + 信号清零 + 渲染触发合并为一次 setState（pendingFiles 容器换新引用,
    // id 编号取 store 当前 fileSeq 递增,等价原逐个 ++fileSeq）
    useAppStore.setState((st) => {
      const files = [...st.pendingFiles];
      let seq = st.fileSeq;
      for (const img of backfillImages) {
        const src = img.source?.type === "base64" ? img.source : img;
        if (!src?.data) continue;
        files.push({
          id: ++seq,
          name: img.name || `图片${files.length + 1}`,
          kind: "image",
          mime: src.mimeType || src.mediaType || "image/png",
          data: src.data,
        });
      }
      return { pendingFiles: files, fileSeq: seq, composerSetSignal: null };
    });
    lexRef.current.focus();
  });

  // ---- 挂载位切换（欢迎页 ↔ dock 实例重建）：欢迎页聚焦 ----
  useLayoutEffect(() => {
    if (inWelcome) lexRef.current?.focus();
  }, [inWelcome]);

  // ---- 草稿有无同步到 store（全局 Esc 的二次确认要知道输入框里有没有内容） ----
  useEffect(() => {
    // 静默写（不 bump：原代码写后无 notify，带 bump 会渲染循环）
    useAppStore.setState({ draftHasContent: hasDraft });
  });

  // ---- 发送链路（原 sendPrompt 平移） ----
  const clearDraft = () => {
    lexRef.current?.clear();
    setBump({ pendingFiles: [] });
  };
  const sendPrompt = (steer = false) => {
    const t = getDraftText().trim();
    const files = buildAttachPayload();
    const ws = useAppStore.getState().ws;
    if ((!t && files.length === 0) || !ws || ws.readyState !== 1) return;

    // bash 模式（! 前缀，!! = 结果不进模型上下文）：本地执行，不出 user 气泡，
    // 行由 bash_start 帧建立（对齐 TUI input-controller 的发送路由）
    if (isBashMode(t)) {
      const raw = t.trim();
      const excludeFromContext = raw.startsWith("!!");
      const command = excludeFromContext ? raw.slice(2).trim() : raw.slice(1).trim();
      if (!command) return; // `!` / `!!` 空命令：无动作（TUI 同款）
      if (!s) {
        toast("先新建或打开一个会话");
        return;
      }
      clearDraft();
      send({ type: "bash_exec", sessionId: s.sessionId, command, excludeFromContext });
      return;
    }

    // 新建态：草稿存 pendingNewPrompt，session_created 回执后由 store 代发
    if (isCreatingNew || !s) {
      useAppStore.setState({ pendingNewPrompt: { text: t, files } });
      clearDraft();
      send({
        type: "create_session",
        cwd: useAppStore.getState().newSessionProject || undefined,
        model: newSessionModel || undefined,
        thinking: newSessionThinking || undefined,
      });
      useAppStore.setState({ pendingCreate: true });
      return;
    }
    // 提取图片载荷供前端气泡即时渲染
    const imgPayload: Array<{ type: "image"; data: string; mimeType: string }> = files
      .filter((f) => f.kind === "image" && typeof f.data === "string")
      .map((f) => ({ type: "image", data: f.data as string, mimeType: f.mime || "image/png" }));

    // 流式中发送 = 进待发送队列（followUp，当前 loop 完自动消费）；Ctrl+↵ 则是 steer——
    // 立即注入（当前工具批次后），气泡固定在消息流底部，分割发生在消费时刻（steer_consumed）
    // updateSession 换 session/Map 引用：selector 订阅组件（本组件/QueueCard）与旧 useStore 组件均感知
    if (s.streaming) {
      updateSession(s.sessionId, (next) => {
        if (steer) {
          next.steering = next.steering ?? [];
          next.steering.push({ text: t });
          next.items.push({
            role: "user",
            text: t,
            pending: "steer",
            ...(imgPayload.length > 0 ? { images: imgPayload } : {}),
          });
        } else {
          next.queued = next.queued ?? [];
          next.queued.push({ text: t });
        }
      });
    } else {
      updateSession(s.sessionId, (next) => {
        next.items.push({
          role: "user",
          text: t,
          ...(imgPayload.length > 0 ? { images: imgPayload } : {}),
        });
        // 本地即刻置运行态：计时从发送起算、发送钮转停止（宿主 turn_start 到达后保留起点不重置）
        next.streaming = true;
        next.turnStartAt = Date.now();
      });
    }
    clearDraft();
    ws.send(JSON.stringify({ type: "prompt", sessionId: s.sessionId, text: t, files, ...(steer ? { steer: true } : {}) }));
    // 钉底跟随由 Chat 组件的滚动 effect 处理
  };

  // ---- sigil 触发检测（triggerFn）：全局压平视图 + detectTrigger，语义与旧 updatePalette
  // 的检测段一致（无会话且非新建页时命令不触发）；触发区间须完整落在 anchor 文本节点内
  // （Typeahead 的替换区间按节点内偏移定位） ----
  const triggerFn = useCallback<TriggerFn>(
    (_text, editor) =>
      editor.read(() => {
        const fail = () => {
          lastTriggerRef.current = null;
          return null;
        };
        const sel = $getSelection();
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) return fail();
        const anchor = sel.anchor;
        if (anchor.type !== "text") return fail();
        const node = anchor.getNode();
        if (!$isTextNode(node) || !node.isSimpleText()) return fail();
        const { text: full, caret } = $flattenWithCaret();
        if (caret == null) return fail();
        const t = detectTrigger(full, caret);
        if (!t) return fail();
        if (t.kind === "command") {
          const st = useAppStore.getState();
          const sess = st.activePath ? st.openSessions.get(st.activePath) : undefined;
          if (!sess && !st.isCreatingNew) return fail(); // 无会话且非新建页：命令不可用
        }
        const nodeStart = $leafStart(node);
        if (nodeStart == null || t.start < nodeStart) return fail();
        lastTriggerRef.current = { kind: t.kind, quoted: t.kind === "file" ? !!t.quoted : false };
        return { leadOffset: t.start - nodeStart, matchingString: t.query, replaceableString: full.slice(t.start, t.end) };
      }),
    [],
  );

  // ---- 触发后的请求副作用（onQueryChange）：斜杠命令清单拉取 / @ 文件候选 150ms 防抖，
  // 平移旧 updatePalette 的请求段（含 commands:null 静默写、reqId 自增丢弃过期响应） ----
  const onQueryChange = useCallback((q: string | null) => {
    const trig = lastTriggerRef.current;
    const key = q == null || !trig ? null : `${trig.kind}|${trig.quoted ? 1 : 0}|${q}`;
    if (key === lastKeyRef.current) return; // 同一触发态的重复 update：副作用幂等跳过
    lastKeyRef.current = key;
    if (!trig || q == null) return;
    setTaKind(trig.kind);
    setTaQuery(q);
    const st = useAppStore.getState();
    const sess = st.activePath ? st.openSessions.get(st.activePath) : undefined;
    if (trig.kind === "command") {
      // 清单归属：会话 id 或新建页哨兵（新建页走无会话清单，隐藏会话级命令）
      const cmdKey = sess ? sess.sessionId : "new";
      if (st.commandsSessionId !== cmdKey) {
        useAppStore.setState({ commands: null }); // 清单过期：拉取期间弹层显示加载中
        send({ type: "list_commands", sessionId: sess?.sessionId, cwd: sess ? undefined : st.newSessionProject || undefined });
      }
    } else {
      // @ 文件候选：150ms 防抖后发 list_files（宿主 fuzzyFind 是磁盘扫描）
      const reqId = st.mentionReqSeq + 1;
      useAppStore.setState({ mentionReqSeq: reqId }); // 静默自增（原 ++ 后无 notify）
      const cwd = sess ? undefined : st.newSessionProject || undefined;
      clearTimeout(mentionTimer.current ?? undefined);
      mentionTimer.current = setTimeout(() => {
        send({ type: "list_files", sessionId: sess?.sessionId, cwd, query: q, reqId });
      }, 150);
      setTaReqId(reqId);
    }
  }, []);

  // 候选与加载态渲染期从 store 现算（file_matches/commands 回包 setState 触发重渲染），
  // 不存快照——回包帧到达即出候选，无需再次击键
  const taItems: PaletteItem[] =
    taKind === "file"
      ? mentionResult && mentionResult.reqId === taReqId
        ? mentionResult.matches
        : []
      : taKind === "command"
        ? filterCommands(commands, taQuery)
        : [];
  const taLoading = taKind === "file" ? !(mentionResult && mentionResult.reqId === taReqId) : taKind === "command" ? commands === null : false;
  const taOptions = taItems.map((it) => new PalOption(it));

  // ---- 接受补全：文件/命令 → ChipNode（序列化 = insertFile/insertCommand 原文）；目录 →
  // 纯文本替换且光标停在 token 尾（无尾随空格），update 后 triggerFn 重算触发、链式展开
  // 该目录内容（对齐旧版 dispatchEvent(input) 重算触发；chip 后为 element anchor，无法
  // 再触发文本级 typeahead，故目录链式必须走纯文本） ----
  const onSelectOption = useCallback((option: PalOption, node: TextNode | null, closeMenu: () => void) => {
    const trig = lastTriggerRef.current;
    if (!trig || !node) {
      closeMenu();
      return;
    }
    const it = option.data;
    if (trig.kind === "file") {
      if (!("path" in it)) {
        closeMenu(); // 类型守卫：kind=file 时候选必为 FileItem
        return;
      }
      const next = insertFile(it.path, it.dir, trig.quoted);
      if (it.dir) {
        node.setTextContent(next);
        node.select(next.length, next.length);
      } else {
        const chip = $createChipNode(next);
        node.replace(chip);
        $selectAfter(chip);
      }
    } else {
      if (!("name" in it)) {
        closeMenu(); // 类型守卫：kind=command 时候选必为 CommandItem
        return;
      }
      const chip = $createChipNode(insertCommand(it.name));
      node.replace(chip);
      $selectAfter(chip);
    }
    closeMenu();
  }, []);

  // 面板渲染：沿用 PaletteMenu（.menu/.mi 视觉 + placePaletteCard 锚定 #composer 卡片上方，
  // 与旧版逐像素一致）；导航/高亮/接受走插件给的 itemProps
  const menuRenderFn: MenuRenderFn<PalOption> = (_anchorRef, itemProps) => (
    <PaletteMenu
      mode={taKind === "command" ? "command" : "file"}
      items={taItems}
      index={itemProps.selectedIndex ?? 0}
      loading={taLoading}
      composerRef={rootRef}
      onPick={(i) => {
        const opt = itemProps.options[i];
        if (opt) itemProps.selectOptionAndCleanUp(opt);
      }}
      onHover={(i) => itemProps.setHighlightedIndex(i)}
    />
  );
  const onTaOpen = useCallback(() => setTaOpen(true), []);
  const onTaClose = useCallback(() => setTaOpen(false), []);

  // ---- 附件处理：支持选文件/粘贴截图/拖拽文件入列 ----
  const addIncomingFiles = useCallback(async (picked: File[]) => {
    const added: (PromptAttachment & { id: number })[] = [];
    for (const file of picked) {
      if (file.size > MAX_ATTACH_BYTES) {
        toast(`「${file.name}」超过 10MB，未添加`);
        continue;
      }
      try {
        if (file.type.startsWith("image/")) {
          const dataUrl = await new Promise<string>((ok, no) => {
            const r = new FileReader();
            r.onload = () => ok(r.result as string); // readAsDataURL 结果必为 dataURL 字符串
            r.onerror = () => no(r.error);
            r.readAsDataURL(file);
          });
          const b64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
          added.push({ id: 0, name: file.name, kind: "image", mime: file.type, data: b64 });
        } else {
          added.push({ id: 0, name: file.name, kind: "text", mime: file.type || "text/plain", data: await file.text() });
        }
      } catch {
        toast(`读取「${file.name}」失败`);
      }
    }
    if (added.length === 0) return;
    // 附件入列 + 渲染触发合并为一次 setState（pendingFiles 容器换新引用）
    useAppStore.setState((st) => {
      let seq = st.fileSeq;
      const files = [...st.pendingFiles];
      for (const a of added) files.push({ ...a, id: ++seq });
      return { pendingFiles: files, fileSeq: seq };
    });
  }, []);

  // 附件选择（原 filePicker change 平移）
  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(e.target.files ?? [])];
    e.target.value = ""; // 允许重复选同一文件
    await addIncomingFiles(picked);
  };

  // ---- 剪贴板图片粘贴（Cmd+V 截屏识别） ----
  useEffect(() => {
    const comp = rootRef.current;
    if (!comp) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imgFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) {
            const ext = file.type.split("/")[1] || "png";
            const namedFile = new File([file], `screenshot-${Date.now()}.${ext}`, { type: file.type });
            imgFiles.push(namedFile);
          }
        }
      }
      if (imgFiles.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        void addIncomingFiles(imgFiles);
      }
    };
    comp.addEventListener("paste", onPaste, true);
    return () => comp.removeEventListener("paste", onPaste, true);
  }, [addIncomingFiles]);

  const [dragOver, setDragOver] = useState(false);
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(true);
    }
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = [...(e.dataTransfer.files ?? [])];
    if (files.length > 0) {
      void addIncomingFiles(files);
    }
  };

  // ---- 停止钮防连点复位（原 turn_end 重绘时复位 disabled） ----
  useEffect(() => {
    if (!canAbort) setStopPending(false);
  }, [canAbort]);

  // ---- 点外部 / 窗口失焦 / omp:close-menus 协调关菜单（原 window click/blur → closeAllMenus） ----
  useEffect(() => {
    const close = () => {
      setOpenMenu(null);
      closeTypeahead();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    document.addEventListener("omp:close-menus", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("omp:close-menus", close);
    };
  }, [closeTypeahead]);

  // ---- 卸载清理 @ 候选防抖定时器 ----
  useEffect(() => () => clearTimeout(mentionTimer.current ?? undefined), []);

  // ---- 底栏分级收缩（原 fitComposerBar 平移；bar-N 类为命令式追加，className prop 恒定 React 不会覆盖） ----
  const fit = () => {
    const comp = rootRef.current;
    const cbar = cbarRef.current;
    if (!comp) return;
    comp.classList.remove("bar-1", "bar-2", "bar-3", "bar-4", "bar-5");
    let stage = 0;
    if (cbar) {
      // 需求宽度 = 各可见子项 offsetWidth 之和 + 间隙（不用 scrollWidth：overflow:hidden 的
      // flex 容器在 WebKit 下对 flex:none 子项的 scrollWidth 被钳到 clientWidth，不可靠）
      const gap = parseFloat(window.getComputedStyle(cbar).columnGap) || 6;
      const needWidth = () => {
        const vis = [...cbar.children].filter(
          (k) => !k.classList.contains("sp") && (k as HTMLElement).offsetWidth > 0, // children 均为元素节点;offsetWidth 仅 HTMLElement 声明,收窄即可
        );
        return vis.reduce((a, k) => a + (k as HTMLElement).offsetWidth, 0) + gap * Math.max(0, vis.length - 1);
      };
      while (stage < BAR_STAGES && needWidth() > cbar.clientWidth) {
        stage++;
        comp.classList.add("bar-" + stage);
      }
    }
    if (stage !== barStageRef.current) {
      barStageRef.current = stage;
      // 阶段变化会移动按钮，打开中的菜单锚点随之失效，直接收起
      if (comp.querySelector(".menu.open")) {
        setOpenMenu(null);
        closeTypeahead();
      }
    }
  };
  useLayoutEffect(fit);
  // 窗口/分栏/缩放引起 composer 宽度变化时重新适配
  useEffect(() => {
    const comp = rootRef.current;
    if (!comp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(comp);
    return () => ro.disconnect();
  }, []);
  // 壳缩放后重算底栏收缩（zoom 不触发 ResizeObserver，shell.js 经 omp:zoom 通知）
  useEffect(() => {
    window.addEventListener("omp:zoom", fit);
    return () => window.removeEventListener("omp:zoom", fit);
  }, []);

  // ---- cbar 各按钮态 ----
  const modeMeta = MODE_META[approvalMode] ?? MODE_META["always-ask"];
  const menuDisabled = !(s || isCreatingNew); // 无会话且非新建态：模型/思考不可用

  // ---- 外部打开菜单信号（快捷键 Alt+M）：与 composerSetSignal 同款的一次性信号 ----
  useEffect(() => {
    const sig = menuSignal;
    if (!sig) return;
    useAppStore.setState({ menuSignal: null }); // 静默写（原同：清零本身不触发重渲染）
    // 信号由 keys.ts 按固定菜单名写入("model"/"think"/"mode"),断言收窄为本组件的菜单名联合
    const menuName = sig.name as MenuName;
    if (!menuDisabled) setOpenMenu(menuName);
  });

  const modelName = isCreatingNew || !s
    ? (newSessionModel ? (modelShort(newSessionModel) || "模型") : "模型")
    : modelShort(s.model) || "模型";
  const thinkLabel = s
    ? (s.thinking === "auto" && s.autoResolved ? `auto·${s.autoResolved}` : s.thinking || "思考")
    : newSessionThinking || "思考";
  const bgTasks = bgTaskCount(s);
  const bgSubs = subagentCount(s);

  // 菜单按钮通用开关：再点同钮收起，互斥由单 state 天然保证；
  // 打开前先协调全局菜单（设置页 Sel 等 DOM class 态菜单经 closeAllMenus 收起）
  const toggleMenu = (name: MenuName) => (e: MouseEvent) => {
    e.stopPropagation(); // 不冒泡给 window 级关闭监听
    if (openMenu !== name) closeAllMenus();
    setOpenMenu(openMenu === name ? null : name);
  };

  // 后台任务/子智能体按钮：展开并切换右栏对应 tab，再点收起右栏（原 right.js 绑定平移）
  const toggleBgTab = (tab: string) => () => {
    if (!s) return;
    const st = useAppStore.getState();
    if (!st.rightCollapsed && st.rightTab === tab) {
      setBump({ rightCollapsed: true });
    } else {
      setBump({ rightTab: tab, selectedFile: null, selectedSubagent: null, rightCollapsed: false, todoCollapsed: true }); // 展开右栏时进程卡让位收起（parts.jsx 同款）
    }
  };

  // Lexical 初始化配置：nodes 注册 ChipNode；editorState 取模块级草稿快照（挂载位切换恢复）
  const initialConfig = useMemo(
    () => ({
      namespace: "omp-composer",
      onError(error: Error) {
        throw error; // 快速失败：编辑器内部异常不静默吞
      },
      nodes: [ChipNode],
      editorState: getDraftState() ?? undefined,
    }),
    [],
  );

  const phText = inWelcome ? "使用 @ 添加上下文，使用 / 选择命令或能力" : "发消息…（Enter 发送）";

  return (
    <>
      <div
        id="composer"
        className={(inWelcome ? "in-welcome " : "") + (isBashMode(text) ? "bash-mode " : "") + (dragOver ? "ring-1 ring-accent " : "")}
        ref={rootRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-hidden={blocking ? true : undefined}
        style={blocking ? { display: "none" } : undefined}
      >
        <AttachRow />
        {CONTENT_EDITABLE_OK ? (
          <LexicalComposer initialConfig={initialConfig}>
            <div className="lex-wrap">
              <RichTextPlugin
                contentEditable={
                  <ContentEditable
                    id="input"
                    className="inp-ce"
                    aria-placeholder={phText}
                    placeholder={<span className="lex-ph">{phText}</span>}
                    aria-multiline={true}
                  />
                }
                placeholder={null}
                ErrorBoundary={LexicalErrorBoundary}
              />
            </div>
            <HistoryPlugin />
            <ComposerPlugin handleRef={lexRef} onTextChange={onTextChange} sendPrompt={sendPrompt} typeaheadOpenRef={taOpenRef} />
            {/* key 重挂 = 关闭面板通道（closeTypeahead）；triggerFn/onQueryChange 零依赖稳定，避免监听反复重注册 */}
            <LexicalTypeaheadMenuPlugin
              key={closeTick}
              parent={rootRef.current ?? undefined}
              triggerFn={triggerFn}
              onQueryChange={onQueryChange}
              options={taOptions}
              onSelectOption={onSelectOption}
              menuRenderFn={menuRenderFn}
              onOpen={onTaOpen}
              onClose={onTaClose}
            />
          </LexicalComposer>
        ) : (
          /* 无 contentEditable 语义环境（happy-dom 冒烟）的降级占位：不初始化 Lexical，编辑操作全部空转 */
          <div id="input" className="inp-ce" />
        )}
        <div className="cbar" ref={cbarRef}>
          <button className="icon-btn plus-btn" id="plusBtn" title="添加上下文" onClick={() => pickerRef.current?.click()}>
            <Icon name="plus" />
          </button>
          <button
            className={"pill-btn" + (openMenu === "mode" ? " active" : "") + (modeMeta.yolo ? " yolo highlight-mode" : "")}
            id="modeBtn"
            title="权限模式"
            ref={modeBtnRef}
            onClick={toggleMenu("mode")}
          >
            <Icon name={modeMeta.icon} id="modeIcon" />
            <span id="modeLabel">{modeMeta.label}</span> <Icon name="caret" className="caret-svg" style={{ color: "var(--faint)" }} />
          </button>
          {/* 计划模式（仅会话内可开）：胶囊右侧以 | 分隔的小按钮，hover 时图标变 X 表示点击退出 */}
          {s?.planMode && (
            <>
              <span className="cbar-sep" id="planSep">|</span>
              <button
                className="pill-btn plan-btn"
                id="planBtn"
                title="计划模式已开启，点击退出"
                onClick={() => send({ type: "set_plan_mode", sessionId: s.sessionId, enabled: false })}
              >
                <span className="plan-ic">
                  <Icon name="plan" size={16} />
                  <Icon name="xmark" size={14} />
                </span>
                <span id="planLabel">计划</span>
              </button>
            </>
          )}
          {bgTasks > 0 && (
            <button
              className={"pill-btn bg-task-btn has-running" + (!rightCollapsed && rightTab === "bgcmd" ? " on" : "")}
              id="bgTaskBtn"
              title="后台命令"
              disabled={!s}
              onClick={toggleBgTab("bgcmd")}
            >
              <Icon name="termBox" size={15} />
              <span className="bg-task-num" id="bgTaskNum">{s ? bgTasks : 0}</span>
            </button>
          )}
          {bgSubs > 0 && (
            <button
              className={"pill-btn bg-task-btn has-running" + (!rightCollapsed && rightTab === "subagent" ? " on" : "")}
              id="bgSubagentBtn"
              title="子智能体"
              disabled={!s}
              onClick={toggleBgTab("subagent")}
            >
              <Icon name="agents" size={15} />
              <span className="bg-task-num" id="bgSubagentNum">{s ? bgSubs : 0}</span>
            </button>
          )}
          <span className="sp"></span>
          <CtxRing s={s} ringRef={setCtxRingEl} />
          <CtxCard anchor={ctxRingEl} />
          <button
            className={"pill-btn" + (openMenu === "model" ? " active" : "")}
            id="modelBtn"
            title="切换模型"
            ref={modelBtnRef}
            disabled={menuDisabled}
            onClick={toggleMenu("model")}
          >
            <span id="modelIcon">{s?.model ? PROV_IC[s.model.split("/")[0]] || "✦" : "✦"}</span>
            <span id="modelLabel">{modelName}</span> <Icon name="caret" className="caret-svg" style={{ color: "var(--faint)" }} />
          </button>
          <button
            className={"pill-btn" + (openMenu === "think" ? " active" : "")}
            id="thinkBtn"
            title="思考级别"
            ref={thinkBtnRef}
            disabled={menuDisabled}
            onClick={toggleMenu("think")}
          >
            <Icon name="think" size={16} />
            <span id="thinkLabel">{thinkLabel}</span> <Icon name="caret" className="caret-svg" style={{ color: "var(--faint)" }} />
          </button>
          <button
            className={"send" + (hasDraft ? " ready" : "") + (canAbort ? " stopping" : "")}
            id="sendBtn"
            disabled={stopping && stopPending}
            title={
              escArmed
                ? "再按一次 Esc 中断生成"
                : stopping
                  ? bashRunning && !s?.streaming
                    ? "停止命令"
                    : "停止生成"
                  : s?.streaming
                    ? "发送（排队，当前任务完成后发出）"
                    : "发送"
            }
            onClick={() => {
              // 取消形态（停止生成 / Esc 示警窗口）：中止生成；发送形态：照常发送/排队
              if (canAbort) {
                if (stopPending) return;
                setStopPending(true); // 防连点：turn_end / bash_done 后复位
                // 中止仅在流式/命令运行中可用(此时 s 必在);escArmed 无会话路径不可达,可选链仅防御
                send({ type: bashRunning && !s?.streaming ? "bash_abort" : "abort_session", sessionId: s?.sessionId });
                return;
              }
              sendPrompt();
            }}
          >
            <Icon name={canAbort ? "stopSolid" : "arrowUp"} size={16} />
          </button>
        </div>
        {/* 权限模式（omp 三值，大行样式） */}
        {openMenu === "mode" && <ModeMenu btnRef={modeBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
        {/* 模型（宿主 enabledModels 过滤后下发，按 provider 分组；二级浮层为 #composer 直接子节点） */}
        {openMenu === "model" && <ModelMenu btnRef={modelBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
        <input type="file" id="filePicker" multiple hidden ref={pickerRef} onChange={onPick} />
        {/* 思考级别（只列当前模型支持的档位） */}
        {openMenu === "think" && <ThinkMenu btnRef={thinkBtnRef} composerRef={rootRef} onClose={() => setOpenMenu(null)} />}
      </div>
    </>
  );
}

// 上下文环（原 renderComposerBar 的 ctxRing 段平移）：从顶端顺时针填充；无数据空环；
// 新建态也展示空环。hover 弹上下文明细卡见 chat/CtxCard.jsx（ringRef 仅作锚点，不动内部 svg）
function CtxRing({ s, ringRef }: { s: { ctx?: { percent: number } } | null | undefined; ringRef: Ref<HTMLSpanElement> }) {
  const isCreatingNew = useAppStore((st) => st.isCreatingNew);
  if (!s && !isCreatingNew) return null;
  const p = s?.ctx ? Math.min(1, s.ctx.percent / 100) : 0;
  const cls = "ctx-ring" + (s?.ctx ? (s.ctx.percent >= 85 ? " hot" : s.ctx.percent >= 60 ? " warm" : "") : "");
  return (
    <span className={cls} id="ctxRing" title="" ref={ringRef}>
      <svg viewBox="0 0 16 16" width="14" height="14">
        <circle className="track" cx="8" cy="8" r="6.5" />
        <circle
          className="fill"
          id="ctxRingFill"
          cx="8"
          cy="8"
          r="6.5"
          transform="rotate(-90 8 8)"
          style={{ strokeDashoffset: String(RING_C * (1 - p)) }}
        />
      </svg>
    </span>
  );
}

// 模型显示名：modelNames 查表，无表项时取 id 尾段（原 renderComposerBar 同款）
function modelShort(id: string | null | undefined) {
  if (!id) return "";
  return useAppStore.getState().modelNames.get(id) ?? id.split("/").pop();
}
