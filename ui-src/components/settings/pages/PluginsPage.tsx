// Settings page: plugins (pg-plugins).
// Provides the plugin & extension discovery master switch, config rows (SchemaRows), and the
// installed plugin list.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import Icon from "../../../Icon";
import { emptyRow } from "../common";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import type { PluginAssetItem } from "../../../types/frames";

export default function PluginsPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  const agentAssets = useAppStore((s) => s.agentAssets);
  const plugins = agentAssets?.plugins as PluginAssetItem[] | undefined;

  const [spin, setSpin] = useState(false);

  // State detection: no blind guessing before hostSettings lands
  const known = typeof hostSettings?.pluginsEnabled === "boolean";
  const pluginsEnabled = known && !!hostSettings?.pluginsEnabled;

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
      <div className="set-card" id="pluginsList">
        {!agentAssets ? (
          emptyRow(t("common.loading"))
        ) : !plugins || plugins.length === 0 ? (
          <div className="srow">
            <div className="srow-tx">
              <b>{t("settingsPage.plugins.noPluginsTitle")}</b>
              <span>{t("settingsPage.plugins.noPluginsDescA")}<code>omp plugin install &lt;package&gt;</code>{t("settingsPage.plugins.noPluginsDescB")}</span>
            </div>
          </div>
        ) : (
          plugins.map((p) => (
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
