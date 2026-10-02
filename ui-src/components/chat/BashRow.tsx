// Local bash execution row (composer ! prefix commands): reuses the terminal row's (ToolRow
// CmdRow) visual language — an expand card with the command on top and output below + an
// ed-arrow arrow. Status area: spinner while running / exit code / cancelled / not-in-context
// tag / error text. Collapsed by default; click the header to expand.
import type { BashItem } from "../../types/session";
import Icon from "../../Icon";
import { Ellip, useLift, Spin, patchActiveItem } from "./parts";
import { t } from "../../i18n";

export default function BashRow({ item }: { item: BashItem }) {
  const [closing, close] = useLift();
  const open = item.cmdExpanded && !closing;
  const toggle = () => {
    if (item.cmdExpanded) close(() => patchActiveItem(item, (it) => { it.cmdExpanded = false; }));
    else patchActiveItem(item, (it) => { it.cmdExpanded = true; });
  };
  // Status area: the running spinner takes priority; error in red; cancelled in a gray tag;
  // the rest colored by exitCode
  let status;
  if (item.running) status = <Spin />;
  else if (item.error != null) status = <span className="bad">{item.error}</span>;
  else if (item.cancelled) status = <span>{t("chat.cancelled")}</span>;
  else if (item.exitCode != null && item.exitCode !== 0) status = <span className="bad">{`exit ${item.exitCode}`}</span>;
  else status = <span>{item.exitCode === 0 ? "exit 0" : t("chat.completed")}</span>;
  return (
    <>
      <div className="cmd bash-row" style={{ cursor: "pointer" }} onClick={toggle}>
        <Ellip className="c-tx" title={item.text}>{`$ ${item.text}`}</Ellip>
        {item.excludeFromContext && <span className="flex-none text-ui-xs text-faint border border-line rounded-[4px] px-[4px]" /* style-token-ignore */>{t("chat.notInContext")}</span>}
        <span className="bash-status">{status}</span>
        <span className={"ed-arrow" + (open ? " open" : "")}>
          <Icon name="chevronRight" />
        </span>
      </div>
      {open && (
        <pre className={"bash-out" + (closing ? " lift" : " drop")}>
          {item.output || (item.running ? <Spin /> : t("chat.noOutput"))}
          {item.truncated ? t("chat.outputTruncated") : ""}
        </pre>
      )}
    </>
  );
}
