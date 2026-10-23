// Settings page: hooks (pg-hooks).
// Master switch (hooks.enabled controls disableExtensionDiscovery) + runtime config rows
// (SchemaRows) + the discovered hook list, over the shared .mcp-form-* field language:
// - scope capsule filters the list and targets new hooks (profile / project .omp)
// - "new hook" / a row click open the page-level editor window (.set-edit-*), which replaces
//   the whole page body: create asks for the event (tool_call/tool_result with a matcher tool,
//   empty = "*", or a session lifecycle event) and the host writes hooks/<phase>/<tool|event>.ts
//   from an event-aware template, with the scope capsule at the card's top-right (same layout
//   idea as ZCode's hook form); edit reads the hook file on mount and writes it back on save
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast, pathBase } from "../../../store";
import type { HookAssetItem } from "../../../types/frames";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import Icon from "../../../Icon";
import { EditWindowHead, Sel, emptyRow } from "../common";
import ScopeSel from "../ScopeSel";

// The eight events the host template supports (host/assets.ts HOOK_EVENTS). Tool events filter
// by matcher; lifecycle events are one file per event under hooks/pre/ (discovery convention).
const HOOK_EVENTS = ["tool_call", "tool_result", "turn_start", "turn_end", "agent_start", "agent_end", "session_stop", "session_shutdown"] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];
const EVENT_LABEL: Record<HookEvent, string> = {
  tool_call: "PreToolUse",
  tool_result: "PostToolUse",
  turn_start: "TurnStart",
  turn_end: "TurnEnd",
  agent_start: "AgentStart",
  agent_end: "AgentEnd",
  session_stop: "SessionStop",
  session_shutdown: "SessionShutdown",
};
const isToolEvent = (e: string) => e === "tool_call" || e === "tool_result";
// Rows from older hosts predate the event field: derive it from the phase
const rowEvent = (h: HookAssetItem): HookEvent =>
  (h.event as HookEvent) || (h.phase === "pre" ? "tool_call" : "tool_result");

// Hook file editor: reads the file on mount, writes it back and closes on the saved reply.
function HookEditor({ hook, onClose }: { hook: HookAssetItem; onClose: () => void }) {
  const { t } = useTranslation();
  const file = useAppStore((s) => s.assetFile);
  const saved = useAppStore((s) => s.assetSaved);
  const err = useAppStore((s) => s.assetErr);
  const [text, setText] = useState("");
  const [status, setStatus] = useState(() => t("settingsPage.shared.reading"));
  // Replies that landed before this editor mounted must not fire (both frames carry `at`)
  const lastSaved = useRef(useAppStore.getState().assetSaved?.at ?? 0);
  const lastErr = useRef(useAppStore.getState().assetErr?.at ?? 0);

  // Mount = read this hook's file
  useEffect(() => {
    send({ type: "asset_file_read", kind: "hook", path: hook.path });
  }, [hook.path]);

  useEffect(() => {
    if (file && file.kind === "hook" && file.path === hook.path) {
      setText(file.content);
      setStatus("");
    }
  }, [file, hook.path]);

  useEffect(() => {
    if (!saved || saved.kind !== "hook" || saved.at === lastSaved.current) return;
    lastSaved.current = saved.at;
    toast(t("settingsPage.hooks.savedToast", { name: hook.name }));
    onClose();
  }, [saved, onClose, hook.name, t]);

  useEffect(() => {
    if (!err || err.kind !== "hook" || err.at === lastErr.current) return;
    lastErr.current = err.at;
    setStatus(err.message);
  }, [err]);

  const save = () => {
    setStatus(t("settingsPage.shared.saving"));
    send({ type: "asset_file_write", kind: "hook", path: hook.path, content: text });
  };

  return (
    <>
      <EditWindowHead
        title={t("settingsPage.hooks.editTitle")}
        sub={hook.path}
        onBack={onClose}
      >
        <button type="button" className="save-btn" onClick={save}>
          {t("common.save")}
        </button>
      </EditWindowHead>
      <div className="set-card set-edit-card">
        <div className="mcp-form-row">
          <div className="mcp-form-group mcp-form-half mcp-form-narrow">
            <label className="mcp-form-label">{t("settingsPage.hooks.eventLabel")}</label>
            <input className="mcp-form-input mcp-form-code mcp-inp-num" value={EVENT_LABEL[rowEvent(hook)]} disabled readOnly />
          </div>
          {isToolEvent(rowEvent(hook)) && (
            <div className="mcp-form-group mcp-form-half mcp-form-narrow">
              <label className="mcp-form-label">{t("settingsPage.hooks.toolLabel")}</label>
              <input className="mcp-form-input mcp-form-code mcp-inp-num" value={hook.tool || "*"} disabled readOnly />
            </div>
          )}
        </div>
        <div className="mcp-form-hint mcp-form-hint-share">{t("settingsPage.hooks.nameLockedHint")}</div>
        <div className="mcp-form-group">
          <label className="mcp-form-label">{t("settingsPage.hooks.codeLabel")}</label>
          <textarea
            id="hookText"
            className="mcp-form-textarea mcp-form-code"
            rows={20}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {status ? <div className="mcp-form-hint">{status}</div> : null}
      </div>
    </>
  );
}

