// Settings page: plugins (pg-plugins).
// Provides the plugin & extension discovery master switch, config rows (SchemaRows), and the
// installed plugin list. Like the skills/MCP pages the list is scope-switched: the profile
// section lists the profile plugin root's own packages, each project section lists only that
// project's own root (resolved by the base's registry lookup) — no cross-scope inheritance,
// and each row carries its own enable toggle writing to that scope's base-native config.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import { emptyRow } from "../common";
import SchemaRows from "../SchemaRows";
import ScopeSel from "../ScopeSel";
import { useExtSources } from "../ExtSourceTag";
import { PAGE_PLACEMENT } from "../placement";
import type { PluginAssetItem, PluginAssetsPayload, PluginContents } from "../../../types/frames";

// Content groups rendered inside an expanded plugin row, in display order, each mapped
// to the extensions-center kind label (settingsPage.ext.kind*)
const CONTENT_GROUPS: { kind: keyof PluginContents; labelKey: string }[] = [
  { kind: "extensions", labelKey: "settingsPage.ext.kindModule" },
  { kind: "tools", labelKey: "settingsPage.ext.kindTool" },
  { kind: "commands", labelKey: "settingsPage.ext.kindSlash" },
  { kind: "skills", labelKey: "settingsPage.ext.kindSkill" },
  { kind: "rules", labelKey: "settingsPage.ext.kindRule" },
  { kind: "prompts", labelKey: "settingsPage.ext.kindPrompt" },
  { kind: "hooks", labelKey: "settingsPage.ext.kindHook" },
  { kind: "mcp", labelKey: "settingsPage.ext.kindMcp" },
];

