// 设置·MCP 页：多源全量发现、红绿灯状态、iOS 开关、实时搜索、行内延展编辑表单。
// 旧版 ui/settings/mcp.js 的 1:1 React 平移；DOM 类名与 git 464131d 的 pg-mcp 骨架对齐。
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import { confirmDialog, emptyRow } from "../common";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import { ExtSourceTag, useExtSources } from "../ExtSourceTag";
import ScopeSel from "../ScopeSel";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog";

const NEW_KEY = "__new__";

// MCP 作用域条目（agent_assets 回包 mcp.scopes；字段为 host 下发）
interface McpScope {
  id: string;
  name: string;
  count?: number;
  dir?: string; // 该作用域对应的配置目录（「打开配置」用）
}

// 服务器来源信息（跨源同名服务器用 source.path 区分；providerName 仅展示）
interface McpSource {
  path?: string;
  providerName?: string;
}

// MCP 服务器条目（agentAssets.mcp.servers；字段为 host 下发，缺省可空）
interface McpServer {
  name: string;
  enabled: boolean;
  status?: string; // connected / error / 其他就绪态
  error?: string;
  log?: string;
  transport?: string; // stdio / http / sse
  command?: string;
  args?: string[];
  url?: string;
  scope?: string;
  sharing?: "session" | "project" | "global";
  cwd?: string;
  projectName?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  source?: McpSource;
}

// 测试结果条目（mcpTestResults[name]，mcp_server_tested 回包落地）
interface McpTestResult {
  ts: number;
  status: string; // "ok" 或其他失败态
  error?: string;
  log?: string;
}

