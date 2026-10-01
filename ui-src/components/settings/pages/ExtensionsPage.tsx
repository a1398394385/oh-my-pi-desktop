// 设置页：扩展中心（pg-extensions）。omp CLI /extensions 控制中心的设置页搬移植：
// scope 下拉（当前 Profile=用户级+原生 / 各项目=项目级）→ 供应商过滤 + 主开关 →
// 统一条目列表（kind 图标/来源徽标/状态）+ 行内 .mem-expand 详情（与 TUI inspector 同数据面，
// 规则解析/工具文件头/命令预览由 host 预计算下发）。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../../store";
import { t as ti } from "../../../i18n";
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
  skill: "settingsPage.ext.kindSkill",
  rule: "settingsPage.ext.kindRule",
  tool: "settingsPage.ext.kindTool",
  "extension-module": "settingsPage.ext.kindModule",
  mcp: "settingsPage.ext.kindMcp",
  prompt: "settingsPage.ext.kindPrompt",
  instruction: "settingsPage.ext.kindInstruction",
  "context-file": "settingsPage.ext.kindContextFile",
  hook: "settingsPage.ext.kindHook",
  "slash-command": "settingsPage.ext.kindSlash",
};
// 列表排序的 kind 先后（同底座 loadAllExtensions 的加载顺序）
const KIND_ORDER = ["extension-module", "skill", "rule", "tool", "mcp", "prompt", "slash-command", "hook", "instruction", "context-file"];
// level → i18n key (unknown levels pass through as-is)
const LEVEL_LABEL_KEYS: Record<string, string> = { user: "settingsPage.shared.levelUser", project: "settingsPage.shared.levelProject", native: "settingsPage.shared.levelNative" };
const REASON_LABEL: Record<string, string> = {
  "provider-disabled": "settingsPage.ext.reasonProviderDisabled",
  "user-opt-in": "settingsPage.ext.reasonUserOptIn",
  "item-disabled": "settingsPage.ext.reasonItemDisabled",
  shadowed: "settingsPage.ext.reasonShadowed",
};

function stateLabel(ext: ExtensionItem): string {
  if (ext.state === "active") return ti("settingsPage.shared.stateActive");
  if (ext.state === "shadowed") return ti("settingsPage.shared.stateShadowedBy", { name: ext.shadowedBy ?? ti("settingsPage.shared.sameNameEntry") });
  // Unknown reasons (new host-side kinds) pass through as-is; no reason → "unknown"
  const reasonKey = ext.disabledReason ? REASON_LABEL[ext.disabledReason] : undefined;
  const reason = reasonKey ? ti(reasonKey) : ext.disabledReason || ti("settingsPage.ext.reasonUnknown");
  return ti("settingsPage.ext.stateDisabled", { reason });
}


// 条目开关：shadowed 不可点；provider 级原因不乐观翻转（服务端帧为准），手动禁用即时反馈
function ItemToggle({ ext, scope }: { ext: ExtensionItem; scope: string }) {
  const { t } = useTranslation();
  const on = ext.state === "active";
  const optimistic = ext.state !== "shadowed" && (!ext.disabledReason || ext.disabledReason === "item-disabled");
  return (
    <div
      className={`tg${on ? " on" : ""}${ext.state === "shadowed" ? " disabled" : ""}`}
      title={ext.state === "shadowed" ? t("settingsPage.ext.shadowedTip") : on ? t("settingsPage.shared.enabledTip") : t("settingsPage.shared.disabledTip")}
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
  const { t } = useTranslation();
  const raw = ext.raw ?? {};
  const candidate = raw.parameters ?? raw.inputSchema;
  if (!candidate || typeof candidate !== "object") return null;
  const schema = candidate as { properties?: unknown; required?: unknown };
  if (!schema.properties || typeof schema.properties !== "object") return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : []);
  return (
    <div className="ext-kv">
      <span className="ext-k">{t("settingsPage.ext.params")}</span>
      <span className="ext-v ext-params">
        {Object.entries(schema.properties).map(([name, spec]) => {
          const type = spec && typeof spec === "object" ? str((spec as { type?: unknown }).type) : undefined;
          return (
            <span key={name} className="ext-param">
              <b>{name}</b>
              <i>{type ?? "any"}{required.has(name) ? ` · ${t("settingsPage.ext.paramRequired")}` : ""}</i>
            </span>
          );
        })}
      </span>
    </div>
  );
}

