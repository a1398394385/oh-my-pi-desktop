// Local bash execution row (composer ! prefix commands), rendered as a user bubble: the
// command line on top, a divider, the streamed output below. A running command shows a
// spinner in the command line; the command's exit status / error takes its place once it
// ends. The row is a plain flow node: unlike a user message it is never pinned to the top
// of the viewport (no .sticky-user-wrap wrapper).
import type { BashItem } from "../../types/session";
import { Spin } from "./parts";
import { t } from "../../i18n";

export default function BashRow({ item }: { item: BashItem }) {
  // Command-line status: the running spinner takes priority; error in red; cancelled in a
  // gray tag; the rest colored by exitCode
  let status;
  if (item.running) status = <Spin />;
  else if (item.error != null) status = <span className="bad">{item.error}</span>;
  else if (item.cancelled) status = <span>{t("chat.cancelled")}</span>;
  else if (item.exitCode != null && item.exitCode !== 0) status = <span className="bad">{`exit ${item.exitCode}`}</span>;
  else status = <span>{item.exitCode === 0 ? "exit 0" : t("chat.completed")}</span>;
  return (
    <div className="msg user bash-msg">
      <div className="user-bubble">
        <div className="bash-cmd">
          <span className="bash-prompt">$</span>
          <span className="bash-cmd-text">{item.text}</span>
          {item.excludeFromContext && <span className="bash-tag">{t("chat.notInContext")}</span>}
          <span className="bash-status">{status}</span>
        </div>
        {/* Output section (the divider above it belongs to it): only rendered once there is
            something to show — an empty box under a still-running command is pure noise */}
        {(item.output || !item.running) && (
          <pre className="bash-out">
            {item.output || t("chat.noOutput")}
            {item.truncated ? t("chat.outputTruncated") : ""}
          </pre>
        )}
      </div>
    </div>
  );
}