// MCP 报错日志弹窗（对齐全站 Radix Dialog 风格）
function McpLogDialog({
  serverName,
  error,
  log,
  onClose,
}: {
  serverName: string;
  error?: string;
  log?: string;
  onClose: () => void;
}) {
  const content = log || error || "暂无详细日志信息";
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      toast("已复制报错日志到剪贴板");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("复制失败，请手动选择内容复制");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="confirm-box"
        style={{ width: "680px", maxWidth: "92vw", maxHeight: "82vh", display: "flex", flexDirection: "column" }}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="confirm-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Icon name="mcp" size={16} />
          <span>MCP 报错日志 · {serverName}</span>
        </DialogTitle>
        <div style={{ flex: 1, minHeight: 0, marginTop: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {error ? (
            <div style={{ color: "var(--err)", fontSize: "var(--ui-fs-sm)", fontWeight: 500, lineHeight: 1.4 }}>
              {error}
            </div>
          ) : null}
          <pre
            style={{
              flex: 1,
              background: "var(--panel-2)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r-sm)",
              padding: "10px 12px",
              fontFamily: "var(--mono)",
              fontSize: "12px",
              lineHeight: 1.5,
              color: "var(--text)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              overflowY: "auto",
              userSelect: "text",
              minHeight: "160px",
              maxHeight: "420px",
            }}
          >
            {content}
          </pre>
        </div>
        <DialogFooter className="confirm-actions" style={{ marginTop: "16px", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" className="confirm-btn" onClick={onCopy}>
            {copied ? "已复制" : "复制日志"}
          </button>
          <DialogClose asChild>
            <button type="button" className="confirm-btn" onClick={onClose}>
              关闭
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 表单组装的 server 对象（stdio / 远程两种形态，字段按 transport 取舍）
interface McpPayload {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  sharing?: "session" | "project" | "global";
}

// 作用域列表（收敛为 Profile 与 Project，缺数据时给 Profile 兜底项，且 Project 严格限定在有效工作区内）
function currentMcpScopes(validProjectCwds?: Set<string>): McpScope[] {
  const st = useAppStore.getState();
  const mcp = st.agentAssets?.mcp;
  if (!mcp || !Array.isArray(mcp.scopes)) {
    return [{ id: "profile", name: "Profile", count: 0 }];
  }
  const validSet = validProjectCwds ?? new Set(st.allProjects.filter((c) => !st.removedProjects.includes(c)));
  return mcp.scopes.filter((sc) => {
    if (sc.id === "all") return false;
    if (sc.id === "profile") return true;
    const cwd = (sc as any).cwd ?? (sc.id.startsWith("project:") ? sc.id.slice("project:".length) : null);
    return Boolean(cwd && validSet.has(cwd));
  });
}

function getScopedMcpServers(scope: string): McpServer[] {
  const allServers = useAppStore.getState().agentAssets?.mcp?.servers || [];
  if (scope === "profile") return allServers.filter((s) => s.scope === "profile");
  return allServers.filter((s) => s.scope === scope);
}

// 状态点样式与标题
function dotState(s: McpServer): { cls: string; title: string } {
  if (!s.enabled) return { cls: "off", title: "已禁用" };
  if (s.status === "connected") return { cls: "ok", title: "运行中 / 已连接" };
  if (s.status === "error") return { cls: "err", title: "连接异常" };
  return { cls: "ok", title: "就绪" };
}

// 通用下拉（.sel 容器 + .menu，行为对齐旧版 wireSel：点击切换、点项回调、点外部关闭）
interface SelProps {
  id?: string;
  className?: string;
  btnClassName?: string;
  btnTitle?: string;
  btnChildren?: ReactNode;
  menuId?: string;
  menuClassName?: string;
  children?: ReactNode;
  onPick: (mi: HTMLElement) => void; // 被选中的 .mi 元素
}
function Sel({ id, className, btnClassName, btnTitle, btnChildren, menuId, menuClassName, children, onPick }: SelProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node | null)) setOpen(false);
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
        id={menuId}
        className={`menu${menuClassName ? ` ${menuClassName}` : ""}${open ? " open" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          const mi = (e.target as HTMLElement).closest(".mi") as HTMLElement | null;
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
function rowKey(s: McpServer): string {
  return `${s.name}\n${s.source?.path || s.cwd || ""}`;
}

// 服务器行 + 行内向下延展编辑区（点击行展开，再点收起，点其他行切换）
interface ServerRowProps {
  server: McpServer;
  scopeAll: boolean;
  defaultScope: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onViewLog: (info: { name: string; error?: string; log?: string }) => void;
}
function ServerRow({ server, scopeAll, defaultScope, open, onToggle, onClose, onViewLog }: ServerRowProps) {
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
          <Icon name="mcp" size={14} />
          <span className={`mcp-status-dot ${dot.cls}`} title={dot.title} />
        </div>
        <div className="mcp-server-info" title="点击查看或编辑配置">
          <div className="mcp-server-head">
            <span className="text-ui-base font-semibold truncate text-text">{server.name}</span>
            {server.transport ? <span className="mcp-server-badge">{server.transport}</span> : null}
            {server.sharing === "global" ? (
              <span className="mcp-server-badge mcp-badge-shared">全局共享</span>
            ) : server.sharing === "project" ? (
              <span className="mcp-server-badge mcp-badge-shared">项目共享</span>
            ) : null}
            <ExtSourceTag kind="mcp" name={server.name} path={server.source?.path} />
            {scopeAll
              ? (server.projectName || server.source?.providerName
                  ? <span className="mcp-server-badge">{server.projectName || server.source?.providerName}</span>
                  : null)
              : null}
          </div>
          <div className="mcp-server-cmd" title={cmdText}>{cmdText}</div>
          {server.enabled && server.status === "error" && (server.error || server.log) ? (
            <div className="mcp-server-err">
              <span className="mcp-err-icon" title="错误详情">ⓘ</span>
              <span className="truncate">{server.error || "服务启动失败"}</span>
              <button
                type="button"
                className="mcp-log-btn"
                title="查看完整报错日志"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewLog({ name: server.name, error: server.error, log: server.log });
                }}
              >
                查看日志
              </button>
            </div>
          ) : null}
        </div>
        <div className="mcp-server-ctrl">
          <Toggle server={server} />
        </div>
        <span className="mem-caret"><Icon name="caretSlim" size={14} /></span>
      </div>
      {open ? <McpEditor server={server} defaultScope={defaultScope} onClose={onClose} onViewLog={onViewLog} /> : null}
    </>
  );
}

// iOS 开关：本地乐观翻转 + 回写宿主
function Toggle({ server }: { server: McpServer }) {
  return (
    <div
      className={`tg${server.enabled ? " on" : ""}`}
      title={server.enabled ? "已启用，点击禁用" : "已禁用，点击启用"}
      onClick={(e) => {
        e.stopPropagation();
        const nextEnabled = !server.enabled;
        // 乐观换引用：拷贝 agentAssets → mcp → servers 数组并替换该 server（字段写入即通知，状态点/统计随重渲染刷新）
        const st = useAppStore.getState();
        const assets = st.agentAssets;
        const mcp = assets?.mcp;
        if (assets && mcp) {
          const servers = mcp.servers.map((x) => (x === server ? { ...x, enabled: nextEnabled } : x));
          useAppStore.setState({ agentAssets: { ...assets, mcp: { ...mcp, servers } } });
        }
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
interface McpEditorProps {
  server: McpServer | null; // null = 新建
  defaultScope: string;
  onClose: () => void;
  onViewLog?: (info: { name: string; error?: string; log?: string }) => void;
}
function McpEditor({ server, defaultScope, onClose, onViewLog }: McpEditorProps) {
  const isNew = !server;
  const targetScope = defaultScope === "all" ? "profile" : defaultScope;
  const isProjectScope = targetScope !== "profile";
  const [name, setName] = useState(server?.name || "");
  const [transport, setTransport] = useState(server?.transport || "stdio");
  const [sharing, setSharing] = useState<"session" | "project" | "global">(() => {
    if (server?.sharing) {
      if (isProjectScope && server.sharing === "global") return "session";
      return server.sharing;
    }
    return "session";
  });
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

  // 测试结果（来自 mcpTestResults，集成方在 mcp_server_tested 回包里落地）
  const result: McpTestResult | undefined = !server ? undefined : useAppStore.getState().mcpTestResults?.[server.name];
  const lastTs = useRef<number>(result?.ts || 0);
  useEffect(() => {
    if (result && result.ts !== lastTs.current) {
      lastTs.current = result.ts;
      setTesting(false);
    }
  }, [result]);

  const title = isNew ? "新建 MCP 服务器" : "编辑 MCP 服务器";
  const sub = !server
    ? "配置标准 Model Context Protocol 服务"
    : `${server.name} · ${server.source?.providerName || "配置文件"}`;

  // 由表单内容组装 server 对象（测试用）；缺必填项返回 null 并 toast
  const buildPayload = (): McpPayload | null => {
    const finalSharing = isProjectScope && sharing === "global" ? "session" : sharing;
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
      const envObj: Record<string, string> = {};
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
      return { name: name.trim(), transport: "stdio", command: c, args: argList, env: envObj, sharing: finalSharing };
    }
    const u = url.trim();
    if (!u) {
      toast("请输入服务 URL");
      return null;
    }
    const hdrObj: Record<string, string> = {};
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
    return { name: name.trim(), transport, url: u, headers: hdrObj, sharing: finalSharing };
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
    const finalSharing = isProjectScope && sharing === "global" ? "session" : sharing;
    const config: Record<string, unknown> = { type: transport, sharing: finalSharing };
    if (transport === "stdio") {
      config.command = serverObj.command;
      if (serverObj.args && serverObj.args.length) config.args = serverObj.args;
      if (serverObj.env && Object.keys(serverObj.env).length) config.env = serverObj.env;
    } else {
      config.url = serverObj.url;
      if (serverObj.headers && Object.keys(serverObj.headers).length) config.headers = serverObj.headers;
    }
    send({ type: "save_mcp_server", name: name.trim(), config, scope: targetScope });
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
        <div className="mcp-form-group">
          <label className="mcp-form-label">实例共享模式</label>
          <div className="mcp-type-pills">
            {isProjectScope
              ? [
                  ["session", "会话私有 (默认)"],
                  ["project", "项目共享 (本工作区)"],
                ].map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    className={`mcp-type-pill${sharing === m ? " on" : ""}`}
                    onClick={() => setSharing(m as "session" | "project")}
                  >
                    {label}
                  </button>
                ))
              : [
                  ["session", "会话私有 (默认)"],
                  ["global", "全局共享 (跨项目)"],
                ].map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    className={`mcp-type-pill${sharing === m ? " on" : ""}`}
                    onClick={() => setSharing(m as "session" | "global")}
                  >
                    {label}
                  </button>
                ))}
          </div>
          <div className="mcp-form-hint">
            {sharing === "global"
              ? "跨项目所有会话复用同一单例进程，不暴露工作区目录，适合网络搜索/文档检索类无状态工具。"
              : sharing === "project"
              ? "当前项目内的所有会话复用同一单例进程，避免重复开销，适合代码索引等工具。"
              : "每个会话独占子进程与工作区目录，会话结束时即释放，隔离性最高。"}
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
                rows={2}
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
                rows={2}
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
                rows={2}
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
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
          <span className="text-ui-sm text-dim truncate" style={statusColor ? { color: statusColor } : undefined}>
            {statusText}
          </span>
          {((result && result.status !== "ok" && (result.log || result.error)) || (!result && server?.status === "error" && (server.log || server.error))) && onViewLog ? (
            <button
              type="button"
              className="mcp-log-btn"
              onClick={() =>
                onViewLog({
                  name: name.trim() || server?.name || "未命名",
                  error: result?.error || server?.error,
                  log: result?.log || server?.log,
                })
              }
            >
              查看日志
            </button>
          ) : null}
        </div>
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
  // 渲染数据走字段 selector：agent_assets / mcp_server_tested 落地帧均全量换新引用
  //（含 mcp 段 servers 数组），字段订阅即可感知
  const agentAssets = useAppStore((s) => s.agentAssets);
  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  const validProjectCwds = new Set(
    allProjects.filter((c) => !removedProjects.includes(c))
  );

  const [mcpScope, setMcpScope] = useState("profile");
  const [mcpSearchQuery, setMcpSearchQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null); // 服务器 name 或 NEW_KEY；null = 收起
  const [logModal, setLogModal] = useState<{ name: string; error?: string; log?: string } | null>(null);
  const [spinning, setSpinning] = useState(false);
  useExtSources(); // 扩展中心全 scope 数据（行内来源徽标匹配用）

  const allScopes = currentMcpScopes(validProjectCwds);
  const profileScope = allScopes.find((s) => s.id === "profile") || { id: "profile", name: "Profile" };
  const projectScopes = allScopes.filter((s) => s.id !== "profile");
  const curScope: McpScope =
    allScopes.find((s) => s.id === mcpScope) || profileScope;
  const activeScope = curScope.id;

  // 每次渲染直接读 store（agentAssets 订阅已保证回包时重渲染）；不用 useMemo 缓存可变单例
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

  const toggleEditor = (key: string) => setOpenKey((cur) => (cur === key ? null : key));

  const onRefresh = () => {
    setSpinning(true);
    send({ type: "list_agent_assets" });
    setTimeout(() => setSpinning(false), 500);
  };

  const onMorePick = (mi: HTMLElement) => {
    if (mi.id === "miOpenCurrentMcpConfig") {
      if (curScope?.dir) {
        send({ type: "open_folder", path: curScope.dir });
      } else if (useAppStore.getState().agentAssets?.mcp?.userMcpPath) {
        send({ type: "open_folder", path: useAppStore.getState().agentAssets!.mcp!.userMcpPath });
      }
    } else if (mi.id === "miOpenUserMcpConfig") {
      if (useAppStore.getState().agentAssets?.mcp?.userMcpPath) {
        send({ type: "open_folder", path: useAppStore.getState().agentAssets!.mcp!.userMcpPath });
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

  return (
    <div className="set-page" id="pg-mcp">
      <div className="mcp-header">
        <div className="mcp-tt">MCP 服务器</div>
      </div>

      <div className="mcp-bar-primary">
        <div className="mcp-scope-wrap">
          <ScopeSel
            value={activeScope}
            onChange={(id) => setMcpScope(id)}
            profile={{ id: profileScope.id, label: profileScope.name }}
            projects={projectScopes.map((s) => ({ id: s.id, label: s.name }))}
          />
          <span className="mcp-divider">|</span>
          <span className="text-ui-base text-dim">MCP {totalCount}</span>
        </div>
        <div className="mcp-search-wrap">
          <span className="mcp-search-icon"><Icon name="search" size={14} /></span>
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
        <div className="text-ui-sm font-medium text-dim">已安装 {installedCount}</div>
        <div className="mcp-actions-wrap">
          <Sel
            id="mcpMoreSel"
            btnClassName="mcp-btn-icon"
            btnTitle="更多选项"
            btnChildren={<Icon name="dots" size={14} />}
            onPick={onMorePick}
          >
            <div className="mi" id="miOpenCurrentMcpConfig">
              <span className="mi-icon"><Icon name="file" size={14} /></span>
              <span className="mi-label">打开当前 mcp.json 配置</span>
            </div>
            <div className="mi" id="miOpenUserMcpConfig">
              <span className="mi-icon"><Icon name="scopeProfile" size={14} /></span>
              <span className="mi-label">打开用户全局配置 (~/.omp)</span>
            </div>
            <div className="sep" />
            <div className="mi" id="miRetestAllMcp">
              <span className="mi-icon"><Icon name="rotateRight" size={14} /></span>
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
            <Icon name="plus" size={14} />
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
                <div className="mcp-icon-box"><Icon name="mcp" size={14} /></div>
                <div className="mcp-server-info">
                  <div className="mcp-server-head"><span className="text-ui-base font-semibold truncate text-text">新服务器</span></div>
                  <div className="mcp-server-cmd">填写配置后保存</div>
                </div>
                <span className="mem-caret"><Icon name="caretSlim" size={14} /></span>
              </div>
              <McpEditor
                server={null}
                defaultScope={activeScope}
                onClose={() => toggleEditor(NEW_KEY)}
                onViewLog={(info) => setLogModal(info)}
              />
            </>
          ) : null}

          {!agentAssets?.mcp ? (
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
                  onViewLog={(info) => setLogModal(info)}
                />
              );
            })
          )}
        </div>
      </div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-mcp"]} />
      {logModal ? (
        <McpLogDialog
          serverName={logModal.name}
          error={logModal.error}
          log={logModal.log}
          onClose={() => setLogModal(null)}
        />
      ) : null}
    </div>
  );
}
