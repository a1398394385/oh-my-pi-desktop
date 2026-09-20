// 设置·MCP 页：多源全量发现、红绿灯状态、iOS 开关、实时搜索、行内延展编辑表单。
import { $, S, send, toast } from "../core.js";
import { escapeHtml } from "../markdown.js";
import { wireSel } from "./index.js";

let mcpScope = "all"; // "all" / "profile" / "project:<cwd>"
let mcpSearchQuery = "";
let mcpEditingServer = null;
let mcpEventsWired = false;
let mcpFormTransport = "stdio"; // "stdio" | "http" | "sse"

function currentMcpScopes() {
  const mcp = S.agentAssets?.mcp;
  if (!mcp || !Array.isArray(mcp.scopes)) {
    return [{ id: "all", name: "全部工作区", count: 0 }];
  }
  return mcp.scopes;
}

function getActiveMcpScope() {
  const scopes = currentMcpScopes();
  let found = scopes.find((s) => s.id === mcpScope);
  if (!found) {
    mcpScope = "all";
    found = scopes[0] || { id: "all", name: "全部工作区", count: 0 };
  }
  return found;
}

function getScopedMcpServers() {
  const allServers = S.agentAssets?.mcp?.servers || [];
  if (mcpScope === "all") return allServers;
  if (mcpScope === "profile") return allServers.filter((s) => s.scope === "profile");
  return allServers.filter((s) => s.scope === mcpScope);
}

export function renderMcpPage() {
  const curScope = getActiveMcpScope();
  const allScopes = currentMcpScopes();
  const scopeServers = getScopedMcpServers();

  // 更新作用域按钮文字与图标
  const labelEl = $("mcpScopeLabel");
  if (labelEl) labelEl.textContent = curScope.name;
  const iconSpan = $("mcpScopeBtn")?.querySelector(".mcp-scope-icon");
  if (iconSpan) {
    const iconName = curScope.id === "profile" ? "scopeProfile" : "folder";
    iconSpan.innerHTML = icon(iconName, 14);
  }

  // 渲染作用域下拉菜单
  const menu = $("mcpScopeMenu");
  if (menu) {
    menu.replaceChildren();
    allScopes.forEach((s, i) => {
      if (i > 0 && (s.id === "profile" || (allScopes[i - 1].id === "profile" && s.id.startsWith("project:")))) {
        menu.appendChild(Object.assign(document.createElement("div"), { className: "sep" }));
      }
      const mi = document.createElement("div");
      mi.className = "mi";
      mi.dataset.scope = s.id;
      const ck = document.createElement("span");
      ck.className = "ck";
      ck.textContent = "✓";
      ck.style.visibility = s.id === curScope.id ? "visible" : "hidden";
      const lb = document.createElement("span");
      lb.className = "mi-label";
      lb.textContent = s.name;
      lb.title = s.name;
      mi.appendChild(ck);
      const ic = icon(s.id === "profile" ? "scopeProfile" : "folder", 13);
      if (ic) mi.insertAdjacentHTML("beforeend", ic);
      mi.appendChild(lb);
      menu.appendChild(mi);
    });
  }

  // 统计数值
  const totalCount = scopeServers.length;
  const installedCount = scopeServers.filter((s) => s.enabled).length;
  if ($("mcpTotalCount")) $("mcpTotalCount").textContent = `MCP ${totalCount}`;
  if ($("mcpInstalledLabel")) $("mcpInstalledLabel").textContent = `已安装 ${installedCount}`;

  renderMcpList();

  if (!mcpEventsWired) {
    initMcpEvents();
    mcpEventsWired = true;
  }
}

