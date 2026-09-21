// 设置·MCP 页：多源全量发现、红绿灯状态、iOS 开关、实时搜索、行内延展编辑表单。
// 旧版 ui/settings/mcp.js 的 1:1 React 平移；DOM 类名与 git 464131d 的 pg-mcp 骨架对齐。
import { useEffect, useRef, useState } from "react";
import { S, useStore, send, toast, notify } from "../../../store.js";
import Icon from "../../../Icon.jsx";
import { confirmDialog, emptyRow } from "../common.jsx";

const NEW_KEY = "__new__";

// 作用域列表（缺数据时给单兜底项）
function currentMcpScopes() {
  const mcp = S.agentAssets?.mcp;
  if (!mcp || !Array.isArray(mcp.scopes)) {
    return [{ id: "all", name: "全部工作区", count: 0 }];
  }
  return mcp.scopes;
}

function getScopedMcpServers(scope) {
  const allServers = S.agentAssets?.mcp?.servers || [];
  if (scope === "all") return allServers;
  if (scope === "profile") return allServers.filter((s) => s.scope === "profile");
  return allServers.filter((s) => s.scope === scope);
}

// 状态点样式与标题
function dotState(s) {
  if (!s.enabled) return { cls: "off", title: "已禁用" };
  if (s.status === "connected") return { cls: "ok", title: "运行中 / 已连接" };
  if (s.status === "error") return { cls: "err", title: "连接异常" };
  return { cls: "ok", title: "就绪" };
}

