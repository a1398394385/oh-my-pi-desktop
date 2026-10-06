import { useAppStore } from "./store";
import { initShell } from "./shell";
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

function Toast() {
  const toastMsg = useAppStore((s) => s.toastMsg);
  if (!toastMsg) return null;
  return <div id="toast">{toastMsg}</div>;
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
  return (
    <>
      <Sidebar collapsed={sidebarCollapsed} />
      <div id="left-resizer" className="resizer" title={t("misc.dragResize")} hidden={sidebarCollapsed}></div>
      <MainColumn />
      <div id="right-resizer" className="resizer" title={t("misc.dragResize")} hidden={rightCollapsed}></div>
      <RightPanel collapsed={rightCollapsed} />
      <Settings />
      <Toast />
    </>
  );
}