function renderMcpList() {
  closeMcpEditor(); // 重建列表前先收起延展区，避免引用已被移除的 DOM
  const listEl = $("mcpServerList");
  if (!listEl) return;

  listEl.replaceChildren();

  const scopeServers = getScopedMcpServers();
  const q = mcpSearchQuery.trim().toLowerCase();
  const filtered = scopeServers.filter((s) => {
    if (!q) return true;
    const nameMatch = s.name.toLowerCase().includes(q);
    const cmdMatch = s.command && s.command.toLowerCase().includes(q);
    const argsMatch = Array.isArray(s.args) && s.args.some((a) => a.toLowerCase().includes(q));
    const urlMatch = s.url && s.url.toLowerCase().includes(q);
    const errMatch = s.error && s.error.toLowerCase().includes(q);
    return nameMatch || cmdMatch || argsMatch || urlMatch || errMatch;
  });

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "mcp-empty-row";
    empty.textContent = q ? "未找到匹配的 MCP 服务器" : "当前工作区下暂无 MCP 服务器";
    listEl.appendChild(empty);
    return;
  }

  for (const s of filtered) {
    const row = document.createElement("div");
    row.className = "mcp-server-row" + (s.enabled ? "" : " disabled");
    row.dataset.name = s.name;

    // 状态点样式与标题
    let dotClass = "off";
    let dotTitle = "已禁用";
    if (s.enabled) {
      if (s.status === "connected") {
        dotClass = "ok";
        dotTitle = "运行中 / 已连接";
      } else if (s.status === "error") {
        dotClass = "err";
        dotTitle = "连接异常";
      } else {
        dotClass = "ok";
        dotTitle = "就绪";
      }
    }

    // 左侧图标容器
    const iconBox = document.createElement("div");
    iconBox.className = "mcp-icon-box";
    iconBox.innerHTML = icon("mcp", 18);
    const statusDot = document.createElement("span");
    statusDot.className = `mcp-status-dot ${dotClass}`;
    statusDot.title = dotTitle;
    iconBox.appendChild(statusDot);

    // 中间服务信息
    const info = document.createElement("div");
    info.className = "mcp-server-info";
    info.title = "点击查看或编辑配置";

    const head = document.createElement("div");
    head.className = "mcp-server-head";
    const nameSpan = document.createElement("span");
    nameSpan.className = "mcp-server-name";
    nameSpan.textContent = s.name;
    head.appendChild(nameSpan);

    // 协议或来源徽标
    if (s.transport) {
      const trBadge = document.createElement("span");
      trBadge.className = "mcp-server-badge";
      trBadge.textContent = s.transport;
      head.appendChild(trBadge);
    }
    if (mcpScope === "all") {
      const srcName = s.projectName || s.source?.providerName;
      if (srcName) {
        const srcBadge = document.createElement("span");
        srcBadge.className = "mcp-server-badge";
        srcBadge.textContent = srcName;
        head.appendChild(srcBadge);
      }
    }
    info.appendChild(head);

    // 命令或 URL
    const cmdLine = document.createElement("div");
    cmdLine.className = "mcp-server-cmd";
    const cmdText = s.command ? [s.command, ...(s.args || [])].filter(Boolean).join(" ") : (s.url || "");
    cmdLine.textContent = cmdText;
    cmdLine.title = cmdText;
    info.appendChild(cmdLine);

    // 错误详情展示（红字 + ⓘ 提示）
    if (s.enabled && s.status === "error" && s.error) {
      const errDiv = document.createElement("div");
      errDiv.className = "mcp-server-err";
      errDiv.innerHTML = `<span class="mcp-err-icon" title="错误详情">ⓘ</span><span>${escapeHtml(s.error)}</span>`;
      info.appendChild(errDiv);
    }

    // 右侧开关控制
    const ctrl = document.createElement("div");
    ctrl.className = "mcp-server-ctrl";

    const toggle = document.createElement("div");
    toggle.className = "tg" + (s.enabled ? " on" : "");
    toggle.title = s.enabled ? "已启用，点击禁用" : "已禁用，点击启用";
    toggle.appendChild(document.createElement("i"));

    toggle.onclick = (e) => {
      e.stopPropagation();
      const nextEnabled = !s.enabled;
      s.enabled = nextEnabled;
      toggle.classList.toggle("on", nextEnabled);
      toggle.title = nextEnabled ? "已启用，点击禁用" : "已禁用，点击启用";
      row.classList.toggle("disabled", !nextEnabled);
      statusDot.className = `mcp-status-dot ${nextEnabled ? (s.status === "error" ? "err" : "ok") : "off"}`;
      statusDot.title = nextEnabled ? (s.status === "error" ? "连接异常" : "运行中") : "已禁用";

      const curScopeServers = getScopedMcpServers();
      const instCount = curScopeServers.filter((item) => item.enabled).length;
      if ($("mcpInstalledLabel")) $("mcpInstalledLabel").textContent = `已安装 ${instCount}`;

      send({
        type: "set_mcp_server_enabled",
        name: s.name,
        enabled: nextEnabled,
        cwd: s.cwd,
        sourcePath: s.source?.path,
      });
    };

    ctrl.appendChild(toggle);

    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.innerHTML = icon("caretSlim");

    row.appendChild(iconBox);
    row.appendChild(info);
    row.appendChild(ctrl);
    row.appendChild(caret);
    row.onclick = () => toggleMcpEditor(row, s);
    listEl.appendChild(row);
  }
}

