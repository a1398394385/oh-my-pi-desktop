// TODO process card + capsule: the streaming task's phases/todo list (statusCard) and its
// collapsed state (capsule).
// Migrated from renderStatusCard in ui/right.js + initRight's card interactions (DOM
// position at #statusWrap).
import { Fragment, useRef } from "react";
import { useAppStore, setBump } from "../../store/index";
import Icon from "../../Icon";
import { t } from "../../i18n";

// Per-session card size, keyed by session path. In-memory only (app lifetime), never
// written to any config file.
const todoSizes = new Map<string, { w: number; h: number }>();
const TODO_MIN_W = 200;
const TODO_MIN_H = 72;
const TODO_MAX_H = 560;

// Task/phase shape of a todo row (passed through by the store's todos frame; constrains
// only the fields this component reads)
interface TodoTask {
  status?: string;
  content: string;
  blocker?: string;
  details?: string;
}
interface TodoPhase {
  name?: string;
  tasks: TodoTask[];
}

// Status icon and text of a todo row (completed → <s> strikethrough; blocked appends the
// blocker reason)
function TodoRow({ t }: { t: TodoTask }) {
  const st = t.status;
  const text = t.content + (st === "blocked" && t.blocker ? `（${t.blocker}）` : "");
  return (
    <div
      className={"todo " + (st === "completed" ? "done" : st === "in_progress" ? "cur" : st === "blocked" ? "blocked" : "")}
      title={t.details || undefined}
    >
      <i className={st === "completed" ? "ck" : st === "in_progress" ? "ar" : "ci"}>
        {st === "completed" ? "✓" : st === "in_progress" ? "→" : st === "blocked" ? "⊘" : "○"}
      </i>
      {st === "completed" ? <s>{text}</s> : <span>{text}</span>}
    </div>
  );
}

export default function TodoCard() {
  const s = useAppStore((st) => (st.activePath ? st.openSessions.get(st.activePath) : undefined));
  const path = useAppStore((st) => st.activePath);
  const todoCollapsed = useAppStore((st) => st.todoCollapsed);
  const cardRef = useRef<HTMLDivElement>(null);
  const phases: TodoPhase[] = s?.todos ?? [];
  const all = phases.flatMap((p) => p.tasks);
  if (!s || all.length === 0) return <div id="statusWrap" />;

  const size = (path && todoSizes.get(path)) || undefined;

  // Drag the corner grip to resize the card for this session only. The list height is
  // applied to #todoList's max-height and the width to the card itself; the size lives
  // in the in-memory todoSizes table (never persisted to a config file).
  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const card = cardRef.current;
    const list = card?.querySelector<HTMLElement>("#todoList");
    if (!card || !list || !path) return;
    const startX = e.clientX;
    const startY = e.clientY;
    // Baseline from the stored size (or the CSS defaults 280×168), not offsetHeight:
    // shorter content would otherwise eat the first stretch of a downward drag
    const startW = size?.w ?? 280;
    const startH = size?.h ?? 168;
    const maxW = window.innerWidth - 100;
    document.body.classList.add("resizing");
    const onMove = (ev: PointerEvent) => {
      // The grip is on the bottom-left and the card is anchored to the right edge of
      // the message area: dragging left widens the card, dragging right narrows it
      const w = Math.min(Math.max(startW - (ev.clientX - startX), TODO_MIN_W), maxW);
      const h = Math.min(Math.max(startH + ev.clientY - startY, TODO_MIN_H), TODO_MAX_H);
      card.style.width = w + "px";
      list.style.maxHeight = h + "px";
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
      todoSizes.set(path, {
        w: Math.min(Math.max(startW - (ev.clientX - startX), TODO_MIN_W), maxW),
        h: Math.min(Math.max(startH + ev.clientY - startY, TODO_MIN_H), TODO_MAX_H),
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };


  const done = all.filter((t) => t.status === "completed").length;
  const frac = `${done}/${all.length}`;
  const current = all.find((t) => t.status === "in_progress") || all.find((t) => t.status !== "completed");
  const capLabel = current ? current.content : t("chat.allDone");
  const capIcon = current
    ? current.status === "in_progress" ? "→" : current.status === "blocked" ? "⊘" : "○"
    : "✓";

  return (
    <div id="statusWrap">
      {!todoCollapsed && (
        <div
          id="statusCard"
          ref={cardRef}
          style={size ? { width: size.w } : undefined}
          onClick={() => {
            // Clicking the card's blank area collapses it into the capsule
            setBump({ todoCollapsed: true });
          }}
        >
          <div className="sc-head">
            <b>{t("chat.sessionStatus")}</b>
            <span className="frac" id="todoFrac">{frac}</span>
            <span className="flex-1"></span>
            <button className="icon-btn" id="scCollapse" title={t("chat.collapseToCapsule")}>
              <Icon name="collapseCard" />
            </button>
          </div>
          <div id="todoList" style={size ? { maxHeight: size.h } : undefined}>
            {phases.map((phase, pi) =>
              phase.tasks.length === 0 ? null : (
                <Fragment key={pi}>
                  {phases.length > 1 && <div className="text-ui-sm text-faint pt-[8px] px-[2px] pb-[2px]">{phase.name}</div>}
                  {phase.tasks.map((t, ti) => <TodoRow t={t} key={ti} />)}
                </Fragment>
              ),
            )}
          </div>
          <span
            className="sc-resize"
            title={t("chat.resizeTodo")}
            onPointerDown={onResizeDown}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
      {todoCollapsed && (
        <button id="capsule" title={capLabel + "  " + frac} onClick={() => setBump({ todoCollapsed: false })}>
          <i className="cap-ic">{capIcon}</i>
          <span className="cap-tx">{capLabel}</span>
          <span className="cap-n">{frac}</span>
        </button>
      )}
    </div>
  );
}
