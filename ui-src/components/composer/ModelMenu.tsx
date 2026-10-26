// Merged model menu: one dropdown carries the model picker and the thinking
// level (the old separate ThinkMenu is gone). Level 1 = the active provider's
// switch row (chevron pops the flyout), the provider's model rows (or the
// quick-switch role list after picking "Model Role") and the thinking slider;
// level 2 flyout = "Model Role" entry + provider list + "Manage models" (hidden on
// remote, which has no settings page). Hover close covers the union bounding
// box of both levels (the flyout overlaps the menu border, so leaving one for
// the other never closes); Esc / outside click / window blur close as before.
// With a session picks go through the host; creating-new state lands in
// localStorage.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, pickModelId, pickThinkingLevel, getSupportedThinkingForModel, effZoom } from "../../store";
import type { ModelCaps } from "../../store/models";
import { REMOTE } from "../../store/layout";
import type { TimerHandle } from "../../store";
import Icon from "../../Icon";
import { placeComposerMenu } from "./place";
import type { ModelRoleEntry } from "../../types/frames";

type ModelMenuProps = {
  btnRef: RefObject<HTMLButtonElement | null>;
  composerRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
};

const ROLES_ROW = "@roles"; // flyout entry: swaps level 1 to the role quick list
const MANAGE_ROW = "@manage"; // flyout entry: opens the settings model page
const THINK_ROW = "@think"; // level-1 cursor stop on the thinking slider (←/→ step the level)
const HOVER_INTENT_MS = 180; // pointer cutting down to the model rows must not flash the flyout
const LEAVE_GRACE_MS = 150; // union-leave grace, same as the old flyout close