export function handleMcpServerTested(msg) {
  const statusEl = $("mcpModalStatus");
  const testBtn = $("mcpModalTestBtn");
  if (testBtn) {
    testBtn.disabled = false;
    testBtn.textContent = "测试连接";
  }
  if (statusEl) {
    if (msg.status === "ok") {
      statusEl.style.color = "var(--green)";
      statusEl.textContent = "连接成功";
    } else {
      statusEl.style.color = "var(--err)";
      statusEl.textContent = msg.error || "连接失败";
    }
  }

  // 同步更新本地状态与对应行状态点（局部更新，不重建列表——重建会收起行内延展的编辑区）
  const allServers = S.agentAssets?.mcp?.servers || [];
  const target = allServers.find((s) => s.name === msg.name);
  if (target) {
    target.status = msg.status === "ok" ? "connected" : "error";
    target.error = msg.error;
    const row = $("mcpServerList")?.querySelector(`.mcp-server-row[data-name="${CSS.escape(msg.name)}"]`);
    const dot = row?.querySelector(".mcp-status-dot");
    if (dot) {
      dot.className = `mcp-status-dot ${target.enabled ? (msg.status === "ok" ? "ok" : "err") : "off"}`;
      dot.title = msg.status === "ok" ? "运行中 / 已连接" : "连接异常";
    }
  }

  toast(msg.status === "ok" ? `MCP [${msg.name}] 连接成功` : `MCP [${msg.name}] 探测失败: ${msg.error || ""}`);
}

function setMcpFormTransport(type) {
  mcpFormTransport = type;
  const pills = document.querySelectorAll("#mcpFormTypePills .mcp-type-pill");
  pills.forEach((p) => p.classList.toggle("on", p.dataset.type === type));

  const stdioSec = $("mcpFieldsStdio");
  const remoteSec = $("mcpFieldsRemote");
  if (type === "stdio") {
    stdioSec?.classList.remove("hidden");
    remoteSec?.classList.add("hidden");
  } else {
    stdioSec?.classList.add("hidden");
    remoteSec?.classList.remove("hidden");
  }
}

function initMcpEvents() {
  wireSel("mcpScopeSel", (mi) => {
    mcpScope = mi.dataset.scope;
    renderMcpPage();
  });

  const searchInput = $("mcpSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      mcpSearchQuery = e.target.value;
      renderMcpList();
    });
  }

  const refreshBtn = $("mcpRefreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refreshBtn.classList.add("spin");
      send({ type: "list_agent_assets" });
      setTimeout(() => refreshBtn.classList.remove("spin"), 500);
    });
  }

  wireSel("mcpMoreSel", (mi) => {
    if (mi.id === "miOpenCurrentMcpConfig") {
      const curScope = getActiveMcpScope();
      if (curScope?.dir) {
        send({ type: "open_folder", path: curScope.dir });
      } else if (S.agentAssets?.mcp?.userMcpPath) {
        send({ type: "open_folder", path: S.agentAssets.mcp.userMcpPath });
      }
    } else if (mi.id === "miOpenUserMcpConfig") {
      if (S.agentAssets?.mcp?.userMcpPath) {
        send({ type: "open_folder", path: S.agentAssets.mcp.userMcpPath });
      }
    } else if (mi.id === "miRetestAllMcp") {
      const curServers = getScopedMcpServers().filter((s) => s.enabled);
      if (!curServers.length) {
        toast("当前作用域无启用的 MCP 服务器");
        return;
      }
      toast(`开始检测 ${curServers.length} 个 MCP 服务器连接…`);
      for (const s of curServers) {
        send({ type: "test_mcp_server", name: s.name, server: s });
      }
    }
  });

  // 新建：在列表顶部插入临时行并向下延展编辑区（保存后 host 推送重建列表，临时行随之消失）
  $("mcpNewBtn")?.addEventListener("click", () => {
    closeMcpEditor();
    const listEl = $("mcpServerList");
    if (!listEl) return;
    listEl.querySelector(".mcp-empty-row")?.remove();
    const row = document.createElement("div");
    row.className = "mcp-server-row";
    row.dataset.temp = "1";
    const iconBox = document.createElement("div");
    iconBox.className = "mcp-icon-box";
    iconBox.innerHTML = icon("mcp", 18);
    const info = document.createElement("div");
    info.className = "mcp-server-info";
    info.innerHTML =
      '<div class="mcp-server-head"><span class="mcp-server-name">新服务器</span></div>' +
      '<div class="mcp-server-cmd">填写配置后保存</div>';
    const caret = document.createElement("span");
    caret.className = "mem-caret";
    caret.innerHTML = icon("caretSlim");
    row.append(iconBox, info, caret);
    listEl.prepend(row);
    toggleMcpEditor(row, null);
  });
}

