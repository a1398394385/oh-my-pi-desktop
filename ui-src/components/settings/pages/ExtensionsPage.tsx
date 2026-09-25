// 设置页：扩展中心（pg-extensions）。omp CLI /extensions 控制中心的设置页搬移植：
// scope 下拉（当前 Profile=用户级+原生 / 各项目=项目级）→ 供应商过滤 + 主开关 →
// 统一条目列表（kind 图标/来源徽标/状态）+ 行内 .mem-expand 详情（与 TUI inspector 同数据面，
// 规则解析/工具文件头/命令预览由 host 预计算下发）。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppStore, send } from "../../../store";
import Icon from "../../../Icon";
import { emptyRow } from "../common";
import type { ExtensionItem } from "../../../types/frames";
import ScopeSel from "../ScopeSel";

// kind → 图标 / 中文标签（图标取全站既有注册名）
const KIND_ICON: Record<string, string> = {
  skill: "skills",
  rule: "shield",
  tool: "plug",
  "extension-module": "plugins",
  mcp: "mcp",
  prompt: "comment",
  instruction: "read",
  "context-file": "file",
  hook: "hook",
  "slash-command": "commands",
};
const KIND_LABEL: Record<string, string> = {
  skill: "技能",
  rule: "规则",
  tool: "工具",
  "extension-module": "扩展模块",
  mcp: "MCP",
  prompt: "提示词",
  instruction: "指令",
  "context-file": "上下文文件",
  hook: "钩子",
  "slash-command": "斜杠命令",
};
// 列表排序的 kind 先后（同底座 loadAllExtensions 的加载顺序）
const KIND_ORDER = ["extension-module", "skill", "rule", "tool", "mcp", "prompt", "slash-command", "hook", "instruction", "context-file"];
const LEVEL_LABEL: Record<string, string> = { user: "用户", project: "项目", native: "内置" };
const REASON_LABEL: Record<string, string> = {
  "provider-disabled": "供应商已禁用",
  "user-opt-in": "未开启 ~/ 配置",
  "item-disabled": "手动禁用",
  shadowed: "被遮蔽",
};

function stateLabel(ext: ExtensionItem): string {
  if (ext.state === "active") return "启用";
  if (ext.state === "shadowed") return `被 ${ext.shadowedBy ?? "同名条目"} 遮蔽`;
  return `已禁用 · ${REASON_LABEL[ext.disabledReason ?? ""] ?? "未知"}`;
}

