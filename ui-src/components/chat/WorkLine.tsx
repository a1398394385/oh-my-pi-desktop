// "Working Ns" row: the working-time line at the bottom of the live segment (LiveProcess).
// The reveal switch lives on the intent row above; this row has no click target of its own.
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
