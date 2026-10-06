// Archive section (ported from ui/sidebar.js renderArchived/archivedRow): collapsible group at
// the list bottom (collapsed by default, not persisted); entries can be restored or hard
// deleted; display-only carrier rows (clicking doesn't open the session), hover highlight only
// on inline buttons.
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../../store";
import Icon from "../../../Icon";
import { sessionLabel } from "./util";
import type { SessionInfo } from "./SessionRow";

function ArchRow({ s, onDelete, animate, index }: {
  s: SessionInfo;
  onDelete: (s: SessionInfo) => void;
  animate: boolean;
  index: number;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={"arch-row" + (animate ? " kids-in" : "")}
      style={animate ? { animationDelay: `${index * 25}ms` } : undefined}
    >
      <span className="tt" title={s.cwd || s.path}>{sessionLabel(s)}</span>
      <button
        className="arch-act"
        title={t("sidebar.unarchiveRestore")}
        onClick={() => send({ type: "archive_session", sessionId: s.id, archived: false })}
      >
        {t("sidebar.restore")}
      </button>
      <button className="arch-act arch-del" title={t("sidebar.deleteForever")} onClick={() => onDelete(s)}>{t("common.delete")}</button>
    </div>
  );
}

// Expanded container: 0fr→1fr on mount; staggered kids-in rows when animate (aligned with project groups)
function ArchKids({ list, animate, closing, onDelete }: {
  list: SessionInfo[];
  animate: boolean;
  closing: boolean;
  onDelete: (s: SessionInfo) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!; // exists right after mount (the old JS dereferenced directly; same assumption kept)
    el.style.gridTemplateRows = "0fr";
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.gridTemplateRows = ""; }));
  }, []);
  return (
    <div className={"arch-kids" + (closing ? " closing" : "")} ref={ref}>
      <div className="arch-kids-in">
        {list.map((s, i) => (
          <ArchRow
            key={s.path}
            s={s}
            onDelete={onDelete}
            animate={animate}
            index={i}
          />
        ))}
      </div>
    </div>
  );
}

export default function ArchivedSection({ onDelete }: { onDelete: (s: SessionInfo) => void }) {
  const { t } = useTranslation();
  const list = useAppStore((s) => s.archivedSessions) ?? [];
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  if (list.length === 0) return null; // hide the whole section when there are no archived entries
  // Clicking the head mid-collapse animation: reopen directly (kids not yet unmounted; removing the closing class transitions back to expanded)
  const toggle = () => {
    if (!expanded) setExpanded(true);
    else if (closing) setClosing(false);
    else {
      setClosing(true);
      setTimeout(() => {
        setExpanded(false);
        setClosing(false);
      }, 310);
    }
  };
  const open = expanded && !closing;
  return (
    <>
      {/* Whole head is clickable (collapse/expand); hover highlight legitimately on the head row */}
      <div
        className={"arch-head" + (open ? "" : " collapsed")}
        title={open ? t("sidebar.collapseArchive") : t("sidebar.expandArchive")}
        onClick={toggle}
      >
        <span className="caret"><Icon name="caret" size={14} /></span>
        <span className="flex-1 min-w-0 truncate">{t("sidebar.archivedLabel")}</span>
        <span className="flex-none text-ui-sm text-faint">{`(${list.length})`}</span>
      </div>
      {(expanded || closing) && <ArchKids list={list} animate={open} closing={closing} onDelete={onDelete} />}
    </>
  );
}