// 通用下拉（.sel 胶囊 + .menu；同 McpPage 的 Sel，行为对齐旧版 wireSel）
interface SelProps {
  className?: string;
  btnClassName?: string;
  btnTitle?: string;
  btnChildren: ReactNode;
  onPick: (mi: HTMLElement) => void;
  children: ReactNode;
}
function Sel({ className, btnClassName, btnTitle, btnChildren, onPick, children }: SelProps) {
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
    <div className={`sel ${className || ""}`} ref={ref}>
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

// 条目开关：shadowed 不可点；provider 级原因不乐观翻转（服务端帧为准），手动禁用即时反馈
function ItemToggle({ ext, scope }: { ext: ExtensionItem; scope: string }) {
  const on = ext.state === "active";
  const optimistic = ext.state !== "shadowed" && (!ext.disabledReason || ext.disabledReason === "item-disabled");
  return (
    <div
      className={`tg${on ? " on" : ""}${ext.state === "shadowed" ? " disabled" : ""}`}
      title={ext.state === "shadowed" ? "同名条目已被更高优先级来源遮蔽" : on ? "已启用，点击禁用" : "已禁用，点击启用"}
      onClick={(e) => {
        e.stopPropagation();
        if (ext.state === "shadowed") return;
        const next = !on;
        if (optimistic) {
          const st = useAppStore.getState().extensions;
          if (st) {
            useAppStore.setState({
              extensions: {
                ...st,
                extensions: st.extensions.map((x) =>
                  x === ext ? { ...x, state: next ? ("active" as const) : ("disabled" as const), disabledReason: next ? undefined : ("item-disabled" as const) } : x,
                ),
              },
            });
          }
        }
        send({
          type: "toggle_extension_item",
          id: ext.id,
          enabled: next,
          sourcePath: ext.kind === "mcp" ? ext.path : undefined,
          scope,
        });
      }}
    >
      <i />
    </div>
  );
}

// 详情键值行（空值不渲染）
function KV({ k, v }: { k: string; v?: ReactNode }) {
  if (v === undefined || v === null || v === "") return null;
  return (
    <div className="ext-kv">
      <span className="ext-k">{k}</span>
      <span className="ext-v">{v}</span>
    </div>
  );
}

// 正文块（规则/提示/指令/上下文/命令体，host 已截断到 5 万字符）
function PreBlock({ text }: { text?: string }) {
  if (!text) return null;
  return <pre className="ext-pre">{text}</pre>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function strList(v: unknown): string[] | undefined {
  if (typeof v === "string" && v.trim()) return [v.trim()];
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    return out.length ? out : undefined;
  }
  return undefined;
}

// 工具参数表（raw.parameters / raw.inputSchema 的 JSON Schema 子集渲染）
function ToolParams({ ext }: { ext: ExtensionItem }) {
  const raw = ext.raw ?? {};
  const candidate = raw.parameters ?? raw.inputSchema;
  if (!candidate || typeof candidate !== "object") return null;
  const schema = candidate as { properties?: unknown; required?: unknown };
  if (!schema.properties || typeof schema.properties !== "object") return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : []);
  return (
    <div className="ext-kv">
      <span className="ext-k">参数</span>
      <span className="ext-v ext-params">
        {Object.entries(schema.properties).map(([name, spec]) => {
          const type = spec && typeof spec === "object" ? str((spec as { type?: unknown }).type) : undefined;
          return (
            <span key={name} className="ext-param">
              <b>{name}</b>
              <i>{type ?? "any"}{required.has(name) ? " · 必填" : ""}</i>
            </span>
          );
        })}
      </span>
    </div>
  );
}

// 行内向下延展详情区（.mem-expand，同记忆页模式；数据面同 TUI inspector-model）
function ExtDetail({ ext, onClose }: { ext: ExtensionItem; onClose: () => void }) {
  const raw = ext.raw ?? {};
  const fm = (raw.frontmatter ?? {}) as Record<string, unknown>;
  const fmStr = (k: string) => str(fm[k]);
  const rawStr = (k: string) => str(raw[k]);
  const list = (v?: string[]) => (v && v.length ? v.join("、") : undefined);
  // 描述：raw Frontmatter → host 预计算 → 条目级 逐级兜底
  const toolDesc = ext.kind === "tool" ? (ext.detail?.toolHeader ?? rawStr("description") ?? ext.description) : undefined;
  const desc = ext.kind === "skill" ? (fmStr("description") ?? ext.description) : ext.kind === "rule" ? (rawStr("description") ?? ext.description) : toolDesc ?? ext.description;
  const content = rawStr("content");
  return (
    <div className="mem-expand">
      <div className="mem-exp-head">
        <b>{ext.displayName}</b>
        <span className="ext-state">{stateLabel(ext)}</span>
        <span className="sp" />
        <button type="button" className="save-btn" onClick={onClose}>收起</button>
      </div>
      <div className="ext-detail">
        <KV k="来源" v={`${ext.source.providerName} · ${LEVEL_LABEL[ext.source.level] ?? ext.source.level}`} />
        <KV k="路径" v={ext.path} />
        {ext.trigger ? <KV k="触发" v={ext.trigger} /> : null}
        <KV k="描述" v={desc} />
        {ext.kind === "skill" ? (
          <>
            <KV
              k="匹配"
              v={
                list(strList(fm.globs)) ??
                (fm.alwaysApply === true ? "always" : undefined) ??
                (fm.hide === true || fm.disableModelInvocation === true ? "hidden" : undefined)
              }
            />
            <PreBlock text={content} />
          </>
        ) : null}
        {ext.kind === "rule" ? (
          <>
            <KV k="匹配" v={list(strList(raw.globs)) ?? (raw.alwaysApply === true ? "always" : undefined)} />
            <KV k="条件" v={list(ext.detail?.condition)} />
            <KV k="AST 条件" v={list(ext.detail?.astCondition)} />
            <KV k="作用域" v={list(ext.detail?.scope)} />
            <KV k="Agents" v={list(ext.detail?.agents)} />
            <KV k="打断模式" v={rawStr("interruptMode")} />
            <PreBlock text={content} />
          </>
        ) : null}
        {ext.kind === "tool" ? <ToolParams ext={ext} /> : null}
        {ext.kind === "mcp" ? (
          <KV
            k="配置"
            v={
              rawStr("command")
                ? [rawStr("command"), ...(strList(raw.args) ?? [])].filter((x): x is string => typeof x === "string").join(" ")
                : rawStr("url")
            }
          />
        ) : null}
        {ext.kind === "slash-command" ? (
          <>
            <KV k="参数提示" v={ext.detail?.argumentHint} />
            <KV k="接受参数" v={ext.detail?.usesArguments ? "$ARGUMENTS" : undefined} />
            <PreBlock text={ext.detail?.body} />
          </>
        ) : null}
        {ext.kind === "hook" ? (
          <KV k="钩子" v={`${rawStr("type") ?? "?"} · ${rawStr("tool") ?? "?"}`} />
        ) : null}
        {ext.kind === "instruction" ? <KV k="应用于" v={rawStr("applyTo")} /> : null}
        {ext.kind === "prompt" || ext.kind === "instruction" || ext.kind === "context-file" ? <PreBlock text={content} /> : null}
        {ext.kind === "extension-module" ? <KV k="模块" v={rawStr("name")} /> : null}
      </div>
    </div>
  );
}