// Scope dropdown shared by the discovered-list bar and the create form (profile pinned
// first + workspace projects), so both stay on the same scope key.
function HookScopeSel({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { t } = useTranslation();
  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  return (
    <ScopeSel
      value={value}
      onChange={onChange}
      profile={{ id: "profile", label: t("settingsPage.hooks.profileLabel") }}
      projects={allProjects
        .filter((c) => !removedProjects.includes(c))
        .map((c) => ({ id: `project:${c}`, label: c.split("/").pop() || c }))}
    />
  );
}

// Create form: event dropdown + matcher tool + scope capsule (ZCode hook-form layout).
// The host writes the template file and replies with an asset_file frame, whose arrival
// closes the form (the list refresh brings the new row).
function HookNewForm({ scope, onScopeChange, onClose }: {
  scope: string;
  onScopeChange: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const file = useAppStore((s) => s.assetFile);
  const err = useAppStore((s) => s.assetErr);
  const [event, setEvent] = useState<HookEvent>("tool_call");
  const [tool, setTool] = useState("");
  const [status, setStatus] = useState("");
  const pending = useRef(false); // a create request is in flight
  const lastErr = useRef(useAppStore.getState().assetErr?.at ?? 0);

  useEffect(() => {
    if (!pending.current || !file || file.kind !== "hook") return;
    pending.current = false;
    toast(t("settingsPage.hooks.createdToast", { name: pathBase(file.path) }));
    onClose();
  }, [file, onClose, t]);

  useEffect(() => {
    if (!err || err.kind !== "hook" || err.at === lastErr.current) return;
    lastErr.current = err.at;
    pending.current = false;
    setStatus(err.message);
  }, [err]);

  const create = () => {
    // Tool events: empty matcher means "*" (the template drops the toolName filter). Lifecycle
    // events ignore the matcher — the host names the file after the event itself.
    setStatus(t("settingsPage.shared.saving"));
    pending.current = true;
    const ci = scope.indexOf(":");
    const parts = ci < 0 ? { scope } : { scope: scope.slice(0, ci), cwd: scope.slice(ci + 1) };
    send({ type: "asset_file_create", kind: "hook", event, name: tool.trim() || "*", ...parts });
  };

  return (
    <>
      <EditWindowHead
        title={t("settingsPage.hooks.newBtn")}
        sub={t("settingsPage.hooks.newSub")}
        onBack={onClose}
      >
        <button type="button" className="save-btn" onClick={create}>
          {t("settingsPage.hooks.createBtn")}
        </button>
      </EditWindowHead>
      <div className="set-card set-edit-card">
        <div className="mcp-form-row">
          <div className="mcp-form-group mcp-form-half mcp-form-narrow">
            <label className="mcp-form-label">{t("settingsPage.hooks.eventLabel")}</label>
            <Sel
              id="hookEventSel"
              className="mcp-form-sel"
              btnClassName="mcp-form-sel-btn"
              btnChildren={
                <>
                  <span className="mcp-form-sel-cur">{EVENT_LABEL[event]}</span>
                  <span className="caret-svg"><Icon name="caret" size={12} /></span>
                </>
              }
              onPickMi={(mi) => setEvent((mi.dataset.v as HookEvent) || "tool_call")}
            >
              {HOOK_EVENTS.map((e) => (
                <div key={e} className="mi" data-v={e}>
                  <span className="ck" style={{ visibility: event === e ? "visible" : "hidden" }}>✓</span>
                  <span className="mi-label">{EVENT_LABEL[e]}</span>
                </div>
              ))}
            </Sel>
            <div className="mcp-form-hint">{t("settingsPage.hooks.eventHint")}</div>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <span className="mcp-form-label mb-0">{t("settingsPage.hooks.scopeLabel")}</span>
            <HookScopeSel value={scope} onChange={onScopeChange} />
          </div>
        </div>
        {isToolEvent(event) ? (
          <div className="mcp-form-group">
            <label className="mcp-form-label">{t("settingsPage.hooks.matcherLabel")}</label>
            <input
              type="text"
              className="mcp-form-input mcp-form-code mcp-inp-name"
              placeholder={t("settingsPage.hooks.matcherPlaceholder")}
              spellCheck={false}
              autoFocus
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <div className="mcp-form-hint">{t("settingsPage.hooks.matcherHint")}</div>
          </div>
        ) : (
          <div className="mcp-form-group">
            <div className="mcp-form-hint">{t("settingsPage.hooks.lifecycleHint")}</div>
          </div>
        )}
        {status ? <div className="mcp-form-hint">{status}</div> : null}
      </div>
    </>
  );
}

export default function HooksPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  const agentAssets = useAppStore((s) => s.agentAssets);
  const hooks = agentAssets?.hooks as HookAssetItem[] | undefined;

  const [spin, setSpin] = useState(false);
  const [scope, setScope] = useState("profile"); // current scope key ("profile" | "project:<cwd>")
  // Open editor window (replaces the page body): "new" or the hook being edited; null = list
  const [edit, setEdit] = useState<{ mode: "new" } | { mode: "edit"; hook: HookAssetItem } | null>(null);

  const known = typeof hostSettings?.hooksEnabled === "boolean";
  const hooksEnabled = known && !!hostSettings?.hooksEnabled;

  const toggleHooks = () => {
    const next = !hooksEnabled;
    send({ type: "set_hooks_enabled", enabled: next });
    toast(next ? t("settingsPage.hooks.onToast") : t("settingsPage.hooks.offToast"));
  };

  const onRefresh = () => {
    if (spin) return;
    setSpin(true);
    send({ type: "list_agent_assets" });
    setTimeout(() => setSpin(false), 600);
  };

  const toggleHookItem = (id: string, enabled: boolean) => {
    send({ type: "toggle_extension_item", id, enabled });
    const current = useAppStore.getState().agentAssets;
    if (current && Array.isArray(current.hooks)) {
      const nextHooks = current.hooks.map((item) => {
        const itemId = `hook:${item.phase}:${item.tool || "*"}:${item.name}`;
        if (itemId === id) {
          return { ...item, enabled };
        }
        return item;
      });
      useAppStore.setState({ agentAssets: { ...current, hooks: nextHooks } });
    }
  };

  // Hooks under the current scope (profile rows carry no cwd)
  const scopedHooks = (hooks ?? []).filter((h) => (scope === "profile" ? h.scope === "profile" : `project:${h.cwd}` === scope));
  // Hooks dir of the current scope, derived from any member row's path (empty before the first scan lands)
  const scopeDir = scopedHooks.length ? scopedHooks[0].path.replace(/\/(pre|post)\/[^/]+$/, "") : "";

  // Rows and the "new hook" button lead into the page-level editor window
  if (edit) {
    return (
      <div className="set-page" id="pg-hooks">
        {edit.mode === "new"
          ? <HookNewForm scope={scope} onScopeChange={setScope} onClose={() => setEdit(null)} />
          : <HookEditor hook={edit.hook} onClose={() => setEdit(null)} />}
      </div>
    );
  }

  return (
    <div className="set-page" id="pg-hooks">
      <div className="flex items-center justify-between mb-[25px]">
        <div className="set-tt mb-0">{t("settingsPage.nav.hooks")}</div>
        <button
          type="button"
          className={"icon-btn pg-refresh" + (spin ? " spin" : "")}
          id="hooksRefreshBtn"
          title={t("settingsPage.hooks.refreshList")}
          onClick={onRefresh}
        >
          <Icon name="refresh" size={17} />
        </button>
      </div>

      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.hooks.masterTitle")}</b>
            <span>{t("settingsPage.hooks.masterDesc")}</span>
          </div>
          <div
            className={"tg" + (hooksEnabled ? " on" : "") + (known ? "" : " disabled")}
            id="tgHooks"
            title={hooksEnabled ? t("settingsPage.hooks.masterOn") : t("settingsPage.hooks.masterOff")}
            onClick={toggleHooks}
          >
            <i></i>
          </div>
        </div>
      </div>

      <div className="set-group-tt">{t("settingsPage.hooks.runConfigGroup")}</div>
      <div className="set-group-desc">{t("settingsPage.hooks.runConfigDesc")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-hooks"]} />

      <div className="set-group-tt">{t("settingsPage.hooks.discoveredGroup")}</div>
      <div className="set-group-desc">
        {t("settingsPage.hooks.discoveredDescA")}<code>.omp/hooks/</code>{t("settingsPage.hooks.discoveredDescB")}
      </div>
      <div className="agents-bar">
        <HookScopeSel value={scope} onChange={setScope} />
        <span className="truncate text-ui-sm text-faint" id="hooksScopePath" title={scopeDir}>{scopeDir}</span>
        <span className="sp" />
        <button
          type="button"
          className="add-btn"
          id="hookNewBtn"
          onClick={() => setEdit({ mode: "new" })}
        >
          {t("settingsPage.hooks.newBtn")}
        </button>
      </div>
      <div className="set-card mt-[12px]" id="hooksList">
        {!agentAssets ? (
          emptyRow(t("common.loading"))
        ) : scopedHooks.length === 0 ? (
          <div className="srow hook-row" onClick={() => setEdit({ mode: "new" })}>
            <div className="srow-tx">
              <b>{t("settingsPage.hooks.noHooksTitle")}</b>
              <span>{t("settingsPage.hooks.noHooksDescEditor")}</span>
            </div>
            <span className="mem-caret">
              <Icon name="caretSlim" size={14} />
            </span>
          </div>
        ) : (
          scopedHooks.map((h) => {
            const hookId = `hook:${h.phase}:${h.tool || "*"}:${h.name}`;
            const itemEnabled = h.enabled !== false;
            const ev = rowEvent(h);
            return (
              <div
                className="srow hook-row"
                key={h.path || hookId}
                onClick={() => setEdit({ mode: "edit", hook: h })}
              >
                <div className="srow-tx">
                  <div className="flex items-center gap-2 flex-wrap">
                    <b>{h.name}</b>
                    <span
                      className={
                        "text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded leading-none " + /* style-token-ignore */
                        (ev === "tool_call"
                          ? "bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30" /* style-token-ignore */
                          : ev === "tool_result"
                            ? "bg-[var(--green)]/15 text-[var(--green)] border border-[var(--green)]/30" /* style-token-ignore */
                            : "bg-[var(--panel-2)] text-[var(--dim)] border border-[var(--line)]") /* style-token-ignore */
                      }
                    >
                      {EVENT_LABEL[ev]}
                    </span>
                    {isToolEvent(ev) && h.tool && (
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--panel-2)] text-[var(--dim)] border border-[var(--line)]" /* style-token-ignore */>
                        tool: {h.tool}
                      </span>
                    )}
                    <span className="text-[11px] text-[var(--faint)]" /* style-token-ignore */>
                      {h.projectName ? t("settingsPage.hooks.hookProject", { name: h.projectName }) : t("settingsPage.hooks.profileLabel")}
                    </span>
                  </div>
                  <span className="truncate max-w-[500px]" title={h.path}>
                    {h.path}
                  </span>
                </div>
                <div
                  className={"tg" + (itemEnabled && hooksEnabled ? " on" : "") + (!hooksEnabled ? " disabled" : "")}
                  title={!hooksEnabled ? t("settingsPage.hooks.enableFirstTip") : itemEnabled ? t("settingsPage.hooks.disableHookTip") : t("settingsPage.hooks.enableHookTip")}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!hooksEnabled) {
                      toast(t("settingsPage.hooks.masterFirstToast"));
                      return;
                    }
                    toggleHookItem(hookId, !itemEnabled);
                  }}
                >
                  <i></i>
                </div>
                <span className="mem-caret">
                  <Icon name="caretSlim" size={14} />
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
