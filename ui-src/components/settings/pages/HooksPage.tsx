// Settings page: hooks (pg-hooks).
// Master switch (hooks.enabled controls disableExtensionDiscovery) + runtime config rows
// (SchemaRows) + the discovered hook list, over the shared .mcp-form-* field language:
// - scope capsule filters the list and targets new hooks (profile / project .omp)
// - "new hook" / a row click open the page-level editor window (.set-edit-*), which replaces
//   the whole page body: create asks for the phase + tool and the host writes
//   hooks/<phase>/<tool>.ts from a phase-aware template; edit reads the hook file on mount and
//   writes it back on save
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast, pathBase } from "../../../store";
import type { HookAssetItem } from "../../../types/frames";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import Icon from "../../../Icon";
import { EditWindowHead, emptyRow } from "../common";
import ScopeSel from "../ScopeSel";

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
            <label className="mcp-form-label">{t("settingsPage.hooks.phaseLabel")}</label>
            <input className="mcp-form-input mcp-form-code mcp-inp-num" value={hook.phase} disabled readOnly />
          </div>
          <div className="mcp-form-group mcp-form-half mcp-form-narrow">
            <label className="mcp-form-label">{t("settingsPage.hooks.toolLabel")}</label>
            <input className="mcp-form-input mcp-form-code mcp-inp-num" value={hook.tool || "*"} disabled readOnly />
          </div>
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

// Create form: phase pills + tool name; the host writes the template file and replies with
// an asset_file frame, whose arrival closes the form (the list refresh brings the new row).
function HookNewForm({ scope, onClose }: { scope: { scope: string; cwd?: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const file = useAppStore((s) => s.assetFile);
  const err = useAppStore((s) => s.assetErr);
  const [phase, setPhase] = useState<"pre" | "post">("pre");
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
    const name = tool.trim();
    if (!name) {
      toast(t("settingsPage.shared.nameFirst"));
      return;
    }
    setStatus(t("settingsPage.shared.saving"));
    pending.current = true;
    send({ type: "asset_file_create", kind: "hook", name, phase, ...scope });
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
        <div className="mcp-form-group">
          <label className="mcp-form-label">{t("settingsPage.hooks.phaseLabel")}</label>
          <div className="mcp-type-pills" id="hookPhasePills">
            {(["pre", "post"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={"mcp-type-pill" + (phase === p ? " on" : "")}
                title={p === "pre" ? t("settingsPage.hooks.phasePreTip") : t("settingsPage.hooks.phasePostTip")}
                onClick={() => setPhase(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <div className="mcp-form-group">
          <label className="mcp-form-label">{t("settingsPage.hooks.toolLabel")}</label>
          <input
            type="text"
            className="mcp-form-input mcp-form-code mcp-inp-name"
            placeholder={t("settingsPage.hooks.toolPlaceholder")}
            spellCheck={false}
            autoFocus
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
          <div className="mcp-form-hint">{t("settingsPage.hooks.toolNameHint")}</div>
        </div>
        {status ? <div className="mcp-form-hint">{status}</div> : null}
      </div>
    </>
  );
}

export default function HooksPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  const agentAssets = useAppStore((s) => s.agentAssets);
  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
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

  // Resolve the current scope into {scope, cwd?} for create requests
  const scopeParts = (): { scope: string; cwd?: string } => {
    const ci = scope.indexOf(":");
    return ci < 0 ? { scope } : { scope: scope.slice(0, ci), cwd: scope.slice(ci + 1) };
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
          ? <HookNewForm scope={scopeParts()} onClose={() => setEdit(null)} />
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
        <ScopeSel
          value={scope}
          onChange={setScope}
          profile={{ id: "profile", label: t("settingsPage.hooks.profileLabel") }}
          projects={allProjects
            .filter((c) => !removedProjects.includes(c))
            .map((c) => ({ id: `project:${c}`, label: c.split("/").pop() || c }))}
        />
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
                        (h.phase === "pre"
                          ? "bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/30" /* style-token-ignore */
                          : "bg-[var(--green)]/15 text-[var(--green)] border border-[var(--green)]/30") /* style-token-ignore */
                      }
                    >
                      {h.phase}
                    </span>
                    {h.tool && (
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
