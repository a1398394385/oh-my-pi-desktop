// Bottom dock (⌘/Ctrl+J): terminal-only panel spanning the center column.
// Its head IS the tab strip: each tab is one independent terminal (no nested terminal tabs),
// same shape as the right panel where every terminal is its own panel tab.
import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import Icon from "../../Icon";
import { useAppStore, effZoom } from "../../store";
import TerminalPage from "./right/TerminalPage";
import {
  useBottomTermTabs, addBottomTermTab, activateBottomTermTab, closeBottomTermTab, termGroupKey,
} from "./right/termTabs";

// Minimum dock height (layout px); the drag also caps at 80% of the window height.
const BOTTOM_MIN_H = 120;

export default function BottomTerminal() {
  const { t } = useTranslation();
  // Group key flips with the sharing pref/session: one strip per project when shared,
  // the historical global strip otherwise
  const groupKey = useAppStore(() => termGroupKey());
  const tabs = useBottomTermTabs(groupKey);
  const panelRef = useRef<HTMLDivElement>(null);

  // Closing the last terminal closed the dock; reopening materializes a fresh tab
  useEffect(() => {
    if (!tabs.ids.length) addBottomTermTab(groupKey);
  }, [groupKey, tabs.ids.length]);

  // Height lives in the --bottom-h CSS var (documentElement) so it survives the
  // panel's unmount; localStorage is the persisted copy (a bare px number).
  useEffect(() => {
    try {
      const saved = localStorage.getItem("omp-bottom-h");
      const h = Number(saved);
      if (saved && Number.isFinite(h) && h > 0) document.documentElement.style.setProperty("--bottom-h", `${h}px`);
    } catch {}
  }, []);

  const startResize = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const handle = e.currentTarget;
    // clientY is screen px; the dock lives under the zoomed #main, so divide by the
    // zoom factor to get layout px (same conversion the column resizers do).
    const z = effZoom();
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height / z;
    const maxH = Math.max(BOTTOM_MIN_H, (window.innerHeight / z) * 0.8);
    let height = startH;
    const move = (ev: MouseEvent) => {
      height = Math.min(Math.max(startH - (ev.clientY - startY) / z, BOTTOM_MIN_H), maxH);
      document.documentElement.style.setProperty("--bottom-h", `${Math.round(height)}px`);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-v");
      handle.classList.remove("dragging");
      try {
        localStorage.setItem("omp-bottom-h", String(Math.round(height)));
      } catch {}
    };
    document.body.classList.add("resizing-v");
    handle.classList.add("dragging");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  return (
    <div id="bottom-panel" ref={panelRef}>
      <div
        className="bpanel-resizer"
        title={t("misc.dragResizeHeight")}
        onMouseDown={startResize}
      />
      <div className="bpanel-head">
        <Icon name="termBox" size={14} />
        <div className="tpane-tabs">
          {tabs.ids.map((id) => (
            <button
              key={id}
              type="button"
              className={"rtab" + (id === tabs.active ? " on" : "")}
              onClick={() => activateBottomTermTab(groupKey, id)}
            >
              <span className="rtab-tx">{t("misc.terminalTab", { n: Number(id.slice(1)) || 1 })}</span>
              <span
                className="rtab-x"
                title={t("common.close")}
                onClick={(e) => { e.stopPropagation(); closeBottomTermTab(groupKey, id); }}
              >
                <Icon name="xmark" size={12} />
              </span>
            </button>
          ))}
          <button
            type="button"
            className="icon-btn tpane-tab-add"
            title={t("misc.newTerminalTab")}
            onClick={() => addBottomTermTab(groupKey)}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
        <button
          type="button"
          className="icon-btn"
          title={t("common.close")}
          onClick={() => useAppStore.getState().closeBottomTerm(groupKey)}
        >
          <Icon name="xmark" size={14} />
        </button>
      </div>
      {tabs.active && <TerminalPage scope="bottom" tabId={tabs.active} />}
    </div>
  );
}