export default function ModelMenu({ btnRef, composerRef, onClose }: ModelMenuProps) {
  const { t } = useTranslation();
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const newSessionModel = useAppStore((st) => st.newSessionModel);
  const newSessionThinking = useAppStore((st) => st.newSessionThinking);
  const modelNames = useAppStore((st) => st.modelNames);
  const modelRoles = useAppStore((st) => st.modelRoles);
  const modelCatalog = useAppStore((st) => st.modelCatalog);
  const cyclePreview = useAppStore((st) => st.cyclePreview);
  // Capability axes per model id (18.5 models frame; swaps reference with the catalog)
  const modelCaps = useAppStore((st) => st.modelCaps);
  // No-assignment subscription: the tier catalog swaps its Map reference when
  // the models/ready frame arrives (same as the old ThinkMenu)
  useAppStore((st) => st.modelEfforts);
  // Session model may carry the base ":level" suffix — the level now lives in
  // the slider, so all matching/lookups use the stripped id
  const curModel = s?.model || newSessionModel;
  const curBase = curModel?.split(":")[0] ?? null;
  const curThinking = s?.thinking || newSessionThinking;
  const levels = getSupportedThinkingForModel(curBase);
  const menuRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const hideTimer = useRef<TimerHandle | undefined>(undefined);
  const intentTimer = useRef<TimerHandle | undefined>(undefined);
  const [flyOpen, setFlyOpen] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const models = [...modelNames].map(([id, name]) => ({ id, name, provider: id.split("/")[0] }));
  const providers = [...new Set(models.map((m) => m.provider))];
  const [prov, setProv] = useState(() => curBase?.split("/")[0] ?? providers[0] ?? "");
  const provModels = models.filter((m) => m.provider === prov);
  const [hl, setHl] = useState<{ fly: boolean; k: string } | null>(null);

  // Re-place whenever the row list changes height (provider switch / role list):
  // the bottom edge must stay pinned above the trigger, so the menu grows upward
  // instead of spilling down over the pill.
  useLayoutEffect(() => {
    placeComposerMenu(composerRef.current, menuRef.current, btnRef.current);
  }, [prov, showRoles, provModels.length]);
  useEffect(
    () => () => {
      // Unmount cleanup: a pending auto-close timer (keys.ts) must not close a
      // freshly manually reopened menu; drop ctrl+p preview state too
      const st = useAppStore.getState();
      if (st.cyclePreview) useAppStore.setState({ cyclePreview: null });
      if (st.thinkMenuAuto) useAppStore.setState({ thinkMenuAuto: false });
      clearTimeout(hideTimer.current);
      clearTimeout(intentTimer.current);
    },
    [],
  );
  // The vision tag / capability chips read the catalog frame, which only the
  // settings centre requests; without this the composer menu shows none of them
  // until the user happens to open Settings → Model.
  useEffect(() => {
    if (useAppStore.getState().modelCatalog.length === 0) useAppStore.getState().send({ type: "get_models_catalog" });
  }, []);

  // Flyout coordinates: #composer-relative (offsetParent) — top-aligned with
  // the level-1 menu and sitting 3px to its right (side by side; the two panels
  // never stack, and the gap keeps the menu's popover shadow from reading as an
  // overlap). When the right edge overflows it flips to the menu's left, and on
  // screens too narrow to hold both panels it replaces the menu in place
  // (same box) rather than half-covering it. Capped at the window bottom (the
  // app's own lower edge) with internal scrolling.
  // Do not clamp top to 0: a menu sticking out above the composer (negative
  // offsetTop) must keep the flyout top-aligned with it.
  const positionFlyout = () => {
    const fly = flyRef.current;
    const menu = menuRef.current;
    if (!menu) return;
    menu.style.visibility = ""; // reset from a previous replace-in-place
    if (!fly) return;
    const z = effZoom();
    const GAP = 3;
    fly.style.maxHeight = "";
    fly.style.overflowY = "";
    fly.style.width = "";
    fly.style.top = menu.offsetTop + "px";
    fly.style.bottom = "auto";
    fly.style.left = menu.offsetLeft + menu.offsetWidth + GAP + "px";
    if (fly.getBoundingClientRect().right > window.innerWidth - 8) {
      // Screen-space width: offsetWidth ignores zoom, so subtracting it from
      // the screen-space menu rect would misplace the flip by the zoom factor
      const flyW = fly.getBoundingClientRect().width;
      const menuL = menu.getBoundingClientRect().left;
      if (menuL - flyW - GAP >= 8) {
        fly.style.left = menu.offsetLeft - (flyW + GAP) / z + "px";
      } else {
        // Nowhere to sit beside the menu: the flyout replaces it in place, so the
        // level-1 rows must not show through underneath
        fly.style.left = menu.offsetLeft + "px";
        fly.style.width = menu.offsetWidth + "px";
        menu.style.visibility = "hidden";
      }
    }
    const availBelow = Math.round((window.innerHeight - 8 - fly.getBoundingClientRect().top) / z);
    if (fly.offsetHeight > availBelow) {
      fly.style.maxHeight = Math.max(80, availBelow) + "px";
      fly.style.overflowY = "auto";
    }
  };
  useLayoutEffect(positionFlyout, [flyOpen, prov, showRoles, models]);

  // Union hover close: leaving both the menu and the flyout (the 3px gap is
  // crossed well inside the grace timer) starts it; entering either cancels.
  // Remote is touch-only: no hover close there.
  const enterUnion = () => clearTimeout(hideTimer.current);
  const leaveUnion = (e: ReactMouseEvent) => {
    const n = e.relatedTarget as Node | null;
    if (REMOTE || (n && ((menuRef.current?.contains(n) ?? false) || (flyRef.current?.contains(n) ?? false)))) return;
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(onClose, LEAVE_GRACE_MS);
  };

  // Custom roles with a resolvable model (the flyout entry is hidden entirely
  // when none qualify)
  const customRoles = (modelRoles ?? []).filter(
    (r): r is ModelRoleEntry & { resolved: string } => !r.builtin && !!r.resolved,
  );
  const flyKeys = [
    ...(customRoles.length > 0 ? [ROLES_ROW] : []),
    ...providers,
    ...(REMOTE ? [] : [MANAGE_ROW]),
  ];
  const rowKeys = showRoles ? customRoles.map((r) => r.id) : provModels.map((m) => m.id);
  const level1Keys = [prov, ...rowKeys, THINK_ROW];
  // Keyboard cursor, revalidated against the current level's key list: a stale
  // flyout cursor (e.g. MANAGE_ROW after the flyout closed) drops to null, but
  // a level-1 cursor survives a mouse-opened flyout
  const hlK = hl !== null && (flyOpen ? flyKeys : level1Keys).includes(hl.k) ? hl.k : null;

  const openFly = () => {
    clearTimeout(hideTimer.current);
    clearTimeout(intentTimer.current);
    setFlyOpen(true);
  };
  const closeFly = () => {
    clearTimeout(hideTimer.current);
    clearTimeout(intentTimer.current);
    setFlyOpen(false);
  };

  // Keyboard: ↑/↓ move the cursor within the current level (wrap at the ends),
  // → opens the flyout from the switch row, ← returns to level 1, Enter picks the
  // row in place (menu stays open — Esc dismisses), Esc closes the menu. The
  // listener lives on window's capture phase for the whole mount lifetime: focus
  // stays in the composer editor while the menu is open, so swallow the keys
  // there — before Lexical's caret / send handlers and the global bindings see
  // them. Any other window-capture listener must yield while a composer popup is
  // open (SessionTreeStream's arrow navigation does).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      // A sigil-completion panel riding the same editor (palette / bash card)
      // owns the keys while open — yield, same rule as ComposerPlugin's
      // typeaheadOpenRef
      if (document.querySelector(".menu.palette.open")) return;
      const key = e.key;
      if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Enter" && key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (key === "Escape") {
        onClose();
        return;
      }
      const inFly = hlK !== null && flyOpen && flyKeys.includes(hlK);
      const keys = inFly ? flyKeys : level1Keys;
      const at = hlK === null ? -1 : keys.indexOf(hlK);
      switch (key) {
        case "ArrowUp":
        case "ArrowDown": {
          const d = key === "ArrowDown" ? 1 : -1;
          if (keys.length > 0) {
            const next = at < 0 ? keys[d < 0 ? keys.length - 1 : 0] : keys[(at + d + keys.length) % keys.length];
            setHl({ fly: inFly, k: next });
          }
          break;
        }
        case "ArrowRight":
          if (!inFly && hlK === THINK_ROW) {
            stepThink(1);
            break;
          }
          if (!flyOpen && hlK === prov) {
            setFlyOpen(true);
            setHl({ fly: true, k: flyKeys[0] });
          }
          break;
        case "ArrowLeft":
          if (!inFly && hlK === THINK_ROW) {
            stepThink(-1);
            break;
          }
          if (inFly) {
            setFlyOpen(false);
            setHl({ fly: false, k: prov });
          }
          break;
        case "Enter":
          // Enter confirms in place: the menu stays open (Esc dismisses), so the
          // arrows remain usable for comparing models
          if (hlK === THINK_ROW && !inFly) break; // the slider has no confirm step
          if (inFly) enterFlyRow(hlK);
          else if (hlK !== null) (hlK === prov ? (flyOpen ? closeFly : openFly) : enterRow(hlK));
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyOpen, hlK, prov, showRoles, models, modelRoles, curBase, curThinking, levels]);

  // Keep the cursor row inside its own scrollport (block:"nearest" never jumps
  // ancestor scrollers — same as the palette menus)
  useLayoutEffect(() => {
    if (hlK === null) return;
    rowEls.current.get(hlK)?.scrollIntoView({ block: "nearest" });
  }, [hlK]);

  // ←/→ on the slider row step one tier (clamped, no wrap: the ends are real levels)
  const stepThink = (d: number) => {
    const i = levels.indexOf(curThinking);
    const next = levels[Math.min(levels.length - 1, Math.max(0, i + d))];
    if (next && next !== curThinking) pickThinkingLevel(next);
  };

  // Picking never closes the menu (mouse and keyboard alike): the only exits
  // are pointer-leave and Esc, so the same panel stays usable for comparing
  // providers and roles
  const enterRow = (k: string) => {
    const role = customRoles.find((r) => r.id === k);
    if (showRoles && role) pickModelId(role.resolved, role.id);
    else if (!showRoles) {
      const model = provModels.find((m) => m.id === k);
      if (model) pickModelId(model.id);
    }
  };
  const enterFlyRow = (k: string) => {
    if (k === ROLES_ROW) {
      setShowRoles(true);
      closeFly();
    } else if (k === MANAGE_ROW) {
      useAppStore.getState().openSettings("pg-model"); // no-ops on remote (the row is not rendered there anyway)
      onClose();
    } else if (providers.includes(k)) {
      setProv(k);
      setShowRoles(false);
      closeFly();
    }
  };

  // Thinking slider: discrete snapping — the pointer position maps to the
  // nearest tier, both on press and while dragging (pointer capture keeps the
  // moves flowing on the track)
  const jump = (clientX: number) => {
    const el = trackRef.current;
    if (!el || levels.length < 2) return;
    const r = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const lv = levels[Math.round(ratio * (levels.length - 1))];
    if (lv && lv !== curThinking) pickThinkingLevel(lv);
  };
  const thLv = (lv: string) => t(`composer.thinkingLevels.${lv}`, { defaultValue: lv });
  const curIdx = Math.max(0, levels.indexOf(curThinking));
  const pct = levels.length > 1 ? (curIdx / (levels.length - 1)) * 100 : 100;
  // The knob is a ball as tall as the track riding inside the capsule: it must
  // stay fully visible at both ends, so its center (and every tier dot, end
  // dots included) travels within [r, 100-r] percent of the track width
  const [trackW, setTrackW] = useState(0);
  useLayoutEffect(() => {
    setTrackW(trackRef.current?.clientWidth ?? 0); // menu width is fixed while open, one measure is enough
  }, []);
  const rPct = trackW > 0 ? (10 / trackW) * 100 : 0; // knob radius = 10px (track height 20px / 2)
  const clampP = (p: number) => Math.min(100 - rPct, Math.max(rPct, p));
  const knobPct = clampP(pct);
  const dotPos = levels.length > 1 ? levels.map((_, i) => clampP((i / (levels.length - 1)) * 100)) : [];

  // ctrl+p preview mode: a transient flat list of exactly the cyclable roles
  // (cycleOrder resolution), the just-switched-to slot highlighted; rows stay
  // pickable. Auto-collapses from keys.ts (0.8s pause / Ctrl release)
  if (cyclePreview) {
    return (
      <div className="menu model open" id="modelMenu" ref={menuRef}>
        {cyclePreview.entries.map((en) => {
          const active = en.role === cyclePreview.activeRole && en.model === cyclePreview.activeModel;
          return (
            <div
              className={"mi" + (active ? " on" : "")}
              key={en.role}
              onClick={() => {
                pickModelId(en.model, en.role);
                onClose();
              }}
            >
              <span className="ck">{active ? "✓" : ""}</span>
              <span className="mi-name">
                {en.role} : {modelNames.get(en.model) ?? (modelRoles ?? []).find((r) => r.resolved === en.model)?.resolvedName ?? en.model}
              </span>
              <CapBadges caps={modelCaps.get(en.model)} />
            </div>
          );
        })}
      </div>
    );
  }

  const setRowEl = (k: string) => (el: HTMLDivElement | null) => {
    if (el) rowEls.current.set(k, el);
    else rowEls.current.delete(k);
  };
  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    jump(e.clientX);
  };
  const onTrackMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons & 1) jump(e.clientX);
  };

  return (
    <>
      <div className={"menu model open"} id="modelMenu" ref={menuRef}
        onMouseEnter={enterUnion} onMouseLeave={leaveUnion}>
        {/* Provider switch row: hover opens the flyout (intent delay), click toggles */}
        <div className={"mi prov" + (flyOpen || hlK === prov ? " on" : "") + (hlK === prov ? " kb" : "")} ref={setRowEl(prov)}
          onMouseEnter={() => {
            enterUnion();
            if (flyOpen) return;
            clearTimeout(intentTimer.current);
            intentTimer.current = setTimeout(() => setFlyOpen(true), HOVER_INTENT_MS);
          }}
          onMouseLeave={() => clearTimeout(intentTimer.current)}
          onClick={(e) => {
            e.stopPropagation();
            if (flyOpen) closeFly();
            else openFly();
          }}>
          {prov}<span className="sub"><Icon name="chevronRight" size={10} /></span>
        </div>
        <div className="sep" />
        {models.length === 0 && customRoles.length === 0 && (
          <div className="mi empty" style={{ color: "var(--dim)", cursor: "default", justifyContent: "center", padding: "8px 12px" }}>
            {t("composer.noModels")}
          </div>
        )}
        {showRoles
          ? customRoles.map((role) => (
              <div className={"mi" + (hlK === role.id || curBase === role.resolved ? " on" : "") + (hlK === role.id ? " kb" : "")} data-role={role.id} key={role.id}
                ref={setRowEl(role.id)}
                onClick={(e) => { e.stopPropagation(); enterRow(role.id); }}>
                <span className="ck">{curBase === role.resolved ? "✓" : ""}</span>
                <span className="mi-name">{role.name} : {role.resolvedName ?? role.resolved}</span>
              </div>
            ))
          : provModels.map((model) => (
              <div className={"mi" + (hlK === model.id || curBase === model.id ? " on" : "") + (hlK === model.id ? " kb" : "")} data-model={model.id} key={model.id}
                ref={setRowEl(model.id)}
                onClick={(e) => { e.stopPropagation(); enterRow(model.id); }}>
                <span className="ck">{curBase === model.id ? "✓" : ""}</span>
                <span className="mi-name">{model.name}</span>
                {modelCatalog.find((m) => m.id === model.id)?.vision ? <span className="cap-b">{t("composer.visionTag")}</span> : null}
                <CapBadges caps={modelCaps.get(model.id)} />
              </div>
            ))}
        <div className="sep" />
        {/* Thinking slider: discrete tiers of the current model. The capsule
            holds a fixed full-width brand gradient (same hues as the app
            icon), revealed progressively by clipping it at the knob center;
            the ball-shaped knob (track height) rides inside the groove, its
            center snapping onto the tier dots (end dots included). Clicking or
            dragging jumps to the nearest tier. */}
        <div className={"think-sec" + (hlK === THINK_ROW ? " on" : "")} ref={setRowEl(THINK_ROW)} onClick={(e) => e.stopPropagation()}>
          <div className="think-sec-h">
            <span className="think-ht">{t("composer.reasoning")}<span className="think-cur">{thLv(levels[curIdx] ?? "off")}</span></span>
            <span className="think-keys"><kbd>⇧ Tab</kbd></span>
          </div>
          <div className="think-track" ref={trackRef}
            onPointerDown={onTrackDown}
            onPointerMove={onTrackMove}>
            <div className="think-grad" style={{ clipPath: `inset(0 ${100 - knobPct}% 0 0)` }} />
            {dotPos.map((p) => (
              <span className="think-dot" key={p} style={{ left: p + "%" }} />
            ))}
            <div className="think-knob" style={{ left: knobPct + "%" }} />
          </div>
        </div>
      </div>
      {flyOpen && (
        <div className="menu flyout open" ref={flyRef}
          onMouseEnter={enterUnion} onMouseLeave={leaveUnion}>
          {customRoles.length > 0 && (
            <>
              <div className={"mi" + (hlK === ROLES_ROW ? " on" : "") + (hlK === ROLES_ROW ? " kb" : "")} ref={setRowEl(ROLES_ROW)}
                onClick={(e) => { e.stopPropagation(); setShowRoles(true); closeFly(); }}>
                {t("composer.modelRoleCategory")}
                <span className="sub"><Icon name="chevronRight" size={10} /></span>
              </div>
              <div className="sep" />
            </>
          )}
          {providers.map((p) => (
            <div className={"mi" + (hlK === p || (p === prov && hlK === null) ? " on" : "") + (hlK === p ? " kb" : "")} key={p} ref={setRowEl(p)}
              onClick={(e) => { e.stopPropagation(); setProv(p); setShowRoles(false); closeFly(); }}>
              <span className="ck">{p === prov ? "✓" : ""}</span>
              {p}
            </div>
          ))}
          {!REMOTE && (
            <>
              <div className="sep" />
              <div className={"mi mgmt" + (hlK === MANAGE_ROW ? " on kb" : "")} ref={setRowEl(MANAGE_ROW)}
                onClick={(e) => { e.stopPropagation(); enterFlyRow(MANAGE_ROW); }}>
                {t("composer.manageModels")}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// Capability badges at model-row tails (18.5 models frame axes): small text
// chips for prompt-cache keepalive / built-in web search / image generation;
// rendered only for axes the host actually reports
function CapBadges({ caps }: { caps: ModelCaps | undefined }) {
  const { t } = useTranslation();
  if (!caps) return null;
  const badges: string[] = [];
  if ((caps.promptCache ?? 0) > 0) badges.push(t("compExt.capCache"));
  if (caps.webSearch) badges.push(t("compExt.capWeb"));
  if (caps.imageGen) badges.push(t("compExt.capImg"));
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((label) => (
        <span className="cap-b" key={label}>{label}</span>
      ))}
    </>
  );
}