// 行内向下延展详情区（.mem-expand，同记忆页模式；数据面同 TUI inspector-model）
function ExtDetail({ ext, onClose }: { ext: ExtensionItem; onClose: () => void }) {
  const { t } = useTranslation();
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
        <button type="button" className="save-btn" onClick={onClose}>{t("settingsPage.shared.collapse")}</button>
      </div>
      <div className="ext-detail">
        <KV k={t("settingsPage.ext.kvSource")} v={`${ext.source.providerName} · ${LEVEL_LABEL_KEYS[ext.source.level] ? t(LEVEL_LABEL_KEYS[ext.source.level]) : ext.source.level}`} />
        <KV k={t("settingsPage.ext.kvPath")} v={ext.path} />
        {ext.trigger ? <KV k={t("settingsPage.ext.kvTrigger")} v={ext.trigger} /> : null}
        <KV k={t("settingsPage.ext.kvDesc")} v={desc} />
        {ext.kind === "skill" ? (
          <>
            <KV
              k={t("settingsPage.ext.kvMatch")}
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
            <KV k={t("settingsPage.ext.kvMatch")} v={list(strList(raw.globs)) ?? (raw.alwaysApply === true ? "always" : undefined)} />
            <KV k={t("settingsPage.ext.kvCondition")} v={list(ext.detail?.condition)} />
            <KV k={t("settingsPage.ext.kvAstCondition")} v={list(ext.detail?.astCondition)} />
            <KV k={t("settingsPage.ext.kvScope")} v={list(ext.detail?.scope)} />
            <KV k="Agents" v={list(ext.detail?.agents)} />
            <KV k={t("settingsPage.ext.kvInterruptMode")} v={rawStr("interruptMode")} />
            <PreBlock text={content} />
          </>
        ) : null}
        {ext.kind === "tool" ? <ToolParams ext={ext} /> : null}
        {ext.kind === "mcp" ? (
          <KV
            k={t("settingsPage.ext.kvConfig")}
            v={
              rawStr("command")
                ? [rawStr("command"), ...(strList(raw.args) ?? [])].filter((x): x is string => typeof x === "string").join(" ")
                : rawStr("url")
            }
          />
        ) : null}
        {ext.kind === "slash-command" ? (
          <>
            <KV k={t("settingsPage.ext.kvArgHint")} v={ext.detail?.argumentHint} />
            <KV k={t("settingsPage.ext.kvUsesArgs")} v={ext.detail?.usesArguments ? "$ARGUMENTS" : undefined} />
            <PreBlock text={ext.detail?.body} />
          </>
        ) : null}
        {ext.kind === "hook" ? (
          <KV k={t("settingsPage.ext.kvHook")} v={`${rawStr("type") ?? "?"} · ${rawStr("tool") ?? "?"}`} />
        ) : null}
        {ext.kind === "instruction" ? <KV k={t("settingsPage.ext.kvApplyTo")} v={rawStr("applyTo")} /> : null}
        {ext.kind === "prompt" || ext.kind === "instruction" || ext.kind === "context-file" ? <PreBlock text={content} /> : null}
        {ext.kind === "extension-module" ? <KV k={t("settingsPage.ext.kvModule")} v={rawStr("name")} /> : null}
      </div>
    </div>
  );
}