function buildMcpFormServerPayload(name) {
  if (mcpFormTransport === "stdio") {
    const cmd = $("mcpFormCmd")?.value.trim();
    if (!cmd) {
      toast("请输入执行命令");
      return null;
    }
    const rawArgs = $("mcpFormArgs")?.value.trim();
    const args = rawArgs
      ? rawArgs.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];
    const rawEnv = $("mcpFormEnv")?.value.trim();
    const env = {};
    if (rawEnv) {
      for (const line of rawEnv.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          const k = line.slice(0, eq).trim();
          const v = line.slice(eq + 1).trim();
          if (k) env[k] = v;
        }
      }
    }
    return { name, transport: "stdio", command: cmd, args, env };
  } else {
    const url = $("mcpFormUrl")?.value.trim();
    if (!url) {
      toast("请输入服务 URL");
      return null;
    }
    const rawHdrs = $("mcpFormHeaders")?.value.trim();
    const headers = {};
    if (rawHdrs) {
      for (const line of rawHdrs.split(/\r?\n/)) {
        const col = line.indexOf(":");
        if (col > 0) {
          const k = line.slice(0, col).trim();
          const v = line.slice(col + 1).trim();
          if (k) headers[k] = v;
        }
      }
    }
    return { name, transport: mcpFormTransport, url, headers };
  }
}

// MCP 编辑表单字段模板（id 与既有填充/取值逻辑保持一致；textarea 的 \n 对应原 HTML 的 &#10; 占位换行）
const MCP_FORM_TEMPLATE =
  '<div class="mcp-form-group"><label class="mcp-form-label">服务名称 <span class="req">*</span></label>' +
  '<input type="text" class="mcp-form-input" id="mcpFormName" placeholder="例如: codegraph、atlassian" spellcheck="false" /></div>' +
  '<div class="mcp-form-group"><label class="mcp-form-label">保存目标</label><select class="mcp-form-select" id="mcpFormScope"></select></div>' +
  '<div class="mcp-form-group"><label class="mcp-form-label">传输协议</label><div class="mcp-type-pills" id="mcpFormTypePills">' +
  '<button type="button" class="mcp-type-pill on" data-type="stdio">stdio (本地命令)</button>' +
  '<button type="button" class="mcp-type-pill" data-type="http">http (远程服务)</button>' +
  '<button type="button" class="mcp-type-pill" data-type="sse">sse (流式服务)</button></div></div>' +
  '<div id="mcpFieldsStdio">' +
  '<div class="mcp-form-group"><label class="mcp-form-label">执行命令 <span class="req">*</span></label>' +
  '<input type="text" class="mcp-form-input" id="mcpFormCmd" placeholder="例如: node、npx、uvx、python3" spellcheck="false" /></div>' +
  '<div class="mcp-form-group"><label class="mcp-form-label">命令参数 (空格或换行分隔)</label>' +
  '<textarea class="mcp-form-textarea" id="mcpFormArgs" rows="2" placeholder="-y\n@upstash/context7-mcp" spellcheck="false"></textarea></div>' +
  '<div class="mcp-form-group"><label class="mcp-form-label">环境变量 (KEY=VALUE，每行一个)</label>' +
  '<textarea class="mcp-form-textarea" id="mcpFormEnv" rows="2" placeholder="API_KEY=xxx" spellcheck="false"></textarea></div></div>' +
  '<div id="mcpFieldsRemote" class="hidden">' +
  '<div class="mcp-form-group"><label class="mcp-form-label">服务 URL <span class="req">*</span></label>' +
  '<input type="text" class="mcp-form-input" id="mcpFormUrl" placeholder="https://... 或 http://localhost:53333/mcp" spellcheck="false" /></div>' +
  '<div class="mcp-form-group"><label class="mcp-form-label">请求头 (Header: Value，每行一个)</label>' +
  '<textarea class="mcp-form-textarea" id="mcpFormHeaders" rows="2" placeholder="Authorization: Bearer xxx" spellcheck="false"></textarea></div></div>';

