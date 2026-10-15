// "Working Ns" row (the former WorkLine.jsx; the streaming status row has been merged into
// ChatLoading — the spinner + dynamic text now hangs at the end of the message stream,
// above the composer and flush left, no longer a standalone row).
import { useEffect, useState } from "react";
import { activeOpen } from "../../store";
import { fmtDuration } from "./util";
import { t } from "../../i18n";

// "Working Ns": 250ms polling reads real time (setInterval(1000) is not phase-aligned with
// turnStartAt, and when the main thread is blocked by streaming redraws the callbacks get
// compressed and skipped)
export function WorkSec() {
  const [sec, setSec] = useState(() => {
    const cur = activeOpen();
    return cur?.turnStartAt ? Math.floor((Date.now() - cur.turnStartAt) / 1000) : 0;
  });
  useEffect(() => {
    // renamed from `t` to avoid shadowing the i18n t() import
    const timer = setInterval(() => {
      const s = activeOpen();
      if (s?.turnStartAt) setSec(Math.floor((Date.now() - s.turnStartAt) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="act t2">
      {t("chat.workingFor")}<span id="workSec">{fmtDuration(sec)}</span>
    </div>
  );
}