export default function ExtensionsPage() {
  const payload = useAppStore((s) => s.extensions);
  const [scope, setScope] = useState("profile");
  const [prov, setProv] = useState("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);

  // 进入页面拉一次当前 scope；连接就绪后若仍无数据（打开时机早于 WS 建连）补拉
  const connected = useAppStore((s) => s.connected);
  useEffect(() => {
    send({ type: "list_extensions", scope });
    // 仅在挂载/连接状态变化时补拉；scope 切换由下拉处理函数自行发送
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const refresh = (target?: string) => {
    setSpinning(true);
    window.setTimeout(() => setSpinning(false), 600);
    send({ type: "list_extensions", scope: target ?? scope });
  };

  const items = payload?.extensions ?? [];
  const query = q.trim().toLowerCase();
  const filtered = items
    .filter((ext) => (prov === "all" ? true : ext.source.provider === prov))
    .filter((ext) =>
      !query
        ? true
        : [ext.name, ext.displayName, ext.description, ext.trigger, ext.path].some((f) => f?.toLowerCase().includes(query)),
    )
    .sort((a, b) => {
      const ko = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
      return ko !== 0 ? ko : a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
    });
  const countOf = (pid: string) => (pid === "all" ? items.length : items.filter((x) => x.source.provider === pid).length);
  const selProv = prov === "all" ? null : (payload?.providers.find((p) => p.id === prov) ?? null);

  return (
    <div className="set-page" id="pg-extensions">
      <div className="set-tt">扩展</div>

      <div className="ext-bar-primary">
        <div className="ext-scope-wrap">
          <ScopeSel
            value={scope}
            onChange={(id) => {
              setScope(id);
              setOpenId(null);
              send({ type: "list_extensions", scope: id });
            }}
            profile={payload?.scopes[0] ?? { id: "profile", label: "Profile" }}
            projects={(payload?.scopes ?? []).slice(1)}
          />
          <span className="ext-divider">|</span>
          <span className="text-ui-base text-dim">{filtered.length} 项</span>
        </div>
        <div className="ext-search-wrap">
          <span className="ext-search-icon"><Icon name="search" size={14} /></span>
          <input
            type="text"
            className="ext-search-input"
            placeholder="搜索扩展…"
            spellCheck="false"
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="ext-bar-secondary">
        <Sel
          className="ext-prov-sel"
          btnClassName="ext-prov-btn"
          btnChildren={
            <>
              <span>{selProv ? selProv.displayName : "全部来源"}</span>
              <span className="caret-svg"><Icon name="caret" size={14} /></span>
            </>
          }
          onPick={(mi) => setProv(mi.dataset.prov ?? "all")}
        >
          <div className="mi" data-prov="all" key="all">
            <span className="ck" style={{ visibility: prov === "all" ? "visible" : "hidden" }}>✓</span>
            <span className="mi-label">全部来源</span>
            <span className="sub">{countOf("all")}</span>
          </div>
          <div className="sep" />
          {(payload?.providers ?? []).map((p) => (
            <div className="mi" data-prov={p.id} key={p.id}>
              <span className="ck" style={{ visibility: prov === p.id ? "visible" : "hidden" }}>✓</span>
              <span className="mi-label" title={p.description}>{p.displayName}</span>
              <span className="sub">{countOf(p.id)}</span>
            </div>
          ))}
        </Sel>
        {selProv ? (
          <div className="ext-prov-ctl">
            <span className="text-ui-sm text-dim">启用该来源</span>
            <div
              className={`tg${selProv.enabled ? " on" : ""}`}
              title={selProv.enabled ? "已启用，点击禁用整个来源" : "已禁用，点击启用"}
              onClick={() => {
                const st = useAppStore.getState().extensions;
                if (st) {
                  useAppStore.setState({
                    extensions: {
                      ...st,
                      providers: st.providers.map((p) => (p.id === selProv.id ? { ...p, enabled: !p.enabled } : p)),
                    },
                  });
                }
                send({ type: "toggle_extension_provider", providerId: selProv.id, scope });
              }}
            >
              <i />
            </div>
            {selProv.foreignUserSource ? (
              <>
                <span className="text-ui-sm text-dim">~/ 配置</span>
                <div
                  className={`tg${selProv.userSourceEnabled ? " on" : ""}`}
                  title={selProv.userSourceEnabled ? "已 opt-in，点击关闭" : "未启用，点击 opt-in"}
                  onClick={() => {
                    const st = useAppStore.getState().extensions;
                    if (st) {
                      useAppStore.setState({
                        extensions: {
                          ...st,
                          providers: st.providers.map((p) => (p.id === selProv.id ? { ...p, userSourceEnabled: !p.userSourceEnabled } : p)),
                        },
                      });
                    }
                    send({ type: "toggle_extension_user_source", providerId: selProv.id, scope });
                  }}
                >
                  <i />
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="ext-actions-wrap">
          <button
            type="button"
            className={`icon-btn pg-refresh${spinning ? " spin" : ""}`}
            title="刷新"
            onClick={() => refresh()}
          >
            <Icon name="refresh" size={17} />
          </button>
        </div>
      </div>

      <div className="ext-list-wrap">
        {!payload ? (
          <div className="set-card">{emptyRow("加载中…")}</div>
        ) : !filtered.length ? (
          <div className="set-card">{emptyRow(q ? "未找到匹配的扩展" : "当前范围暂无扩展")}</div>
        ) : (
          KIND_ORDER.map((kind) => ({ kind, items: filtered.filter((x) => x.kind === kind) }))
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div className="ext-group" key={g.kind}>
                <div className="set-group-tt">
                  {KIND_LABEL[g.kind] ?? g.kind}
                  <span className="ext-cnt">{g.items.length}</span>
                </div>
                <div className="set-card">
                  {g.items.map((ext) => {
                    const open = openId === ext.id;
                    return (
                      <div key={ext.id} className="ext-row-wrap">
                        <div
                          className={`srow ext-row${open ? " on" : ""}${ext.state !== "active" ? " off" : ""}`}
                          onClick={() => setOpenId(open ? null : ext.id)}
                        >
                          <span className="ext-kind-ic" title={KIND_LABEL[ext.kind] ?? ext.kind}>
                            <Icon name={KIND_ICON[ext.kind] ?? "box"} size={13} />
                          </span>
                          <div className="srow-tx">
                            <b>{ext.displayName}</b>
                            <span>{ext.description ?? ext.trigger ?? ext.path}</span>
                          </div>
                          <div className="ext-badges">
                            <span className="tag">{LEVEL_LABEL[ext.source.level] ?? ext.source.level}</span>
                            {ext.state === "shadowed" ? <span className="tag ext-tag-warn">遮蔽</span> : null}
                          </div>
                          <div className="srow-ctl">
                            <ItemToggle ext={ext} scope={scope} />
                          </div>
                          <span className="mem-caret"><Icon name="caretSlim" size={14} /></span>
                        </div>
                        {open ? <ExtDetail ext={ext} onClose={() => setOpenId(null)} /> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
