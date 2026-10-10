// Capabilities card: shows what the active session actually loaded — MCP servers
// (with connection status), plugin packages (with the status badges extensions
// inject into the TUI status line, e.g. ponytail's setStatus — the desktop has no
// status line, so they land here), and the session-level capability flags
// (plan / computer use / goal / advisor) the TUI would draw in its mode segment.
// Two shapes share one content body (CapsList):
//  - CapsFloat: bottom-right floating overlay of the middle column (folds to a
//    capsule). Auto-hidden when the right panel is expanded (the docked form
//    takes over) or the middle column is too narrow for the card.
//  - CapsDock: bottom section of the right panel (#rightCaps). Not a tab — its
//    presence is driven purely by the panel being expanded + caps data; the
//    section folds to a slim rail. capsCardCollapsed drives both shapes' fold
//    state (float capsule ⇔ docked rail), so the two stay linked.
// Data: the get_capabilities snapshot (refetched per session activation, effect
// lives in CapsFloat which is mounted whenever the message page is) + the live
// capabilities_mcp / extension_status merges; plan/computer/goal ride the session
// fields their own frames maintain.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, setBump } from "../../store";
import Icon from "../../Icon";

// Hide the floating card below this middle-column width: it would otherwise
// swallow most of the composer (the card is ~334px wide incl. its edge gap)
const CAPS_FLOAT_MIN_W = 600;

// MCP connection status → dot tone + label i18n key (ok green / wait yellow / off faint),
// the same tones the right-panel capabilities tab used
const MCP_STATUS: Record<string, { dot: string; label: string }> = {
  connected: { dot: "ok", label: "right.capsStConnected" },
  connecting: { dot: "wait", label: "right.capsStConnecting" },
  disconnected: { dot: "off", label: "right.capsStDisconnected" },
};

// Shared derived view (both shapes subscribe; same store sources, no side effects)
function useCapsView() {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const snap = useAppStore((st) => st.capabilities);
  const sessionId = s?.sessionId;

  // A snapshot from another session is stale: render nothing until the refetch lands
  const current = snap && snap.sessionId === sessionId ? snap : null;
  const servers = current?.mcp.servers ?? [];
  const plugins = current?.plugins ?? [];
  const badges = current?.extStatuses ?? [];
  const flags: string[] = [];
  if (s?.planMode) flags.push(t("composer.planMode"));
  if (s?.computerMode) flags.push(t("chat.capFlagComputer"));
  if (s?.goal?.enabled) flags.push(t("chat.capFlagGoal"));
  if (current?.advisor.active) flags.push(t("right.capsAdvisor"));

  // A plugin's badge is the status row whose key matches the package name (scoped
  // packages: ponytail registers the key "ponytail" but the package row is
  // "@dietrichgebert/ponytail", so the scope tail matches too); leftovers render standalone
  const badgeMatches = (plugin: string, key: string) => plugin === key || plugin.endsWith(`/${key}`);
  const badgeByPlugin = new Map<string, string>();
  for (const [key, text] of badges) {
    const hit = plugins.find((p) => badgeMatches(p, key));
    if (hit) badgeByPlugin.set(hit, text);
  }
  const orphanBadges = badges.filter(([key]) => !plugins.some((p) => badgeMatches(p, key)));
  const total = servers.length + plugins.length + orphanBadges.length + flags.length;
  const empty = total === 0;
  return { s, sessionId, servers, plugins, badgeByPlugin, orphanBadges, flags, total, empty };
}

