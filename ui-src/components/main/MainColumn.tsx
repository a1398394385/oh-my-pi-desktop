import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../store";
import { addIncomingFiles } from "../../lib/incoming-files";
import Icon from "../../Icon";
import { bashAccentColor, sessionAccentColor } from "../../lib/session-color";
import { toggleSidebar, toggleRightPanel, bindColResizer } from "../../shell";
import MainHeader from "./MainHeader";
import Welcome from "./WelcomePage";
import MessagePage from "./chat/MessagePage";
import AgentHub from "./AgentHubPage";
import AutomationsPage from "./automations/AutomationsPage";
import GitPage from "./git/GitPage";
import MainSessionTree from "./tree/MainSessionTree";
import Composer from "../Composer";
import ApprovalCard from "../chat/ApprovalCard";
import SessionStatsBar from "./SessionStatsBar";
import QueueCard from "../composer/QueueCard";
import GoalCard from "../composer/GoalCard";
import SessionNotice from "../composer/SessionNotice";
import ConnBanner from "./ConnBanner";
import ModelFallbackNotice from "./ModelFallbackNotice";

export default function MainColumn() {
  const { t } = useTranslation();
  const isCreatingNew = useAppStore((s) => s.isCreatingNew);
  const automationsOpen = useAppStore((s) => s.automationsOpen);
  const gitManage = useAppStore((s) => s.gitManage);
  const hubOpen = useAppStore((s) => s.hubOpen);
  const mainViewMode = useAppStore((s) => s.mainViewMode);
  const activePath = useAppStore((s) => s.activePath);
  const session = useAppStore((s) => s.activePath ? s.openSessions.get(s.activePath) : undefined);
  const pendingApproval = session?.pendingApprovals?.[0] ?? null;
  // Composer ring tint: null until the session is named. Reads the live session title and
  // falls back to the list row — an auto title can land in diskProjects before (or instead
  // of) the opened session's own copy, and the sidebar already shows the list row, so the
  // accent must not lag behind it.
  const title = useAppStore((s) => {
    const cur = s.activePath ? s.openSessions.get(s.activePath) : undefined;
    if (!cur) return null;
    if (cur.title) return cur.title;
    for (const p of s.diskProjects) {
      for (const r of p.sessions) if (r.id === cur.sessionId) return r.title ?? null;
    }
    return null;
  });
  const accent = sessionAccentColor(title);
  // Bash mode overrides --bash on the dock so every terminal visual (ring, placeholder,
  // halo) follows one color: the next palette slot, never the input's own
  const bashAccent = bashAccentColor(title);
  const ringRef = useRef<SVGSVGElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  // The column width handles belong to the session detail page only (mirrors the
  // MessagePage branch of the page switch below).
  const showSessionDetail =
    !gitManage && !isCreatingNew && !automationsOpen && !hubOpen && !(session && mainViewMode === "tree");

  // Ring speed follows typing tempo: idle = the 6s CSS cycle, faster hands spin it up to 3×
  // (2s). playbackRate, not animation-duration — changing the duration rescales the current
  // progress and makes the dash jump; playbackRate keeps the position continuous while the
  // speed changes. Stamps fall out of a 1.5s window, so the ring eases back once typing stops.
  useEffect(() => {
    const WINDOW_MS = 1500;
    const MAX_RATE = 3;
    const stamps: number[] = [];
    let timer: number | undefined;
    const apply = () => {
      const now = performance.now();
      while (stamps.length && now - stamps[0] > WINDOW_MS) stamps.shift();
      const perSec = (stamps.length / WINDOW_MS) * 1000;
      // ~3 keys/s (ordinary typing) doubles the speed; 6 keys/s and above hits the 3× cap
      const anim = ringRef.current?.querySelector("rect")?.getAnimations()[0];
      if (anim) anim.playbackRate = perSec === 0 ? 1 : Math.min(MAX_RATE, 1 + perSec / 3);
      if (!stamps.length) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      // Count printable characters and Backspace only: arrows/Enter/Shortcuts are not typing
      if (e.repeat || (e.key.length !== 1 && e.key !== "Backspace")) return;
      const target = e.target as Element | null;
      if (!target?.closest?.("#composer")) return;
      stamps.push(performance.now());
      if (timer === undefined) timer = window.setInterval(apply, 150);
      apply();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearInterval(timer);
    };
  }, []);
  // The handles are re-created whenever the session detail page mounts, so the drag
  // wiring re-attaches on that transition (the nodes and their listeners die together).
  useEffect(() => {
    if (showSessionDetail) bindColResizer();
  }, [showSessionDetail]);
  // Snap the traveling-ring svg to the device-pixel grid. The rect stroke straddles the
  // svg viewport edge, so snapped edges put every stroke centerline on a device integer
  // and all four edges rasterize with the same profile; left unsnapped, the top and
  // bottom strokes land on different pixel phases (the dock height is content-driven)
  // and read as different thicknesses on 1x displays. Positions come from
  // getBoundingClientRect, so under #main's narrow-mode zoom they are divided by the
  // zoom factor to convert back to local css px. Re-snaps on every dock resize (typing,
  // attachments, window moves); the ring shifts at most half a device px and paints the
  // same color, so the adjustment is invisible. deps: the dock mounts only when the
  // welcome/new-task pages are gone, so the effect must re-run on that transition (at
  // first mount the ref is still null).
  const dockMounted = !isCreatingNew && !automationsOpen && !hubOpen && !gitManage;
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const ring = ringRef.current;
    if (!dockMounted || !dock || !ring) return;
    const snap = () => {
      const r = dock.getBoundingClientRect();
      const zoom = r.width / dock.offsetWidth || 1;
      const dpr = window.devicePixelRatio;
      const L = Math.round(r.left * dpr) / dpr;
      const T = Math.round(r.top * dpr) / dpr;
      const R = Math.round(r.right * dpr) / dpr;
      const B = Math.round(r.bottom * dpr) / dpr;
      ring.style.left = `${(L - r.left) / zoom}px`;
      ring.style.top = `${(T - r.top) / zoom}px`;
      ring.style.width = `${(R - L) / zoom}px`;
      ring.style.height = `${(B - T) / zoom}px`;
    };
    snap();
    const ro = new ResizeObserver(snap);
    ro.observe(dock);
    window.addEventListener("resize", snap);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", snap);
    };
  }, [dockMounted]);
  // Whole-column file drop (browser build only: with dragDropEnabled the Tauri shell hands
  // file drops to the native handler in main.tsx, which keeps the absolute paths). The input
  // card is no longer the only target, so the overlay marks the acceptance area. Enter/leave
  // arrive nested and paired, hence the depth counter; leave skips the types check because
  // some engines hand dragleave an emptied dataTransfer, which would strand the counter above
  // zero and pin the overlay open.
  const dragDepth = useRef(0);
  const [dropActive, setDropActive] = useState(false);
  return (
      <main
        id="main"
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current++;
          setDropActive(true);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDropActive(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDropActive(false);
          void addIncomingFiles([...e.dataTransfer.files]);
        }}
      >
        <MainHeader onToggleSidebar={toggleSidebar} onToggleRight={toggleRightPanel} />
        <ConnBanner />
        {gitManage ? (
          <GitPage />
        ) : automationsOpen && !isCreatingNew ? (
          <AutomationsPage />
        ) : isCreatingNew ? (
          <Welcome />
        ) : hubOpen ? (
          <AgentHub />
        ) : session && mainViewMode === "tree" ? (
          <MainSessionTree />
        ) : (
          <>
            <ModelFallbackNotice />
            <MessagePage />
          </>
        )}
        {!isCreatingNew && !automationsOpen && !hubOpen && !gitManage && (
          <>
            {/* Goal bar -> queue card -> input dock: three stacked cards from
                top down (the goal bar shifts up as the queue grows). Each card
                pulls up with -mb-28px and the next card presses on its bottom
                edge with z, exposing the upper half as a second-level stack */}
            <SessionNotice />
            <GoalCard />
            <QueueCard />
            <div
              className={(pendingApproval ? "dock approval-active" : "dock") + (accent ? " has-session-accent" : "")}
              ref={dockRef}
              style={
                accent
                  ? ({ "--session-accent": accent, "--bash": bashAccent } as CSSProperties)
                  : undefined
              }
            >
              {pendingApproval ? <ApprovalCard key={pendingApproval.requestId} item={pendingApproval} /> : null}
              <Composer key={activePath || "composer"} inWelcome={false} blocking={Boolean(pendingApproval)} />
              {/* Traveling ring: rendered always, shown by CSS only for a titled session or in
                  bash mode (both are focus states). The rect fills the svg viewport so its
                  stroke straddles the viewport edge; the effect above snaps the viewport to
                  the device-pixel grid. pathLength=100 normalises the dash to percent of
                  perimeter. */}
              <svg className="dock-ring" aria-hidden="true" ref={ringRef}>
                <rect width="100%" height="100%" rx="15.5" pathLength="100" />
              </svg>
            </div>
            {/* Session stats row: outside the dock, on its own row below the
                composer card (not inside the composer) */}
            <SessionStatsBar />
          </>
        )}
        {/* Column width drag handles: gutter strips beside the content column.
            Only the session detail page hosts them, and wiring follows their mount
            (bindColResizer in shell.ts) instead of initShell's one-shot boot. */}
        {showSessionDetail && (
          <>
            <div className="col-resize-h" data-side="left" />
            <div className="col-resize-h" data-side="right" />
          </>
        )}
        {/* Visual acceptance area for the whole-column drop (the drop handler itself
            sits on #main); pointer-events stay off so the drag never leaves #main. */}
        {dropActive && (
          <div className="dz-overlay" aria-hidden="true">
            <div className="dz-frame" />
            <div className="dz-hint">
              <div className="dz-icon">
                <Icon name="upload" size={21} />
              </div>
              <div className="dz-title">{t("composer.dropTitle")}</div>
              <div className="dz-sub">{t("composer.dropSub")}</div>
            </div>
          </div>
        )}
      </main>
  );
}
