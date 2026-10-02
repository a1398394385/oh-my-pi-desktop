// Settings page: hooks (pg-hooks).
// Provides the master switch (hooks.enabled controls disableExtensionDiscovery), runtime
// config rows (SchemaRows), and the list of discovered hooks.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, toast } from "../../../store";
import type { HookAssetItem } from "../../../types/frames";
import SchemaRows from "../SchemaRows";
import { PAGE_PLACEMENT } from "../placement";
import Icon from "../../../Icon";
import { emptyRow } from "../common";

export default function HooksPage() {
  const { t } = useTranslation();
  const hostSettings = useAppStore((s) => s.hostSettings);
  const agentAssets = useAppStore((s) => s.agentAssets);
  const hooks = agentAssets?.hooks as HookAssetItem[] | undefined;

  const [spin, setSpin] = useState(false);

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
      <div className="set-card" id="hooksList">
        {!agentAssets ? (
          emptyRow(t("common.loading"))
        ) : !hooks || hooks.length === 0 ? (
          <div className="srow">
            <div className="srow-tx">
              <b>{t("settingsPage.hooks.noHooksTitle")}</b>
              <span dangerouslySetInnerHTML={{ __html: t("settingsPage.hooks.noHooksDesc") }} />
            </div>
          </div>
        ) : (
          hooks.map((h) => {
            const hookId = `hook:${h.phase}:${h.tool || "*"}:${h.name}`;
            const itemEnabled = h.enabled !== false;
            return (
              <div className="srow" key={h.path || hookId}>
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
                  onClick={() => {
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
    </div>
  );
}