// 通用下拉（.sel 容器 + .menu，行为对齐旧版 wireSel：点击切换、点项回调、点外部关闭）
function Sel({ id, className, btnClassName, btnTitle, btnChildren, children, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  return (
    <div className={`sel ${className || ""}`} id={id} ref={ref}>
      <button
        type="button"
        className={btnClassName}
        title={btnTitle}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {btnChildren}
      </button>
      <div
        className={`menu${open ? " open" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          const mi = e.target.closest(".mi");
          if (!mi || mi.classList.contains("disabled")) return;
          setOpen(false);
          onPick(mi);
        }}
      >
        {children}
      </div>
    </div>
  );
}

// 行的唯一键：跨源同名服务器用 source.path 区分
function rowKey(s) {
  return `${s.name}\n${s.source?.path || s.cwd || ""}`;
}

// 服务器行 + 行内向下延展编辑区（点击行展开，再点收起，点其他行切换）
function ServerRow({ server, scopeAll, defaultScope, open, onToggle, onClose }) {
  const dot = dotState(server);
  const cmdText = server.command
    ? [server.command, ...(server.args || [])].filter(Boolean).join(" ")
    : server.url || "";

  return (
    <>
      <div
        className={`mcp-server-row${server.enabled ? "" : " disabled"}${open ? " on" : ""}`}
        data-name={server.name}
        onClick={onToggle}
      >
        <div className="mcp-icon-box">
          <Icon name="mcp" size={18} />
          <span className={`mcp-status-dot ${dot.cls}`} title={dot.title} />
        </div>
        <div className="mcp-server-info" title="点击查看或编辑配置">
          <div className="mcp-server-head">
            <span className="mcp-server-name">{server.name}</span>
            {server.transport ? <span className="mcp-server-badge">{server.transport}</span> : null}
            {scopeAll
              ? (server.projectName || server.source?.providerName
                  ? <span className="mcp-server-badge">{server.projectName || server.source?.providerName}</span>
                  : null)
              : null}
          </div>
          <div className="mcp-server-cmd" title={cmdText}>{cmdText}</div>
          {server.enabled && server.status === "error" && server.error ? (
            <div className="mcp-server-err">
              <span className="mcp-err-icon" title="错误详情">ⓘ</span>
              <span>{server.error}</span>
            </div>
          ) : null}
        </div>
        <div className="mcp-server-ctrl">
          <Toggle server={server} />
        </div>
        <span className="mem-caret"><Icon name="caretSlim" /></span>
      </div>
      {open ? <McpEditor server={server} defaultScope={defaultScope} onClose={onClose} /> : null}
    </>
  );
}

// iOS 开关：本地乐观翻转 + 回写宿主
function Toggle({ server }) {
  return (
    <div
      className={`tg${server.enabled ? " on" : ""}`}
      title={server.enabled ? "已启用，点击禁用" : "已禁用，点击启用"}
      onClick={(e) => {
        e.stopPropagation();
        const nextEnabled = !server.enabled;
        server.enabled = nextEnabled; // 乐观更新共享数据（状态点/统计随 notify 重渲染）
        notify();
        send({
          type: "set_mcp_server_enabled",
          name: server.name,
          enabled: nextEnabled,
          cwd: server.cwd,
          sourcePath: server.source?.path,
        });
      }}
    >
      <i />
    </div>
  );
}

// 行内延展编辑表单（.mem-expand，同记忆页模式）
function McpEditor({ server, defaultScope, onClose }) {
  const isNew = !server;
  const scopes = currentMcpScopes().filter((sc) => sc.id !== "all");
  const [name, setName] = useState(server?.name || "");
  const [scope, setScope] = useState(server?.scope || (defaultScope === "all" ? "profile" : defaultScope));
  const [transport, setTransport] = useState(server?.transport || "stdio");
  const [cmd, setCmd] = useState(server?.command || "");
  const [args, setArgs] = useState((server?.args || []).join("\n"));
  const [env, setEnv] = useState(
    server?.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join("\n") : ""
  );
  const [url, setUrl] = useState(server?.url || "");
  const [headers, setHeaders] = useState(
    server?.headers ? Object.entries(server.headers).map(([k, v]) => `${k}: ${v}`).join("\n") : ""
  );
  const [testing, setTesting] = useState(false);

  // 测试结果（来自 S.mcpTestResults，集成方在 mcp_server_tested 回包里落地）
  const result = !isNew ? S.mcpTestResults?.[server.name] : undefined;
  const lastTs = useRef(result?.ts || 0);
  useEffect(() => {
    if (result && result.ts !== lastTs.current) {
      lastTs.current = result.ts;
      setTesting(false);
    }
  }, [result]);

  const title = isNew ? "新建 MCP 服务器" : "编辑 MCP 服务器";
  const sub = isNew
    ? "配置标准 Model Context Protocol 服务"
    : `${server.name} · ${server.source?.providerName || "配置文件"}`;

  // 由表单内容组装 server 对象（测试用）；缺必填项返回 null 并 toast
  const buildPayload = () => {
    if (transport === "stdio") {
      const c = cmd.trim();
      if (!c) {
        toast("请输入执行命令");
        return null;
      }
      const rawArgs = args.trim();
      const argList = rawArgs
        ? rawArgs.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : [];
      const envObj = {};
      const rawEnv = env.trim();
      if (rawEnv) {
        for (const line of rawEnv.split(/\r?\n/)) {
          const eq = line.indexOf("=");
          if (eq > 0) {
            const k = line.slice(0, eq).trim();
            const v = line.slice(eq + 1).trim();
            if (k) envObj[k] = v;
          }
        }
      }
      return { name: name.trim(), transport: "stdio", command: c, args: argList, env: envObj };
    }
    const u = url.trim();
    if (!u) {
      toast("请输入服务 URL");
      return null;
    }
    const hdrObj = {};
    const rawHdrs = headers.trim();
    if (rawHdrs) {
      for (const line of rawHdrs.split(/\r?\n/)) {
        const col = line.indexOf(":");
        if (col > 0) {
          const k = line.slice(0, col).trim();
          const v = line.slice(col + 1).trim();
          if (k) hdrObj[k] = v;
        }
      }
    }
    return { name: name.trim(), transport, url: u, headers: hdrObj };
  };

  const onTest = () => {
    if (!name.trim()) {
      toast("请先输入服务名称");
      return;
    }
    const serverObj = buildPayload();
    if (!serverObj) return;
    setTesting(true);
    send({ type: "test_mcp_server", name: name.trim(), server: serverObj });
  };

  const onSave = () => {
    if (!name.trim()) {
      toast("请先输入服务名称");
      return;
    }
    const serverObj = buildPayload();
    if (!serverObj) return;
    const config = { type: transport };
    if (transport === "stdio") {
      config.command = serverObj.command;
      if (serverObj.args && serverObj.args.length) config.args = serverObj.args;
      if (serverObj.env && Object.keys(serverObj.env).length) config.env = serverObj.env;
    } else {
      config.url = serverObj.url;
      if (serverObj.headers && Object.keys(serverObj.headers).length) config.headers = serverObj.headers;
    }
    send({ type: "save_mcp_server", name: name.trim(), config, scope });
    onClose();
    toast(`已保存 MCP 服务器 "${name.trim()}"`);
  };

  const onDelete = async () => {
    if (!server) return;
    if (await confirmDialog({ title: `确定删除 MCP 服务器 "${server.name}" 吗？`, confirmText: "删除", danger: true })) {
      send({ type: "delete_mcp_server", name: server.name, sourcePath: server.source?.path });
      onClose();
      toast(`已请求删除 "${server.name}"`);
    }
  };

  const statusText = testing
    ? "正在连接测试…"
    : result
      ? result.status === "ok"
        ? "连接成功"
        : result.error || "连接失败"
      : "";
  const statusColor = testing
    ? "var(--dim)"
    : result
      ? result.status === "ok"
        ? "var(--green)"
        : "var(--err)"
      : undefined;

  return (
    <div className="mem-expand">
      <div className="mem-exp-head">
        <span>{title}</span>
        <span className="sub">{sub}</span>
        <span className="sp" />
        <button type="button" className="save-btn" onClick={(e) => { e.stopPropagation(); onClose(); }}>
          收起
        </button>
      </div>
      <div className="sem-body form">
        <div className="mcp-form-group">
          <label className="mcp-form-label">服务名称 <span className="req">*</span></label>
          <input
            type="text"
            className="mcp-form-input"
            placeholder="例如: codegraph、atlassian"
            spellCheck="false"
            value={name}
            disabled={!isNew}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="mcp-form-group">
          <label className="mcp-form-label">保存目标</label>
          <select className="mcp-form-select" value={scope} onChange={(e) => setScope(e.target.value)}>
            {scopes.map((sc) => (
              <option key={sc.id} value={sc.id}>{sc.name}</option>
            ))}
          </select>
        </div>
        <div className="mcp-form-group">
          <label className="mcp-form-label">传输协议</label>
          <div className="mcp-type-pills">
            {[
              ["stdio", "stdio (本地命令)"],
              ["http", "http (远程服务)"],
              ["sse", "sse (流式服务)"],
            ].map(([t, label]) => (
              <button
                key={t}
                type="button"
                className={`mcp-type-pill${transport === t ? " on" : ""}`}
                onClick={() => setTransport(t)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {transport === "stdio" ? (
          <div>
            <div className="mcp-form-group">
              <label className="mcp-form-label">执行命令 <span className="req">*</span></label>
              <input
                type="text"
                className="mcp-form-input"
                placeholder="例如: node、npx、uvx、python3"
                spellCheck="false"
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
              />
            </div>
            <div className="mcp-form-group">
              <label className="mcp-form-label">命令参数 (空格或换行分隔)</label>
              <textarea
                className="mcp-form-textarea"
                rows="2"
                placeholder={"-y\n@upstash/context7-mcp"}
                spellCheck="false"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </div>
            <div className="mcp-form-group">
              <label className="mcp-form-label">环境变量 (KEY=VALUE，每行一个)</label>
              <textarea
                className="mcp-form-textarea"
                rows="2"
                placeholder="API_KEY=xxx"
                spellCheck="false"
                value={env}
                onChange={(e) => setEnv(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <div>
            <div className="mcp-form-group">
              <label className="mcp-form-label">服务 URL <span className="req">*</span></label>
              <input
                type="text"
                className="mcp-form-input"
                placeholder="https://... 或 http://localhost:53333/mcp"
                spellCheck="false"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="mcp-form-group">
              <label className="mcp-form-label">请求头 (Header: Value，每行一个)</label>
              <textarea
                className="mcp-form-textarea"
                rows="2"
                placeholder="Authorization: Bearer xxx"
                spellCheck="false"
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>
      <div className="sem-foot">
        <span className="sem-status" style={statusColor ? { color: statusColor } : undefined}>
          {statusText}
        </span>
        <button type="button" className="confirm-btn" disabled={testing} onClick={onTest}>
          {testing ? "测试中…" : "测试连接"}
        </button>
        <span className="sp" />
        {!isNew ? (
          <button type="button" className="confirm-btn danger" onClick={onDelete}>
            删除
          </button>
        ) : null}
        <button type="button" className="confirm-btn" onClick={onSave}>
          保存
        </button>
      </div>
    </div>
  );
}

export default function McpPage() {
  useStore(); // 订阅共享数据变化（S.agentAssets / S.mcpTestResults）
  const [mcpScope, setMcpScope] = useState("all");
  const [mcpSearchQuery, setMcpSearchQuery] = useState("");
  const [openKey, setOpenKey] = useState(null); // 服务器 name 或 NEW_KEY；null = 收起
  const [spinning, setSpinning] = useState(false);

  const allScopes = currentMcpScopes();
  const curScope = allScopes.find((s) => s.id === mcpScope) || allScopes[0] || { id: "all", name: "全部工作区" };
  const activeScope = curScope.id;

  // 每次渲染直接读 S（useStore 已保证回包时重渲染）；不用 useMemo 缓存可变单例
  const scopedNow = getScopedMcpServers(activeScope);

  const q = mcpSearchQuery.trim().toLowerCase();
  const filtered = scopedNow.filter((s) => {
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      (s.command && s.command.toLowerCase().includes(q)) ||
      (Array.isArray(s.args) && s.args.some((a) => a.toLowerCase().includes(q))) ||
      (s.url && s.url.toLowerCase().includes(q)) ||
      (s.error && s.error.toLowerCase().includes(q))
    );
  });

  const totalCount = scopedNow.length;
  const installedCount = scopedNow.filter((s) => s.enabled).length;

  const toggleEditor = (key) => setOpenKey((cur) => (cur === key ? null : key));

  const onRefresh = () => {
    setSpinning(true);
    send({ type: "list_agent_assets" });
    setTimeout(() => setSpinning(false), 500);
  };

  const onMorePick = (mi) => {
    if (mi.id === "miOpenCurrentMcpConfig") {
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
      const curServers = getScopedMcpServers(activeScope).filter((s) => s.enabled);
      if (!curServers.length) {
        toast("当前作用域无启用的 MCP 服务器");
        return;
      }
      toast(`开始检测 ${curServers.length} 个 MCP 服务器连接…`);
      for (const s of curServers) {
        send({ type: "test_mcp_server", name: s.name, server: s });
      }
    }
  };

  // 作用域菜单分隔线规则：profile 前、profile 后首个 project 前插 .sep
  const scopeMenuItems = [];
  allScopes.forEach((s, i) => {
    if (i > 0 && (s.id === "profile" || (allScopes[i - 1].id === "profile" && s.id.startsWith("project:")))) {
      scopeMenuItems.push(<div className="sep" key={`sep-${s.id}`} />);
    }
    scopeMenuItems.push(
      <div className="mi" data-scope={s.id} key={s.id}>
        <span className="ck" style={{ visibility: s.id === activeScope ? "visible" : "hidden" }}>✓</span>
        <Icon name={s.id === "profile" ? "scopeProfile" : "folder"} size={13} />
        <span className="mi-label" title={s.name}>{s.name}</span>
      </div>
    );
  });

  return (
    <div className="set-page" id="pg-mcp">
      <div className="mcp-header">
        <div className="mcp-tt">MCP 服务器</div>
      </div>

      <div className="mcp-bar-primary">
        <div className="mcp-scope-wrap">
          <Sel
            id="mcpScopeSel"
            className="mcp-scope-sel"
            btnClassName="mcp-scope-btn"
            btnChildren={
              <>
                <span className="mcp-scope-icon">
                  <Icon name={activeScope === "profile" ? "scopeProfile" : "folder"} size={14} />
                </span>
                <span>{curScope.name}</span>
                <span className="caret-svg"><Icon name="caret" size={10} /></span>
              </>
            }
            onPick={(mi) => setMcpScope(mi.dataset.scope)}
          >
            {scopeMenuItems}
          </Sel>
          <span className="mcp-divider">|</span>
          <span className="mcp-count-stat">MCP {totalCount}</span>
        </div>
        <div className="mcp-search-wrap">
          <span className="mcp-search-icon"><Icon name="search" size={13} /></span>
          <input
            type="text"
            className="mcp-search-input"
            placeholder="搜索 MCP 服务器..."
            spellCheck="false"
            autoComplete="off"
            value={mcpSearchQuery}
            onChange={(e) => setMcpSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="mcp-bar-secondary">
        <div className="mcp-installed-stat">已安装 {installedCount}</div>
        <div className="mcp-actions-wrap">
          <Sel
            id="mcpMoreSel"
            btnClassName="mcp-btn-icon"
            btnTitle="更多选项"
            btnChildren={<Icon name="dots" size={14} />}
            onPick={onMorePick}
          >
            <div className="mi" id="miOpenCurrentMcpConfig">
              <span className="mi-icon"><Icon name="file" size={13} /></span>
              <span className="mi-label">打开当前 mcp.json 配置</span>
            </div>
            <div className="mi" id="miOpenUserMcpConfig">
              <span className="mi-icon"><Icon name="scopeProfile" size={13} /></span>
              <span className="mi-label">打开用户全局配置 (~/.omp)</span>
            </div>
            <div className="sep" />
            <div className="mi" id="miRetestAllMcp">
              <span className="mi-icon"><Icon name="rotateRight" size={13} /></span>
              <span className="mi-label">重新测试所有服务器连接</span>
            </div>
          </Sel>
          <button
            type="button"
            className={`icon-btn pg-refresh${spinning ? " spin" : ""}`}
            title="刷新"
            onClick={onRefresh}
          >
            <Icon name="refresh" size={17} />
          </button>
          <button type="button" className="mcp-btn-new" onClick={() => toggleEditor(NEW_KEY)}>
            <Icon name="plus" size={13} />
            <span>新建</span>
          </button>
        </div>
      </div>

      <div className="mcp-list-wrap">
        <div className="mcp-card-list">
          {openKey === NEW_KEY ? (
            <>
              <div
                className="mcp-server-row on"
                data-temp="1"
                onClick={() => toggleEditor(NEW_KEY)}
              >
                <div className="mcp-icon-box"><Icon name="mcp" size={18} /></div>
                <div className="mcp-server-info">
                  <div className="mcp-server-head"><span className="mcp-server-name">新服务器</span></div>
                  <div className="mcp-server-cmd">填写配置后保存</div>
                </div>
                <span className="mem-caret"><Icon name="caretSlim" /></span>
              </div>
              <McpEditor server={null} defaultScope={activeScope} onClose={() => toggleEditor(NEW_KEY)} />
            </>
          ) : null}

          {!S.agentAssets?.mcp ? (
            emptyRow("加载中…", "mcp-empty-row")
          ) : !filtered.length ? (
            emptyRow(q ? "未找到匹配的 MCP 服务器" : "当前工作区下暂无 MCP 服务器", "mcp-empty-row")
          ) : (
            filtered.map((s) => {
              const k = rowKey(s);
              return (
                <ServerRow
                  key={k}
                  server={s}
                  scopeAll={activeScope === "all"}
                  defaultScope={activeScope}
                  open={openKey === k}
                  onToggle={() => toggleEditor(k)}
                  onClose={() => toggleEditor(k)}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
