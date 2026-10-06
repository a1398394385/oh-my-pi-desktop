// Session row context menu (ported from the contextmenu branch of ui/sidebar.js initSidebar):
// copy sessionId/file path + rename + archive. The old version's capture-phase interception
// to coordinate with the shell menu doesn't exist in the React version (the menu is a
// component); word-selection undo logic stays in the Sidebar container layer.
import { useTranslation } from "react-i18next";
import { send, toast } from "../../../store";
import Menu from "./Menu";
import { copyText } from "./util";
import type { SessionInfo } from "./SessionRow";

export default function SessCtxMenu({ entry, x, y, onClose, onRename }: {
  entry: SessionInfo;
  x: number;
  y: number;
  onClose: () => void;
  onRename: (entry: SessionInfo) => void;
}) {
  const { t } = useTranslation();
  const item = (label: string, fn: () => void) => (
    <button key={label} onClick={() => { onClose(); fn(); }}>{label}</button>
  );
  return (
    <Menu
      place={(mr) => [
        Math.max(8, Math.min(x, window.innerWidth - mr.width - 8)),
        Math.max(8, Math.min(y, window.innerHeight - mr.height - 8)),
      ]}
      onClose={onClose}
    >
      {item(t("sidebar.copySessionId"), () => {
        copyText(entry.id ?? "");
        toast(t("sidebar.copySessionIdDone"));
      })}
      {item(t("sidebar.copySessionPath"), () => {
        copyText(entry.path);
        toast(t("sidebar.copySessionPathDone"));
      })}
      {item(t("sidebar.rename"), () => onRename(entry))}
      {item(entry.archived ? t("sidebar.unarchive") : t("sidebar.archiveSession"), () => send({ type: "archive_session", sessionId: entry.id, archived: !entry.archived }))}
    </Menu>
  );
}