// 当前向下延展的 MCP 行（含新建临时行）；延展区即该行的行内编辑表单，同记忆页模式
let mcpOpenRow = null;
function closeMcpEditor() {
  if (!mcpOpenRow) return;
  const wasTemp = mcpOpenRow.dataset.temp === "1";
  mcpOpenRow.classList.remove("on");
  mcpOpenRow.nextElementSibling?.remove(); // .mem-expand
  mcpOpenRow = null;
  mcpEditingServer = null;
  if (wasTemp) renderMcpList(); // 新建未保存：移除临时行后重建列表（恢复空态）
}
// 点击 MCP 行：该行向下延展出编辑表单；再次点击收起，点其他行则切换；server 为 null 表示新建
function toggleMcpEditor(row, server) {
  if (mcpOpenRow === row) {
    closeMcpEditor();
    return;
  }
  closeMcpEditor();
  mcpEditingServer = server;
  row.classList.add("on");
  const exp = document.createElement("div");
  exp.className = "mem-expand";
  exp.innerHTML =
    '<div class="mem-exp-head"><span id="mcpModalTitle"></span><span class="sub" id="mcpModalSub"></span><span class="sp"></span><button type="button" class="save-btn">收起</button></div>' +
    '<div class="sem-body form">' + MCP_FORM_TEMPLATE + '</div>' +
    '<div class="sem-foot"><span class="sem-status" id="mcpModalStatus"></span><button type="button" class="confirm-btn" id="mcpModalTestBtn">测试连接</button><span class="sp"></span><button type="button" class="confirm-btn danger hidden" id="mcpModalDeleteBtn">删除</button><button type="button" class="confirm-btn" id="mcpModalSaveBtn">保存</button></div>';
  exp.querySelector(".save-btn").onclick = (e) => {
    e.stopPropagation();
    closeMcpEditor();
  };
  row.after(exp);
  mcpOpenRow = row;
  fillMcpForm(server);
  bindMcpEditorEvents(exp);
}