export default function ExtensionsPage() {
  const { t } = useTranslation();
  const payload = useAppStore((s) => s.extensions);
  const [scope, setScope] = useState("profile");
  const [prov, setProv] = useState("all");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);
  const pillsRef = useRef<HTMLDivElement>(null);

  // 横向滚轮滚动监听：横向与纵向滚轮都转换为 scrollLeft
  useEffect(() => {
    const pills = pillsRef.current;
    if (!pills) return;

    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      pills.classList.add("is-scrolling");
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        pills.classList.remove("is-scrolling");
      }, 300);
    };

    const onWheel = (e: WheelEvent) => {
      if (pills.scrollWidth <= pills.clientWidth) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) || Math.abs(e.deltaX) > 0) {
        e.preventDefault();
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        pills.scrollLeft += delta;
      }
    };

    pills.addEventListener("scroll", onScroll, { passive: true });
    pills.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      pills.removeEventListener("scroll", onScroll);
      pills.removeEventListener("wheel", onWheel);
      if (scrollTimer) clearTimeout(scrollTimer);
    };
  }, []);

  // 保证当前选中的分支药丸在可视范围内（仅横向局部滚动，严禁使用 scrollIntoView 避免纵向祖先容器抖动）
  useEffect(() => {
    const pills = pillsRef.current;
    if (!pills) return;
    const activeEl = pills.querySelector(".fork-pill.active") as HTMLElement | null;
    if (!activeEl) return;

    const pillsRect = pills.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    const pillLeft = activeRect.left - pillsRect.left + pills.scrollLeft;
    const pillRight = pillLeft + activeEl.offsetWidth;
    const scrollLeft = pills.scrollLeft;
    const clientWidth = pills.clientWidth;

    if (pillLeft < scrollLeft) {
      pills.scrollTo({ left: Math.max(0, pillLeft - 12), behavior: "smooth" });
    } else if (pillRight > scrollLeft + clientWidth) {
      pills.scrollTo({ left: pillRight - clientWidth + 12, behavior: "smooth" });
    }
  }, [prov]);

  useEffect(() => {
    if (prov !== "all" && payload?.providers && !payload.providers.some((p) => p.id === prov)) {
      setProv("all");
    }
  }, [payload, prov]);

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
      <div className="set-tt">{t("settingsPage.nav.extensions")}</div>

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
          <span className="text-ui-base text-dim">{t("settingsPage.ext.countItems", { count: filtered.length })}</span>
        </div>
        <div className="ext-search-wrap">
          <span className="ext-search-icon"><Icon name="search" size={14} /></span>
          <input
            type="text"
            className="ext-search-input"
            placeholder={t("settingsPage.ext.searchPlaceholder")}
            spellCheck="false"
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="ext-bar-secondary">
        <div className="fork-pills ext-prov-pills" ref={pillsRef}>
          <button
            type="button"
            className={`fork-pill ${prov === "all" ? "active" : ""}`}
            onClick={() => setProv("all")}
          >
            <span>{t("settingsPage.ext.allSources")}</span>
            <span className="fork-pill-len">{countOf("all")}</span>
          </button>
          {(payload?.providers ?? []).map((p) => {
            const isActive = prov === p.id;
            return (
              <button
                key={p.id}
                type="button"
                className={`fork-pill ${isActive ? "active" : ""}`}
                onClick={() => setProv(p.id)}
                title={p.description || p.displayName}
              >
                <span className="truncate max-w-[160px]">{p.displayName}</span>
                <span className="fork-pill-len">{countOf(p.id)}</span>
              </button>
            );
          })}
        </div>
        {selProv ? (
          <div className="ext-prov-ctl">
            <span className="text-ui-sm text-dim">{t("settingsPage.ext.enableSource")}</span>
            <div
              className={`tg${selProv.enabled ? " on" : ""}`}
              title={selProv.enabled ? t("settingsPage.ext.sourceEnabledTip") : t("settingsPage.shared.disabledTip")}
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
                <span className="text-ui-sm text-dim">{t("settingsPage.ext.userConfig")}</span>
                <div
                  className={`tg${selProv.userSourceEnabled ? " on" : ""}`}
                  title={selProv.userSourceEnabled ? t("settingsPage.ext.userSourceOn") : t("settingsPage.ext.userSourceOff")}
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
            title={t("settingsPage.model.refresh")}
            onClick={() => refresh()}
          >
            <Icon name="refresh" size={17} />
          </button>
        </div>
      </div>

      <div className="ext-list-wrap">
        {!payload ? (
          <div className="set-card">{emptyRow(t("common.loading"))}</div>
        ) : !filtered.length ? (
          <div className="set-card">{emptyRow(q ? t("settingsPage.ext.emptySearch") : t("settingsPage.ext.emptyScope"))}</div>
        ) : (
          KIND_ORDER.map((kind) => ({ kind, items: filtered.filter((x) => x.kind === kind) }))
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div className="ext-group" key={g.kind}>
                <div className="set-group-tt">
                  {KIND_LABEL[g.kind] ? t(KIND_LABEL[g.kind]) : g.kind}
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
                          <span className="ext-kind-ic" title={KIND_LABEL[ext.kind] ? t(KIND_LABEL[ext.kind]) : ext.kind}>
                            <Icon name={KIND_ICON[ext.kind] ?? "box"} size={13} />
                          </span>
                          <div className="srow-tx">
                            <b>{ext.displayName}</b>
                            <span>{ext.description ?? ext.trigger ?? ext.path}</span>
                          </div>
                          {ext.state === "shadowed" ? (
                            <div className="ext-badges">
                              <span className="tag ext-tag-warn">{t("settingsPage.shared.shadowedTag")}</span>
                            </div>
                          ) : null}
                          <span className="mem-caret"><Icon name="caretSlim" size={14} /></span>
                          <div className="srow-ctl">
                            <ItemToggle ext={ext} scope={scope} />
                          </div>
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
