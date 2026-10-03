// Subagent card controls (18.5 subagent-control surface): a stop / steer button pair for
// streaming agents plus the inline steer input. Shared by the Agent Hub roster rows and the
// subagent tab's cards — same icons at the same sizes on both surfaces (stopSolid / steer).
// The steer input expands in place below the card content (.mem-expand downward pattern, no
// modal); Enter sends control_subagent {action:"steer"}, Esc closes.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";
import { sendSubagentControl } from "./hubExt";

/** Stop / steer button pair (rendered only while the agent streams; clicks never select the row) */
export function SubControls({ sessionId, agentId, onSteer }: { sessionId: string; agentId: string; onSteer: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="hub-row-acts" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="hub-ibtn"
        title={t("hubExt.stopSub")}
        onClick={() => sendSubagentControl(sessionId, agentId, "cancel")}
      >
        <Icon name="stopSolid" size={12} />
      </button>
      <button type="button" className="hub-ibtn" title={t("hubExt.steerSub")} onClick={onSteer}>
        <Icon name="steer" size={14} />
      </button>
    </span>
  );
}

/** Inline steer composer expanding below the card content; submit is optimistic (the receipt frame needs no surface) */
export function SteerInput({ sessionId, agentId, onClose }: { sessionId: string; agentId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const submit = () => {
    const v = text.trim();
    if (v) sendSubagentControl(sessionId, agentId, "steer", v);
    onClose();
  };
  return (
    <div className="hub-steer" onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        className="hub-steer-input"
        value={text}
        placeholder={t("hubExt.steerPh")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <button type="button" className="hub-ibtn" title={t("hubExt.steerSend")} onClick={submit}>
        <Icon name="arrowUp" size={13} />
      </button>
    </div>
  );
}
