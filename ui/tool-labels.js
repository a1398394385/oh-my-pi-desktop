// 工具标签注册表：主对话区动作行的「工具名 → 标签种类」映射与各标签行渲染。
// 加减工具标签只改本文件：toolKind() 加映射分支，下面加对应 render 函数，renderToolItem() 加 case。
// 共享渲染工具函数（省略号/文件标签/diff 展开等）在 tool-rows.js。
import { S, streamEl, send, activeOpen, invoke, toast } from "./core.js";
import { activateRightTab, renderRight, expandRightPanel } from "./right.js";
import { renderChat } from "./chat.js";
import {
  uniqueFiles,
  splitPath,
  ellipsizable,
  fileChip,
  chgExpand,
  appendCounts,
  liftEl,
  wireDiffToggle,
  attachFadeMask,
  buildEditBrief,
  openFileDiffInSidebar,
} from "./tool-rows.js";

export function renderCmd(item) {
  const command = item.args?.command || item.text || "";
  const wrap = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "cmd";
  const ic = document.createElement("span");
  ic.className = "c-ic";
  ic.innerHTML = icon("termBox", 14) + (item.name === "eval" ? "求值" : "终端");
  const tx = document.createElement("span");
  tx.className = "c-tx";
  tx.textContent = command || "";
  tx.title = command || "";
  div.append(ic, ellipsizable(tx));
  if (item.running) {
    const sp = document.createElement("span");
    sp.className = "cmd-spin";
    div.appendChild(sp);
  }
  const arrow = document.createElement("span");
  arrow.className = "ed-arrow" + (item.cmdExpanded ? " open" : "");
  arrow.innerHTML = icon("chevronRight");
  div.appendChild(arrow);
  div.style.cursor = "pointer";
  let cardEl = null;
  div.onclick = () => {
    item.cmdExpanded = !item.cmdExpanded;
    arrow.classList.toggle("open", item.cmdExpanded); // 同元素原地旋转，不跳动
    if (item.cmdExpanded) {
      if (!cardEl) {
        cardEl = buildCmdCard(command, item, true);
        div.after(cardEl);
      }
    } else {
      liftEl(cardEl ?? (div.nextElementSibling?.classList.contains("cmd-card") ? div.nextElementSibling : null));
      cardEl = null;
    }
  };
  wrap.appendChild(div);
  if (item.cmdExpanded) wrap.appendChild(buildCmdCard(command, item));
  return wrap;
}
// 终端行展开的圆角卡片：上命令、下输出；animate=true 时播放从上往下的揭示动画
function buildCmdCard(command, item, animate = false) {
  const card = document.createElement("div");
  card.className = "cmd-card" + (animate ? " drop" : "");
  const cmdEl = document.createElement("div");
  cmdEl.className = "cmd-card-cmd";
  cmdEl.textContent = command || "（无命令）";
  const outEl = document.createElement("pre");
  outEl.className = "cmd-card-out";
  outEl.textContent = item.output || (item.running ? "运行中…" : "（无输出）");
  card.append(attachFadeMask(cmdEl), attachFadeMask(outEl));
  return card;
}
// 后台工具（hub）：终端图标+后台标签+详细参数/输出展开
function renderHubTool(item) {
  const args = item.args || {};
  const op = args.op || "hub";
  const target = args.name || args.application || "";
  let summary = `hub ${op}${target ? " " + target : ""}`;
  if (args.application && Array.isArray(args.args)) {
    summary += `: ${args.application} ${args.args.join(" ")}`;
  } else if (args.command) {
    summary += `: ${args.command}`;
  } else if (args.text) {
    summary += `: ${args.text}`;
  }

  const wrap = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "cmd";
  const ic = document.createElement("span");
  ic.className = "c-ic";
  ic.innerHTML = icon("termBox", 13) + "后台";
  const tx = document.createElement("span");
  tx.className = "c-tx";
  tx.textContent = summary;
  tx.title = summary;
  div.append(ic, ellipsizable(tx));
  if (item.running) {
    const sp = document.createElement("span");
    sp.className = "cmd-spin";
    div.appendChild(sp);
  }
  const arrow = document.createElement("span");
  arrow.className = "ed-arrow" + (item.cmdExpanded ? " open" : "");
  arrow.innerHTML = icon("chevronRight");
  div.appendChild(arrow);
  div.style.cursor = "pointer";
  let cardEl = null;
  div.onclick = () => {
    item.cmdExpanded = !item.cmdExpanded;
    arrow.classList.toggle("open", item.cmdExpanded);
    if (item.cmdExpanded) {
      if (!cardEl) {
        cardEl = buildCmdCard(summary, item, true);
        div.after(cardEl);
      }
    } else {
      liftEl(cardEl ?? (div.nextElementSibling?.classList.contains("cmd-card") ? div.nextElementSibling : null));
      cardEl = null;
    }
  };
  wrap.appendChild(div);
  if (item.cmdExpanded) wrap.appendChild(buildCmdCard(summary, item));
  return wrap;
}
export function renderThink(item) {
  const wrap = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "act think";
  const ic = document.createElement("span");
  ic.className = "th-ic";
  ic.innerHTML = icon("think");
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = item.text || "思考 · 持续了几秒";
  div.append(ic, lbl);
  if (item.expandable || item.thinking) {
    const more = document.createElement("span");
    more.className = "th-more" + (item.expanded ? " open" : "");
    more.innerHTML = icon("chevronRight", 10);
    div.appendChild(more);
    div.style.cursor = "pointer";
    div.onclick = () => {
      item.expanded = !item.expanded;
      more.classList.toggle("open", item.expanded); // 同元素原地旋转，不跳动
      if (item.expanded) {
        S.animateThinkBody = true; // 本次 renderChat 的 think-body 播放入场动画
        // 展开：以被点击行为锚，重绘后恢复其视口位置。贴底时 renderChat 会钉住底部，
        // 不锚定的话展开体反而把整流往上顶、标签变成展开体下边界；锚定后展开体向下推挤下方内容
        if (!item.__tk) item.__tk = Math.random().toString(36).slice(2);
        div.dataset.thinkKey = item.__tk;
        const topBefore = div.getBoundingClientRect().top;
        renderChat();
        S.animateThinkBody = false;
        const anchor = streamEl.querySelector('[data-think-key="' + item.__tk + '"]');
        if (anchor) streamEl.scrollTop += anchor.getBoundingClientRect().top - topBefore;
      } else {
        // 收起：本地动画移除展开体（不整流重绘），点击行不动，下方内容上收
        liftEl(div.nextElementSibling?.classList.contains("think-body") ? div.nextElementSibling : null);
      }
    };
  }
  wrap.appendChild(div);
  if (item.expanded && (item.thinking || item.streaming)) {
    const body = document.createElement("div");
    body.className = "think-body";
    if (S.animateThinkBody) body.classList.add("kids-in");
    // 滚动职责在内层 .think-scroll：外层保持自然高度，左侧竖线(::before)不随滚动移出视口
    const sc = document.createElement("div");
    sc.className = "think-scroll";
    sc.textContent = item.thinking || "…";
    body.appendChild(sc);
    // 滚到底(或内容不足一屏)时解除底部虚化,否则遮住最末半行制造截断感
    const syncFade = () => {
      sc.classList.toggle("no-fade", sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1);
    };
    sc.addEventListener("scroll", syncFade, { passive: true });
    requestAnimationFrame(syncFade);
    wrap.appendChild(body);
  }
  return wrap;
}

