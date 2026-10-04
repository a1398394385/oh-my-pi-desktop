// Settings page: hooks (pg-hooks).
// Master switch (hooks.enabled controls disableExtensionDiscovery) + runtime config
// rows (SchemaRows) + discovered hook list with a graphical create/edit editor
// (same scope-capsule + list + inline-editor layout as the agents page):
// - scope capsule filters the list and targets new hooks (profile / project .omp)
// - phase pills (pre/post) + tool-name input create hooks/<phase>/<tool>.ts from a
//   phase-aware template on the host
// - clicking a row reads the hook file into the editor; save writes it back
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast, pathBase } from "../../../store";
import type { HookAssetItem } from "../../../types/frames";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import Icon from "../../../Icon";
import { emptyRow } from "../common";
import ScopeSel from "../ScopeSel";

export default function HooksPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  const agentAssets = useAppStore((s) => s.agentAssets);
  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  const hooks = agentAssets?.hooks as HookAssetItem[] | undefined;

  const [spin, setSpin] = useState(false);
  const [scope, setScope] = useState("profile"); // current scope key ("profile" | "project:<cwd>")
  const [newPhase, setNewPhase] = useState<"pre" | "post">("pre"); // create-form phase pills
  const [newTool, setNewTool] = useState(""); // create-form tool name
  const [selPath, setSelPath] = useState<string | null>(null); // editor's current hook file
  const [text, setText] = useState(""); // editor content (controlled textarea)
  const [status, setStatus] = useState(""); // editor status line

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

  // asset_file reply filtered to hooks: load into the editor
  const file = useAppStore((s) => s.assetFile);
  useEffect(() => {
    if (!file || file.kind !== "hook" || !file.path) return;
    setSelPath(file.path);
    setText(file.content);
    setStatus("");
  }, [file]);

  // asset_file_saved reply filtered to hooks: status line shows "saved"
  const saved = useAppStore((s) => s.assetSaved);
  useEffect(() => {
    if (!saved || saved.kind !== "hook") return;
    setStatus(t("settingsPage.shared.saved"));
  }, [saved]);

  // Asset operation failure (read/save/create threw): host replies with an error frame
  const err = useAppStore((s) => s.assetErr);
  useEffect(() => {
    if (!err || err.kind !== "hook") return;
    setStatus(err.message);
  }, [err]);

  const pickScope = (id: string) => {
    setScope(id);
    setSelPath(null);
    setText("");
    setStatus("");
  };

  // Resolve the current scope into {scope, cwd?} for create requests
  const scopeParts = (): { scope: string; cwd?: string } => {
    const ci = scope.indexOf(":");
    return ci < 0 ? { scope } : { scope: scope.slice(0, ci), cwd: scope.slice(ci + 1) };
  };

  const readItem = (h: HookAssetItem) => {
    setSelPath(h.path);
    setStatus(t("settingsPage.shared.reading"));
    send({ type: "asset_file_read", kind: "hook", path: h.path });
  };

  const save = () => {
    if (!selPath) return setStatus(t("settingsPage.hooks.pickFirst"));
    setStatus(t("settingsPage.shared.saving"));
    send({ type: "asset_file_write", kind: "hook", path: selPath, content: text });
  };

  const create = () => {
    const name = newTool.trim();
    if (!name) return setStatus(t("settingsPage.shared.nameFirst"));
    setStatus(t("settingsPage.shared.saving"));
    send({ type: "asset_file_create", kind: "hook", name, phase: newPhase, ...scopeParts() });
  };

  // Hooks under the current scope (profile rows carry no cwd)
  const scopedHooks = (hooks ?? []).filter((h) => (scope === "profile" ? h.scope === "profile" : `project:${h.cwd}` === scope));
  // Hooks dir of the current scope, derived from any member row's path (empty before the first scan lands)
  const scopeDir = scopedHooks.length ? scopedHooks[0].path.replace(/\/(pre|post)\/[^/]+$/, "") : "";

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
          onChange={pickScope}
          profile={{ id: "profile", label: t("settingsPage.hooks.profileLabel") }}
          projects={allProjects
            .filter((c) => !removedProjects.includes(c))
            .map((c) => ({ id: `project:${c}`, label: c.split("/").pop() || c }))}
        />
        <span className="truncate text-ui-sm text-faint" id="hooksScopePath" title={scopeDir}>{scopeDir}</span>
      </div>
      <div className="agents-wrap">
        <div className="set-card" id="hooksList">
          {!agentAssets ? (
            emptyRow(t("common.loading"))
          ) : scopedHooks.length === 0 ? (
            <div className="srow">
              <div className="srow-tx">
                <b>{t("settingsPage.hooks.noHooksTitle")}</b>
                <span>{t("settingsPage.hooks.noHooksDescEditor")}</span>
              </div>
            </div>
          ) : (
            scopedHooks.map((h) => {
              const hookId = `hook:${h.phase}:${h.tool || "*"}:${h.name}`;
              const itemEnabled = h.enabled !== false;
              return (
                <div
                  className="srow"
                  key={h.path || hookId}
                  style={{ cursor: "pointer" }}
                  onClick={() => readItem(h)}
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
                </div>
              );
            })
          )}
        </div>
        <div className="set-card agent-editor" id="hookEditor">
          <div className="ae-head">
            <b id="hookName">{selPath ? pathBase(selPath) : "—"}</b>
            <span id="hookPath">{selPath ?? ""}</span>
            <span className="sp" />
            <div className="mcp-type-pills" id="hookPhasePills">
              {(["pre", "post"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={"mcp-type-pill" + (newPhase === p ? " on" : "")}
                  title={p === "pre" ? t("settingsPage.hooks.phasePreTip") : t("settingsPage.hooks.phasePostTip")}
                  onClick={() => setNewPhase(p)}
                >
                  {p}
                </button>
              ))}
            </div>
            <input
              className="inp"
              id="hookNewTool"
              placeholder={t("settingsPage.hooks.toolPlaceholder")}
              value={newTool}
              onChange={(e) => setNewTool(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <button type="button" className="add-btn" id="hookNew" onClick={create}>{t("settingsPage.shared.newBtn")}</button>
            <button type="button" className="save-btn" id="hookSave" onClick={save}>{t("common.save")}</button>
          </div>
          <textarea
            id="hookText"
            spellCheck={false}
            value={text}
            placeholder={t("settingsPage.hooks.editorPlaceholder")}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="ae-status" id="hookStatus">{status}</div>
        </div>
      </div>
    </div>
  );
}
