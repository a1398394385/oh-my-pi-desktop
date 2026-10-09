// Settings page: plugins (pg-plugins).
// Provides the plugin & extension discovery master switch, config rows (SchemaRows), and the
// installed plugin list. Like the skills/MCP pages the list is scope-switched: the profile
// section is the profile plugin root, each project section is what a session rooted in that
// project loads (host merges the user root in and lets the project shadow same-named packages).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import { emptyRow } from "../common";
import SchemaRows from "../SchemaRows";
import ScopeSel from "../ScopeSel";
import { PAGE_PLACEMENT } from "../placement";
import type { PluginAssetItem, PluginAssetsPayload } from "../../../types/frames";

export default function PluginsPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  const agentAssets = useAppStore((s) => s.agentAssets);
  const data = agentAssets?.plugins as PluginAssetsPayload | undefined;

  const allProjects = useAppStore((s) => s.allProjects);
  const removedProjects = useAppStore((s) => s.removedProjects);
  const validProjectCwds = new Set(allProjects.filter((c) => !removedProjects.includes(c)));

  const [scope, setScope] = useState("profile"); // "profile" / "project:<cwd>"
  const [spin, setSpin] = useState(false);

  // State detection: no blind guessing before hostSettings lands
  const known = typeof hostSettings?.pluginsEnabled === "boolean";
  const pluginsEnabled = known && !!hostSettings?.pluginsEnabled;

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

  const togglePlugins = () => {
    const next = !pluginsEnabled;
    send({ type: "set_plugins_enabled", enabled: next });
    toast(next ? t("settingsPage.plugins.onToast") : t("settingsPage.plugins.offToast"));
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
          curSec.plugins.map((p: PluginAssetItem) => (
            <div className="srow" key={p.path || p.name}>
              <div className="srow-tx">
                <b>
                  {p.name}
                  {p.version && <span style={{ marginLeft: 8, fontSize: "0.85em", color: "var(--dim)" }}>v{p.version}</span>}
                  {p.scope && <span style={{ marginLeft: 6, fontSize: "0.8em", color: "var(--dim)" }}>[{t(p.scope === "user" ? "settingsPage.shared.levelUser" : "settingsPage.shared.levelProject")}]</span>}
                </b>
                <span>{p.description || p.path || t("settingsPage.plugins.pluginFallback")}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