// 按传入 server（或 null=新建）填充延展区表单
function fillMcpForm(server) {
  // 填充作用域下拉框
  const scopeSel = $("mcpFormScope");
  if (scopeSel) {
    scopeSel.replaceChildren();
    const scopes = currentMcpScopes();
    for (const sc of scopes) {
      if (sc.id === "all") continue;
      const opt = document.createElement("option");
      opt.value = sc.id;
      opt.textContent = sc.name;
      scopeSel.appendChild(opt);
    }
  }

  const titleEl = $("mcpModalTitle");
  const subEl = $("mcpModalSub");
  const nameInput = $("mcpFormName");
  const deleteBtn = $("mcpModalDeleteBtn");
  const statusEl = $("mcpModalStatus");
  if (statusEl) statusEl.textContent = "";

  if (server) {
    if (titleEl) titleEl.textContent = "编辑 MCP 服务器";
    if (subEl) subEl.textContent = `${server.name} · ${server.source?.providerName || "配置文件"}`;
    if (nameInput) {
      nameInput.value = server.name;
      nameInput.disabled = true;
    }
    if (scopeSel && server.scope) {
      scopeSel.value = server.scope;
    }
    setMcpFormTransport(server.transport || "stdio");

    if ($("mcpFormCmd")) $("mcpFormCmd").value = server.command || "";
    if ($("mcpFormArgs")) $("mcpFormArgs").value = (server.args || []).join("\n");
    if ($("mcpFormEnv")) {
      $("mcpFormEnv").value = server.env
        ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join("\n")
        : "";
    }
    if ($("mcpFormUrl")) $("mcpFormUrl").value = server.url || "";
    if ($("mcpFormHeaders")) {
      $("mcpFormHeaders").value = server.headers
        ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`).join("\n")
        : "";
    }
    deleteBtn?.classList.remove("hidden");
  } else {
    if (titleEl) titleEl.textContent = "新建 MCP 服务器";
    if (subEl) subEl.textContent = "配置标准 Model Context Protocol 服务";
    if (nameInput) {
      nameInput.value = "";
      nameInput.disabled = false;
    }
    if (scopeSel) {
      scopeSel.value = mcpScope === "all" ? "profile" : mcpScope;
    }
    setMcpFormTransport("stdio");

    if ($("mcpFormCmd")) $("mcpFormCmd").value = "";
    if ($("mcpFormArgs")) $("mcpFormArgs").value = "";
    if ($("mcpFormEnv")) $("mcpFormEnv").value = "";
    if ($("mcpFormUrl")) $("mcpFormUrl").value = "";
    if ($("mcpFormHeaders")) $("mcpFormHeaders").value = "";
    deleteBtn?.classList.add("hidden");
  }
}

// 延展区内的测试/保存/删除与协议切换绑定（元素随展开新建，每次展开重新绑定）
function bindMcpEditorEvents(exp) {
  exp.querySelectorAll("#mcpFormTypePills .mcp-type-pill").forEach((pill) => {
    pill.addEventListener("click", () => setMcpFormTransport(pill.dataset.type));
  });

  // 测试连接
  exp.querySelector("#mcpModalTestBtn").onclick = () => {
    const name = $("mcpFormName")?.value.trim();
    if (!name) {
      toast("请先输入服务名称");
      return;
    }
    const serverObj = buildMcpFormServerPayload(name);
    if (!serverObj) return;

    const testBtn = $("mcpModalTestBtn");
    if (testBtn) {
      testBtn.disabled = true;
      testBtn.textContent = "测试中…";
    }
    const statusEl = $("mcpModalStatus");
    if (statusEl) {
      statusEl.style.color = "var(--dim)";
      statusEl.textContent = "正在连接测试…";
    }
    send({ type: "test_mcp_server", name, server: serverObj });
  };

  // 保存配置
  exp.querySelector("#mcpModalSaveBtn").onclick = () => {
    const name = $("mcpFormName")?.value.trim();
    if (!name) {
      toast("请先输入服务名称");
      return;
    }
    const scope = $("mcpFormScope")?.value || "profile";
    const serverObj = buildMcpFormServerPayload(name);
    if (!serverObj) return;

    // 格式化为 MCP 服务器配置对象
    const config = {
      type: mcpFormTransport,
    };
    if (mcpFormTransport === "stdio") {
      config.command = serverObj.command;
      if (serverObj.args && serverObj.args.length) config.args = serverObj.args;
      if (serverObj.env && Object.keys(serverObj.env).length) config.env = serverObj.env;
    } else {
      config.url = serverObj.url;
      if (serverObj.headers && Object.keys(serverObj.headers).length) config.headers = serverObj.headers;
    }

    send({ type: "save_mcp_server", name, config, scope });
    closeMcpEditor();
    toast(`已保存 MCP 服务器 "${name}"`);
  };

  // 删除配置
  exp.querySelector("#mcpModalDeleteBtn").onclick = () => {
    if (!mcpEditingServer) return;
    const name = mcpEditingServer.name;
    if (confirm(`确定删除 MCP 服务器 "${name}" 吗？`)) {
      send({
        type: "delete_mcp_server",
        name,
        sourcePath: mcpEditingServer.source?.path,
      });
      closeMcpEditor();
      toast(`已请求删除 "${name}"`);
    }
  };
}
