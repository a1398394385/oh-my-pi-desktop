// Slash-command output row: reuses the terminal row's (ToolRow CmdRow) visual language —
// an expandable card with the typed command on top and the output below + an ed-arrow.
// Unlike bash output (incidental, collapsed by default) a command's return value IS the
// answer the user asked for, so the card starts expanded; click the header to collapse.
import type { MetaItem } from "../../types/session";
import Icon from "../../Icon";
import { Ellip, FadeBox, useLift, patchActiveItem } from "./parts";
import { t } from "../../i18n";

export default function CommandRow({ item }: { item: MetaItem }) {
  const [closing, close] = useLift();
  const open = item.cmdExpanded !== false && !closing;
  const toggle = () => {
    if (item.cmdExpanded !== false) close(() => patchActiveItem(item, (it) => { it.cmdExpanded = false; }));
    else patchActiveItem(item, (it) => { it.cmdExpanded = true; });
  };
  return (
    <>
      <div className="cmd" style={{ cursor: "pointer" }} onClick={toggle}>
        <span className="c-ic"><Icon name="termBox" size={15} /></span>
        <Ellip className="c-tx" title={item.command}>{item.command ?? ""}</Ellip>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {open && (
        <div className={"cmd-card" + (closing ? " lift" : " drop")}>
          <FadeBox className="cmd-card-cmd">{item.command || t("chat.noCommand")}</FadeBox>
          <FadeBox className="cmd-card-out" as="pre">{item.text || t("chat.noOutput")}</FadeBox>
        </div>
      )}
    </>
  );
}