// Card content body (no container): MCP / plugins / session-mode sections
function CapsList({
  servers,
  plugins,
  badgeByPlugin,
  orphanBadges,
  flags,
}: {
  servers: { name: string; status: string }[];
  plugins: string[];
  badgeByPlugin: Map<string, string>;
  orphanBadges: [string, string][];
  flags: string[];
}) {
  const { t } = useTranslation();
  return (
    <>
      {servers.length > 0 && (
        <div className="cc-sec">
          <div className="cc-tt">{t("right.capsMcp")}</div>
          {servers.map((sv) => (
            <div className="cc-row" key={sv.name} title={sv.name}>
              <span className={"cc-dot " + (MCP_STATUS[sv.status]?.dot ?? "off")} />
              <span className="cc-name">{sv.name}</span>
              <span className="cc-st">{MCP_STATUS[sv.status] ? t(MCP_STATUS[sv.status].label) : sv.status}</span>
            </div>
          ))}
        </div>
      )}
      {plugins.length > 0 && (
        <div className="cc-sec">
          <div className="cc-tt">{t("chat.capsPlugins")}</div>
          {plugins.map((name) => (
            <div className="cc-row" key={name} title={badgeByPlugin.get(name) ?? name}>
              <span className="cc-dot on" />
              <span className="cc-name">{name}</span>
              {badgeByPlugin.has(name) && <span className="cc-st">{badgeByPlugin.get(name)}</span>}
            </div>
          ))}
          {orphanBadges.map(([key, text]) => (
            <div className="cc-row" key={key} title={text}>
              <span className="cc-dot on" />
              <span className="cc-name">{key}</span>
              <span className="cc-st">{text}</span>
            </div>
          ))}
        </div>
      )}
      {flags.length > 0 && (
        <div className="cc-sec">
          <div className="cc-tt">{t("chat.capsFlags")}</div>
          <div className="cc-flags">
            {flags.map((f) => (
              <span className="cc-flag" key={f}>{f}</span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// Floating shape: middle column's bottom-right overlay, bottom edge flush with the
// composer dock's bottom edge. Auto-hidden while the right panel is expanded (the
// docked shape takes over) or the middle column is narrower than CAPS_FLOAT_MIN_W.
export function CapsFloat() {
  const { t } = useTranslation();
  const collapsed = useAppStore((st) => st.capsCardCollapsed);
  const rightCollapsed = useAppStore((st) => st.rightCollapsed);
  const view = useCapsView();

  // Snapshot fetch on session activation (stays mounted with the message page, so
  // the docked shape — mounted in the right panel — never needs its own fetch)
  useEffect(() => {
    if (view.sessionId) useAppStore.getState().fetchCapabilities();
  }, [view.sessionId]);

  // Bottom gap to the composer dock's bottom edge (both rect diffs are zoom-safe);
  // the dock height is dynamic (growing input, stacked goal/queue/approval cards),
  // so the gap is measured, not a CSS constant. Main width drives the auto-hide.
  const [bottom, setBottom] = useState(88);
  const [mainW, setMainW] = useState(Infinity);
  useEffect(() => {
    const main = document.getElementById("main");
    const dock = main?.querySelector(".dock");
    if (!main || !dock) return;
    const update = () => {
      setBottom(Math.max(0, Math.round(main.getBoundingClientRect().bottom - dock.getBoundingClientRect().bottom)));
      setMainW(main.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(dock);
    ro.observe(main);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  if (!view.s || view.empty) return null;
  if (!rightCollapsed || mainW < CAPS_FLOAT_MIN_W) return null;

  return (
    <div id="capsWrap" style={{ bottom }}>
      {!collapsed && (
        <div id="capsCard">
          <div className="cc-head">
            <b>{t("chat.capsCardTitle")}</b>
            <span className="flex-1"></span>
            <button
              className="icon-btn"
              title={t("chat.collapseToCapsule")}
              onClick={() => setBump({ capsCardCollapsed: true })}
            >
              <Icon name="collapseCard" />
            </button>
          </div>
          <CapsList
            servers={view.servers}
            plugins={view.plugins}
            badgeByPlugin={view.badgeByPlugin}
            orphanBadges={view.orphanBadges}
            flags={view.flags}
          />
        </div>
      )}
      {collapsed && (
        <button
          id="capsCardCapsule"
          title={t("chat.capsCardTitle")}
          onClick={() => setBump({ capsCardCollapsed: false })}
        >
          <span className="cc-cap-ic"><Icon name="stats" size={13} /></span>
          <span className="cap-tx">{t("chat.capsCardTitle")}</span>
          <span className="cap-n">{view.total}</span>
        </button>
      )}
    </div>
  );
}

// Docked shape: bottom section of the right panel. Appears only while the panel is
// expanded (the float shape's auto-hide handoff); folds to a slim rail via the same
// capsCardCollapsed flag, keeping the two shapes linked.
export function CapsDock() {
  const { t } = useTranslation();
  const collapsed = useAppStore((st) => st.capsCardCollapsed);
  const rightCollapsed = useAppStore((st) => st.rightCollapsed);
  const hubOpen = useAppStore((st) => st.hubOpen);
  const isCreatingNew = useAppStore((st) => st.isCreatingNew);
  const view = useCapsView();

  if (rightCollapsed || hubOpen || isCreatingNew || !view.s || view.empty) return null;

  return (
    <div id="rightCaps" className={collapsed ? "" : "open"}>
      <button
        className="rc-head"
        title={collapsed ? t("chat.capsDockExpand") : t("chat.capsDockCollapse")}
        onClick={() => setBump({ capsCardCollapsed: !collapsed })}
      >
        <span className="rc-ic"><Icon name="stats" size={13} /></span>
        <span className="rc-tt">{t("chat.capsCardTitle")}</span>
        <span className="rc-n">{view.total}</span>
        <span className="rc-caret"><Icon name="caret" size={10} /></span>
      </button>
      <div className="rc-fold">
        <div className="rc-body">
          <div className="rc-pad">
            <CapsList
              servers={view.servers}
              plugins={view.plugins}
              badgeByPlugin={view.badgeByPlugin}
              orphanBadges={view.orphanBadges}
              flags={view.flags}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
