// TODO process card + capsule: the streaming task's phases/todo list (statusCard) and its
// collapsed state (capsule).
// Migrated from renderStatusCard in ui/right.js + initRight's card interactions (DOM
// position at #statusWrap).
import { Fragment } from "react";
import { useAppStore, setBump } from "../../store/index";
import Icon from "../../Icon";
import { t } from "../../i18n";

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
  const todoCollapsed = useAppStore((st) => st.todoCollapsed);
  const phases: TodoPhase[] = s?.todos ?? [];
  const all = phases.flatMap((p) => p.tasks);
  if (!s || all.length === 0) return <div id="statusWrap" />;

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
          <div id="todoList">
            {phases.map((phase, pi) =>
              phase.tasks.length === 0 ? null : (
                <Fragment key={pi}>
                  {phases.length > 1 && <div className="text-ui-sm text-faint pt-[8px] px-[2px] pb-[2px]">{phase.name}</div>}
                  {phase.tasks.map((t, ti) => <TodoRow t={t} key={ti} />)}
                </Fragment>
              ),
            )}
          </div>
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