function renderEdit(item) {
  const files = uniqueFiles(item.files?.length ? item.files : item.args?.files || (item.args?.path ? [item.args.path] : []));
  const path = files[0] || "";
  const wrap = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "act edit";
  div.insertAdjacentHTML("beforeend", icon("pencil"));
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = item.removed > 0 ? "编辑" : "写入"; // 只有写入没有删除 → 「写入」
  div.appendChild(lbl);
  if (path) {
    div.appendChild(
      fileChip(path, {
        nameClass: "ed-name",
        onNameClick: () => openFileDiffInSidebar(path),
      }),
    );
  } else {
    div.appendChild(document.createTextNode(item.name || item.text || ""));
  }
  appendCounts(div, item);
  wireDiffToggle(div, item, path);
  wrap.appendChild(div);
  if (item.diffExpanded && path) wrap.appendChild(buildEditBrief(path));
  return wrap;
}
function renderChange(item) {
  if (item.group) return renderChangeGroup(item.group); // 连续编辑事件合并组
  const files = uniqueFiles(item.files?.length ? item.files : item.args?.files || []);
  const div = document.createElement("div");
  div.className = "act change";
  div.insertAdjacentHTML("beforeend", icon("pencil"));
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = `更改 · ${files.length || "多"} 个文件`;
  div.appendChild(lbl);
  if (files.length) {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "·";
    div.appendChild(document.createTextNode(" "));
    div.appendChild(sep);
    div.appendChild(document.createTextNode(" "));
    // 文件列表单行排布，超长在行尾出省略号
    const lane = document.createElement("span");
    lane.className = "chips-lane";
    for (const f of files) {
      lane.appendChild(fileChip(f));
      lane.appendChild(document.createTextNode(" "));
    }
    div.appendChild(lane);
  }
  return div;
}
// 连续编辑事件合并的「更改」组：标题行点击向下展开各条编辑（内行无「编辑」标签，与「更改」左对齐）
function renderChangeGroup(subs) {
  const files = uniqueFiles(subs.flatMap((g) => g.files?.length ? g.files : g.args?.files || (g.args?.path ? [g.args.path] : [])));
  const wrap = document.createDocumentFragment();
  const div = document.createElement("div");
  div.className = "act change";
  div.insertAdjacentHTML("beforeend", icon("pencil"));
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = `更改 · ${files.length || "多"} 个文件`;
  div.appendChild(lbl);
  const arrow = document.createElement("span");
  arrow.className = "ed-arrow" + (chgExpand.has(subs[0]) ? " open" : "");
  arrow.innerHTML = icon("chevronRight");
  div.appendChild(arrow);
  div.style.cursor = "pointer";
  let bodyEl = null;
  div.onclick = () => {
    const on = !chgExpand.has(subs[0]);
    if (on) chgExpand.set(subs[0], true);
    else chgExpand.delete(subs[0]);
    arrow.classList.toggle("open", on); // 同元素原地旋转，不跳动
    // 原地插入/移除展开体，不整行重建；全量重绘后闭包 bodyEl 丢失，回退摘取紧邻的展开体节点
    if (on) {
      if (!bodyEl) {
        bodyEl = buildChangeBody(subs, true);
        div.after(bodyEl);
      }
    } else {
      liftEl(bodyEl ?? (div.nextElementSibling?.classList.contains("chg-body") ? div.nextElementSibling : null));
      bodyEl = null;
    }
  };
  wrap.appendChild(div);
  if (chgExpand.has(subs[0])) wrap.appendChild(buildChangeBody(subs));
  return wrap;
}
// 更改组展开体：每条编辑事件一行（文件标签 + 行数 + 展开箭头），行点击展开内联 diff
function buildChangeBody(subs, animate = false) {
  const body = document.createElement("div");
  body.className = "chg-body" + (animate ? " drop" : "");
  for (const sub of subs) {
    body.appendChild(buildChangeRow(sub));
    const path = uniqueFiles(sub.files?.length ? sub.files : sub.args?.files || (sub.args?.path ? [sub.args.path] : []))[0] || "";
    if (sub.diffExpanded && path) body.appendChild(buildEditBrief(path));
  }
  return body;
}
// 更改组内行：完整编辑标签（标签文字 + 文件 + 行数 + 展开箭头），仅去掉行首铅笔图标
function buildChangeRow(sub) {
  const files = uniqueFiles(sub.files?.length ? sub.files : sub.args?.files || (sub.args?.path ? [sub.args.path] : []));
  const path = files[0] || "";
  const row = document.createElement("div");
  row.className = "chg-item";
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = sub.removed > 0 ? "编辑" : "写入"; // 与编辑行同一判定：只有写入没有删除 → 「写入」
  row.appendChild(lbl);
  if (files.length > 1) {
    // 单条事件涉及多文件（apply_patch）：文件标签单行排布，超长行尾出省略号
    const lane = document.createElement("span");
    lane.className = "chips-lane";
    for (const f of files) {
      lane.appendChild(fileChip(f));
      lane.appendChild(document.createTextNode(" "));
    }
    row.appendChild(lane);
  } else if (path) {
    row.appendChild(
      fileChip(path, {
        nameClass: "ed-name",
        onNameClick: () => openFileDiffInSidebar(path),
      }),
    );
  } else {
    row.appendChild(document.createTextNode(sub.name || sub.text || ""));
  }
  appendCounts(row, sub);
  wireDiffToggle(row, sub, path);
  return row;
}
function renderTodo(item) {
  const td = item.todo;
  const content = td?.content || item.args?.task || item.args?.i || item.text || "";
  const div = document.createElement("div");
  div.className = "act todo";
  div.insertAdjacentHTML("beforeend", icon("todo"));
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "待办";
  div.appendChild(lbl);
  const tx = document.createElement("span");
  tx.className = "td-tx";
  tx.textContent = content;
  tx.title = content;
  div.appendChild(ellipsizable(tx));
  if (td && td.total > 0) {
    const n = document.createElement("span");
    n.className = "td-n";
    n.textContent = `${td.done}/${td.total}`;
    div.appendChild(n);
  }
  return div;
}
function renderRead(item) {
  const path = uniqueFiles(item.files?.length ? item.files : item.args?.path ? [item.args.path] : [])[0] || "";
  const { dir, name } = splitPath(path);
  const div = document.createElement("div");
  div.className = "act read";
  div.insertAdjacentHTML("beforeend", icon("read"));
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "读取";
  div.appendChild(lbl);
  if (path) {
    // 读到过文本内容的读取行：文件名可点击（hover 下划线），右栏文件视图按行号范围展示
    const hasContent = !!(item.details?.displayContent?.text);
    div.appendChild(
      fileChip(
        path,
        hasContent ? { nameClass: "ed-name", onNameClick: () => openReadFileInSidebar(item, path) } : {},
      ),
    );
    div.appendChild(document.createTextNode(" "));
    if (dir) {
      const p = document.createElement("span");
      p.className = "path";
      p.textContent = dir;
      p.title = path;
      div.appendChild(ellipsizable(p));
    }
  } else {
    div.appendChild(document.createTextNode(item.text || "read"));
  }
  return div;
}
// 点击读取行文件名：文件页先用读取到的内容即时渲染，同时请求全文件——回包后整文件展示并高亮/定位读取范围
function openReadFileInSidebar(item, path) {
  const d = item.details;
  if (!d?.displayContent?.text) return;
  // 原始路径可能带行号选择器（path:59-123）：解析出请求范围用于行号高亮，并剥掉后缀得到干净路径
  const raw = String(d.resolvedPath || path);
  const m = raw.match(/:(\d+)(?:-(\d+))?$/);
  let clean = m ? raw.slice(0, m.index) : raw;
  if (!clean.startsWith("/")) clean = (activeOpen()?.cwd || "") + "/" + clean;
  S.fileView = {
    path: clean,
    text: d.displayContent.text,
    startLine: d.displayContent.startLine || 1,
    lineNumbers: Array.isArray(d.displayContent.lineNumbers) ? d.displayContent.lineNumbers : null,
    reqRange: m ? [Number(m[1]), Number(m[2] || m[1])] : null,
  };
  S.fileViewPending = clean;
  send({ type: "read_file", path: clean });
  activateRightTab("file");
  expandRightPanel();
  renderRight();
}
// 简单标签行的共用骨架：图标 + 中文标签 + 一段可省略的摘要文本
function simpleLabelRow(iconName, label, summary, summaryTitle) {
  const div = document.createElement("div");
  div.className = "act read";
  div.insertAdjacentHTML("beforeend", icon(iconName));
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = label;
  div.appendChild(lbl);
  const tx = document.createElement("span");
  tx.className = "path";
  tx.textContent = summary;
  tx.title = summaryTitle || summary;
  div.appendChild(ellipsizable(tx));
  return div;
}
function renderGenericTool(item) {
  const div = document.createElement("div");
  div.className = "act";
  div.textContent = item.name || item.text || "";
  return div;
}
// grep 行：放大镜图标 + 「搜索」+ 模式串（截断省略）
function renderGrep(item) {
  const div = document.createElement("div");
  div.className = "act read";
  div.insertAdjacentHTML("beforeend", icon("read"));
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "搜索";
  div.appendChild(lbl);
  const pat = item.args?.pattern || item.text || "";
  const tx = document.createElement("span");
  tx.className = "path";
  tx.textContent = pat;
  tx.title = pat;
  div.appendChild(ellipsizable(tx));
  const dir = item.args?.path ? splitPath(String(item.args.path)).dir : "";
  if (dir) {
    const p = document.createElement("span");
    p.className = "path";
    p.textContent = dir;
    div.appendChild(ellipsizable(p));
  }
  return div;
}
// glob 行：文件图标 + 「查找」+ 说明/模式 + 目录
function renderGlob(item) {
  const div = document.createElement("div");
  div.className = "act read";
  div.insertAdjacentHTML("beforeend", icon("ftFile"));
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "查找";
  div.appendChild(lbl);
  const pat = item.args?.pattern || item.text || "";
  const tx = document.createElement("span");
  tx.className = "path";
  tx.textContent = pat;
  tx.title = pat;
  div.appendChild(ellipsizable(tx));
  const dir = item.args?.path ? splitPath(String(item.args.path)).dir : "";
  if (dir) {
    const p = document.createElement("span");
    p.className = "path";
    p.textContent = dir;
    div.appendChild(ellipsizable(p));
  }
  return div;
}
// 内容展开卡：上参数（args 美化 JSON）、下结果（output / details），与终端行展开卡同款样式
function buildContentCard(item, animate = false) {
  const card = document.createElement("div");
  card.className = "cmd-card" + (animate ? " drop" : "");
  // ask 的 questions 结构化展示（问题 + 选项），其余工具仍是 args JSON
  const argsEl =
    item.name === "ask" && Array.isArray(item.args?.questions)
      ? buildAskArgs(item.args.questions)
      : (() => {
          const d = document.createElement("div");
          d.className = "cmd-card-cmd";
          d.textContent = truncateText(item.args ? JSON.stringify(item.args, null, 2) : "（无参数）");
          return d;
        })();
  const outEl = document.createElement("pre");
  outEl.className = "cmd-card-out";
  const detailText = item.details?.displayContent?.text;
  const outText =
    item.output ||
    detailText ||
    (item.details ? truncateText(JSON.stringify(item.details, null, 2)) : "") ||
    (item.running ? "运行中…" : "（无输出）");
  appendLinkedText(outEl, outText); // 结果里的 URL 变可点击链接
  card.append(attachFadeMask(argsEl), attachFadeMask(outEl));
  return card;
}
// 外链识别：URL 本体可含 . : / 等，只有尾部悬挂标点剥离
const LINK_RE = /https?:\/\/[^\s<>"'，、。；：！？]+/u;
const TRAIL_PUNCT_RE = /[.,;:!?，、。；：！？)\]}〉》」』】'"”’]+$/u;
// 系统浏览器打开外链：Tauri 走 opener 插件，纯浏览器开发环境降级 window.open；失败弹提示
async function openExternal(url) {
  try {
    if (invoke) await invoke("plugin:opener|open_url", { url });
    else window.open(url, "_blank", "noopener");
  } catch (err) {
    toast(`打开链接失败：${err}`);
  }
}
// 文本写入容器并把 URL 段替换为链接：仅 Cmd+点击外开，普通点击不触发 webview 内导航
function appendLinkedText(el, text) {
  let rest = String(text);
  for (;;) {
    const m = rest.match(LINK_RE);
    if (!m) break;
    if (m.index > 0) el.appendChild(document.createTextNode(rest.slice(0, m.index)));
    const url = m[0].replace(TRAIL_PUNCT_RE, ""); // 尾部标点留在文本里
    const a = document.createElement("a");
    a.className = "ext-link";
    a.textContent = url;
    a.title = "⌘+点击在默认浏览器打开";
    a.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation(); // 不冒泡到整行的展开/收起点击
      if (e.metaKey) openExternal(url);
    };
    el.appendChild(a);
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) el.appendChild(document.createTextNode(rest));
}
// ask 参数体：问题列表 + 选项（★ 推荐项），不展示原始 JSON
function buildAskArgs(questions) {
  const box = document.createElement("div");
  box.className = "cmd-card-cmd ask-args";
  questions.forEach((q, i) => {
    if (!q || typeof q !== "object") return;
    const item = document.createElement("div");
    item.className = "ask-q";
    const t = document.createElement("div");
    t.className = "ask-q-t";
    t.textContent = `${i + 1}. ${q.question || ""}${q.multi ? "（多选）" : ""}`;
    item.appendChild(t);
    if (q.header) {
      const h = document.createElement("span");
      h.className = "ask-q-h";
      h.textContent = q.header;
      t.appendChild(h);
    }
    for (const [j, opt] of (Array.isArray(q.options) ? q.options : []).entries()) {
      const o = document.createElement("div");
      o.className = "ask-opt" + (q.recommended === j ? " rec" : "");
      o.textContent = `${q.recommended === j ? "★ " : "• "}${opt?.label || ""}${opt?.description ? ` — ${opt.description}` : ""}`;
      item.appendChild(o);
    }
    box.appendChild(item);
  });
  return box;
}
function truncateText(s, max = 4000) {
  s = String(s);
  return s.length > max ? s.slice(0, max) + ` …(截断,共${s.length}字)` : s;
}
// 标签行点击展开内容卡：行尾箭头原地旋转，展开体就地插入/移除（与终端行同一交互）
function wireContentToggle(row, item) {
  const arrow = document.createElement("span");
  arrow.className = "ed-arrow" + (item.cmdExpanded ? " open" : "");
  arrow.innerHTML = icon("chevronRight");
  row.appendChild(arrow);
  row.style.cursor = "pointer";
  let cardEl = null;
  row.onclick = () => {
    item.cmdExpanded = !item.cmdExpanded;
    arrow.classList.toggle("open", item.cmdExpanded); // 同元素原地旋转，不跳动
    if (item.cmdExpanded) {
      if (!cardEl) {
        cardEl = buildContentCard(item, true);
        row.after(cardEl);
      }
    } else {
      liftEl(cardEl ?? (row.nextElementSibling?.classList.contains("cmd-card") ? row.nextElementSibling : null));
      cardEl = null;
    }
  };
}
// 可展开简单标签行：图标 + 中文标签 + 摘要，点击向下展开 参数+结果 卡片
function expandableLabelRow(item, iconName, label, summary, summaryTitle) {
  const wrap = document.createDocumentFragment();
  const div = simpleLabelRow(iconName, label, summary, summaryTitle);
  wireContentToggle(div, item);
  wrap.appendChild(div);
  if (item.cmdExpanded) wrap.appendChild(buildContentCard(item));
  return wrap;
}
// 联网搜索行：地球图标 + 「联网搜索」+ 查询词（截断省略），点击展开参数与搜索结果
function renderWebSearch(item) {
  return expandableLabelRow(item, "globe", "联网搜索", item.args?.query || item.text || "");
}
// 提问行：对话图标 + 「提问」+ 首个问题（多个时 +N），点击展开完整问题与回答
function renderAsk(item) {
  const qs = Array.isArray(item.args?.questions) ? item.args.questions : [];
  const first = qs[0]?.question || item.text || "";
  const summary = qs.length > 1 ? `${first} +${qs.length - 1}` : first;
  const title = qs.map((q) => q?.question || "").filter(Boolean).join("\n");
  return expandableLabelRow(item, "comment", "提问", summary, title || summary);
}
// 调试行：显示器图标 + 「调试」+ 动作与目标（launch 程序 / file:line），点击展开参数与调试输出
function renderDebug(item) {
  const args = item.args || {};
  const action = args.action ? String(args.action).replaceAll("_", " ") : "request";
  const target = args.program || (args.file ? `${args.file}${args.line ? `:${args.line}` : ""}` : "");
  return expandableLabelRow(item, "monitor", "调试", target ? `${action} ${target}` : action);
}
// GitHub 行：分支图标 + 「GitHub」+ 操作与对象（repo/path/query/title），点击展开参数与响应
function renderGithub(item) {
  const args = item.args || {};
  const op = args.op || "";
  const target = args.repo || args.path || args.query || args.title || args.pr || "";
  return expandableLabelRow(item, "branch", "GitHub", target ? `${op} ${target}` : op || item.text || "github");
}
// LSP 行：搜索图标 + 「LSP」+ 动作与符号/文件，点击展开参数与响应
function renderLsp(item) {
  const args = item.args || {};
  const action = args.action || "";
  const target = args.symbol || args.new_name || (args.file ? `${args.file}${args.line ? `:${args.line}` : ""}` : "");
  return expandableLabelRow(item, "search", "LSP", target ? `${action} ${target}` : action || item.text || "lsp");
}
// 记忆五件套（retain/recall/reflect/learn/memory_edit）共用一行：记忆图标 + 「记忆」+ 摘要，点击展开参数与结果
function renderMemory(item) {
  const args = item.args || {};
  const memories = Array.isArray(args.memories) ? args.memories : [];
  const first = memories[0]?.content || "";
  const summary =
    args.query || // recall/reflect：检索问题
    args.memory || // learn：经验教训
    first || // retain：首条记忆
    (args.id ? `${args.op || "update"} ${args.id}` : "") || // memory_edit：操作 + 记忆 id
    item.text ||
    "memory";
  const title = memories.length > 1 ? memories.map((m) => m?.content || "").filter(Boolean).join("\n") : "";
  return expandableLabelRow(item, "memory", "记忆", memories.length > 1 ? `${summary} +${memories.length - 1}` : summary, title);
}
function renderMcp(item) {
  const div = document.createElement("div");
  div.className = "act mcp";
  div.insertAdjacentHTML("beforeend", icon("plug"));
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "MCP";
  div.appendChild(lbl);
  const tool = String(item.name || "").split("__").slice(2).join("__");
  if (tool) {
    const t = document.createElement("span");
    t.className = "path";
    t.textContent = ` ${tool}`;
    t.title = item.name;
    div.appendChild(ellipsizable(t));
  }
  return div;
}
// 工具名 → 标签种类映射。新工具在此加分支，并在 renderToolItem() 加 case 指向渲染函数。
function toolKind(item) {
  if (item.group) return "change"; // 连续编辑事件合并组
  const name = item.name || item.text || "";
  if (item.role === "thinking" || name === "thinking") return "think";
  if (name === "bash" || name === "shell" || name === "eval") return "cmd";
  if (name === "hub") return "hub";
  if (name === "grep" || name === "ast-grep") return "grep";
  if (name === "glob") return "glob";
  if (name.startsWith("mcp__")) return "mcp";
  if (name === "todo") return "todo";
  if (name === "read") return "read";
  if (name === "web_search") return "websearch";
  if (name === "ask") return "ask";
  if (name === "debug") return "debug";
  if (name === "github") return "github";
  if (name === "lsp") return "lsp";
  if (name === "memory_edit" || name === "retain" || name === "recall" || name === "reflect" || name === "learn") return "memory";
  if (name === "edit" || name === "write" || name === "apply_patch") {
    const n = uniqueFiles(item.files || item.args?.files || (item.args?.path ? [item.args.path] : [])).length;
    return n > 1 ? "change" : "edit";
  }
  return "generic";
}
export function renderToolItem(item) {
  switch (toolKind(item)) {
    case "think":
      return renderThink(item);
    case "cmd":
      return renderCmd(item);
    case "hub":
      return renderHubTool(item);
    case "grep":
      return renderGrep(item);
    case "glob":
      return renderGlob(item);
    case "mcp":
      return renderMcp(item);
    case "todo":
      return renderTodo(item);
    case "read":
      return renderRead(item);
    case "websearch":
      return renderWebSearch(item);
    case "ask":
      return renderAsk(item);
    case "debug":
      return renderDebug(item);
    case "github":
      return renderGithub(item);
    case "lsp":
      return renderLsp(item);
    case "memory":
      return renderMemory(item);
    case "change":
      return renderChange(item);
    case "edit":
      return renderEdit(item);
    default:
      return renderGenericTool(item);
  }
}
