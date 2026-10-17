import Icon from "./Icon";
import { useAppStore } from "./store";
import { initShell, applyZoom } from "./shell";
import MainColumn from "./components/main/MainColumn";
// App shell: three-column layout (sidebar / main area / right panel) + topbar +
// welcome-vs-session branching + the dock composer + toast.
// The DOM structure and class names mirror the existing static skeleton of
// ui/index.html (zero visual regression during the React migration);
// shell interactions such as collapse/theme are ported from their ui-src/shell.js
// counterparts; full capabilities (resizer drag/zoom) are noted in IMPLEMENTATION_PLAN.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import Sidebar from "./components/main/sidebar/Sidebar";
import RightPanel from "./components/main/right/RightPanel";
import Settings from "./components/settings/Settings";
import BootSplash from "./components/BootSplash";
import KickedScreen from "./components/main/KickedScreen";
import SearchPalette from "./components/shared/SearchPalette";
import CollabDialog from "./components/main/CollabDialog";
import { REMOTE } from "./store/layout";

function Toast() {
  const toastMsg = useAppStore((s) => s.toastMsg);
  const toastErr = useAppStore((s) => s.toastErr);
  if (!toastMsg) return null;
  return (
    <div id="toast" className={toastErr ? "err" : undefined}>
      {toastErr && <Icon name="toastErr" size={13} />}
      {toastMsg}
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  // Shell global listeners mount only once: theme restore/system theme
  // following, resizer drag, ⌘+/-/0 zoom, --col-max segments and rail
  // visibility, window click/blur menu coordination (ui-src/shell.js)
  useEffect(() => {
    initShell();
  }, []);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const rightCollapsed = useAppStore((s) => s.rightCollapsed);
  const narrow = useAppStore((s) => s.narrow);
  const mobileCol = useAppStore((s) => s.mobileCol);
  const kickedByOther = useAppStore((s) => s.kickedByOther);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  // Page swaps remount the column: style.zoom lives on the DOM node, so re-apply the
  // remembered zoom to the freshly mounted page (sidebar/main/right).
  useEffect(() => {
    applyZoom();
  }, [narrow, mobileCol]);
  return (
    <>
      {/* Narrow (remote phones/tablets): one page at a time, ZCode-style — session list,
          chat and right panel each replace the previous page (spec §4.3). No persistent
          bottom tab bar and no floating drawer. */}
      {narrow ? (
        mobileCol === "left" ? (
          <Sidebar collapsed={false} />
        ) : mobileCol === "right" ? (
          <RightPanel collapsed={false} />
        ) : (
          <MainColumn />
        )
      ) : (
        <>
          <Sidebar collapsed={sidebarCollapsed} />
          <div id="left-resizer" className="resizer" title={t("misc.dragResize")} hidden={sidebarCollapsed}></div>
          <MainColumn />
          <div id="right-resizer" className="resizer" title={t("misc.dragResize")} hidden={rightCollapsed}></div>
          <RightPanel collapsed={rightCollapsed} />
        </>
      )}
      {/* Remote clients get no settings surface (spec §4.2); host denylist is the backstop. */}
      {!REMOTE && <Settings />}
      <SearchPalette />
      <CollabDialog />
      {/* Takeover outranks every page: the stale app underneath stays mounted but blocked */}
      {kickedByOther && <KickedScreen />}
      <BootSplash />
      <Toast />
    </>
  );
}
