// Attachment row (ported from the old composer.js renderAttachRow): chips for
// files to send (image/text), each removable; data comes from pendingFiles,
// nothing renders when empty (equivalent to the old hidden).
import { useTranslation } from "react-i18next";
import { useAppStore, setBump } from "../../store";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";

// A pending attachment (structural subset of a pendingFiles element; see
// types/session for the full shape)
type PendingFile = { id: number; name?: string; kind: string };

export default function AttachRow() {
  const { t } = useTranslation();
  const pendingFiles = useAppStore((st) => st.pendingFiles);
  if (pendingFiles.length === 0) return null;
  return (
    <div className="attach-row" id="attachRow">
      {pendingFiles.map((f: PendingFile) => (
        <span className="atchip" key={f.id}>
          <span className="at-ic"><Icon name={f.kind === "image" ? "image" : fileTypeIcon(f.name)} /></span>
          <span className="at-name" title={f.name}>{f.name}</span>
          <button
            className="atchip-x"
            title={t("composer.remove")}
            onClick={() => {
              setBump({ pendingFiles: pendingFiles.filter((it: PendingFile) => it.id !== f.id) });
            }}
          >×</button>
        </span>
      ))}
    </div>
  );
}