export default function PluginsPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  const extByScope = useAppStore((s) => s.extensionsByScope);
  useExtSources(); // extension-center snapshots feed the partial-effect tag below
  const agentAssets = useAppStore((s) => s.agentAssets);

  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  const validProjectCwds = new Set(allProjects.filter((c) => !removedProjects.includes(c)));

  const [scope, setScope] = useState("profile"); // "profile" / "project:<cwd>"
  const [spin, setSpin] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null); // expanded plugin row (path)

  // State detection: no blind guessing before hostSettings lands
  const known = typeof hostSettings?.pluginsEnabled === "boolean";
  const pluginsEnabled = known && !!hostSettings?.pluginsEnabled;
  const data = agentAssets?.plugins as PluginAssetsPayload | undefined;

  const profileSec = {
    scope: "profile",
    label: `Profile · ${data?.profileName ?? "default"}`,
    dir: data?.profileDir,
    plugins: data?.profile ?? [],
  };
  const projectSecs = (data?.projects ?? [])
    .filter((p) => validProjectCwds.has(p.cwd))
    .map((p) => ({ scope: `project:${p.cwd}`, label: p.name, dir: p.dir, plugins: p.plugins }));
  const sections = [profileSec, ...projectSecs];
  // Fall back to the profile level when the current scope is stale
  const curSec = sections.find((s) => s.scope === scope) ?? profileSec;

  // Partial effect: an enabled plugin whose static capability entries (from the
  // extension-center snapshot) are provider-disabled. Its extension modules keep
  // running via the extension runner (that lane ignores provider switches), while
  // skills/commands/MCP entries stay hidden — surface the split on the row.
  const partialLive = (p: PluginAssetItem): boolean => {
    if (!p.enabled) return false;
    // Marketplace installs symlink node_modules into the cache dir and the
    // extension-center entry paths carry the resolved root, so match on the
    // symlink-resolved path when the host supplied one.
    const base = p.realPath || p.path;
    if (!base) return false;
    const root = base.endsWith("/") ? base : base + "/";
    return Object.values(extByScope).some((f) =>
      (f.extensions ?? []).some((e) => e.path?.startsWith(root) && e.disabledReason === "provider-disabled"),
    );
  };

  const togglePlugins = () => {
    const next = !pluginsEnabled;
    send({ type: "set_plugins_enabled", enabled: next });
    toast(next ? t("settingsPage.plugins.onToast") : t("settingsPage.plugins.offToast"));
  };

  // Per-row enable toggle: optimistic reference swap on the current section (same
  // pattern as the skills page), then the host persists to that scope's config file
  const onToggle = (p: PluginAssetItem) => {
    const next = !p.enabled;
    const st = useAppStore.getState();
    const assets = st.agentAssets;
    const payload = assets?.plugins as PluginAssetsPayload | undefined;
    if (assets && payload) {
      const flip = (x: PluginAssetItem) => (x.path === p.path && x.key === p.key ? { ...x, enabled: next } : x);
      const isProfile = curSec.scope === "profile";
      const plugins: PluginAssetsPayload = {
        ...payload,
        profile: isProfile ? payload.profile.map(flip) : payload.profile,
        projects: isProfile
          ? payload.projects
          : payload.projects.map((pr) =>
              pr.cwd === curSec.scope.slice("project:".length) ? { ...pr, plugins: pr.plugins.map(flip) } : pr,
            ),
      };
      useAppStore.setState({ agentAssets: { ...assets, plugins } });
    }
    send({
      type: "asset_plugin_toggle",
      scope: curSec.scope === "profile" ? "profile" : "project",
      cwd: curSec.scope === "profile" ? undefined : curSec.scope.slice("project:".length),
      name: p.key ?? p.name,
      enabled: next,
    });
  };

  const onRefresh = () => {
    setSpin(true);
    send({ type: "list_agent_assets" });
    setTimeout(() => setSpin(false), 500);
  };

  return (
    <div className="set-page" id="pg-plugins">
      <div className="flex items-center justify-between mb-[25px]">
        <div className="set-tt mb-0">{t("settingsPage.nav.plugins")}</div>
        <button
          type="button"
          className={"icon-btn pg-refresh" + (spin ? " spin" : "")}
          id="pluginsRefreshBtn"
          title={t("settingsPage.plugins.refreshList")}
          onClick={onRefresh}
        >
          <Icon name="refresh" size={17} />
        </button>
      </div>

      <div className="set-card">
        <div className="srow">
          <div className="srow-tx">
            <b>{t("settingsPage.plugins.masterTitle")}</b>
            <span>{t("settingsPage.plugins.masterDescA")}<code>disableExtensionDiscovery: false</code>{t("settingsPage.plugins.masterDescB")}</span>
          </div>
          <div
            className={"tg" + (pluginsEnabled ? " on" : "") + (known ? "" : " disabled")}
            id="tgPlugins"
            title={pluginsEnabled ? t("settingsPage.plugins.masterOn") : t("settingsPage.plugins.masterOff")}
            onClick={togglePlugins}
          >
            <i></i>
          </div>
        </div>
      </div>


      <div className="set-group-tt">{t("settingsPage.plugins.configGroup")}</div>
      <div className="set-group-desc">{t("settingsPage.plugins.configDesc")}</div>
      <SchemaRows sections={PAGE_PLACEMENT["pg-plugins"]} />

      <div className="set-group-tt">{t("settingsPage.plugins.installedGroup")}</div>
      <div className="set-group-desc">{t("settingsPage.plugins.installedDescA")}<code>omp</code>{t("settingsPage.plugins.installedDescB")}</div>
      <div className="ext-bar-primary">
        <ScopeSel
          value={scope}
          onChange={setScope}
          profile={{ id: profileSec.scope, label: profileSec.label }}
          projects={projectSecs.map((s) => ({ id: s.scope, label: s.label }))}
        />
        <div className="text-ui-sm font-medium text-dim" id="pluginsScopeDir" title={curSec.dir}>
          {t("settingsPage.plugins.scopeCount", { count: curSec.plugins.length })}
        </div>
      </div>
      <div className="set-card" id="pluginsList">
        {!agentAssets ? (
          emptyRow(t("common.loading"))
        ) : curSec.plugins.length === 0 ? (
          <div className="srow">
            <div className="srow-tx">
              <b>{t("settingsPage.plugins.noPluginsTitle")}</b>
              <span>{t("settingsPage.plugins.noPluginsDescA")}<code>omp plugin install &lt;package&gt;</code>{t("settingsPage.plugins.noPluginsDescB")}</span>
            </div>
          </div>
        ) : (
          curSec.plugins.map((p: PluginAssetItem) => {
            const rowKey = p.path || p.name;
            const open = openKey === rowKey;
            const groups = CONTENT_GROUPS.filter((g) => (p.contents?.[g.kind] ?? []).length > 0);
            return (
              <div key={rowKey}>
                {/* Whole row clickable: expand-down detail (mem-expand pattern); the
                    toggle stops propagation so it never flips the expand state */}
                <div
                  className={"srow plug-row" + (open ? " on" : "")}
                  onClick={() => setOpenKey(open ? null : rowKey)}
                >
                  <div className="srow-tx">
                    <b>
                      {p.name}
                      {partialLive(p) && (
                        <span className="tag ext-tag-warn" style={{ marginLeft: 8 }} title={t("settingsPage.plugins.partialLiveTip")}>
                          {t("settingsPage.plugins.partialLiveTag")}
                        </span>
                      )}
                    </b>
                    <span>{p.description || p.path || t("settingsPage.plugins.pluginFallback")}</span>
                  </div>
                  <div className="srow-ctl">
                    <div
                      className={"tg" + (p.enabled ? " on" : "")}
                      title={p.enabled ? t("settingsPage.shared.enabledTip") : t("settingsPage.shared.disabledTip")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle(p);
                      }}
                    >
                      <i></i>
                    </div>
                    <span className="mem-caret">
                      <Icon name="caretSlim" size={14} />
                    </span>
                  </div>
                </div>
                {open && (
                  <div className="mem-expand plug-detail">
                    {groups.length === 0 ? (
                      <div className="plug-group">
                        <span className="plug-empty">{t("settingsPage.plugins.noContents")}</span>
                      </div>
                    ) : (
                      groups.map((g) => (
                        <div className="plug-group" key={g.kind}>
                          <span className="plug-kind">{t(g.labelKey)}</span>
                          <span className="plug-items">
                            {(p.contents![g.kind] ?? []).map((item) => (
                              <code key={item.name} className="plug-item" title={item.description || undefined}>
                                {item.name}
                                {g.kind === "hooks" && item.description ? <em> · {item.description}</em> : null}
                              </code>
                            ))}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
