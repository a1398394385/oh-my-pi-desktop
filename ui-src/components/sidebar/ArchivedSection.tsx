// 归档区（ui/sidebar.js renderArchived/archivedRow 平移）：列表底部折叠分组（默认收起，
// 不持久化），条目可恢复/彻底删除；纯展示承载行（点击不打开会话），hover 高亮只挂行内按钮。
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send } from "../../store";
import Icon from "../../Icon";
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

// 展开容器：mount 时 0fr→1fr；animate 时逐行 kids-in 错峰（对齐项目分组）
function ArchKids({ list, animate, closing, onDelete }: {
  list: SessionInfo[];
  animate: boolean;
  closing: boolean;
  onDelete: (s: SessionInfo) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!; // mount 后即存在（原 JS 直接解引用，保持同一假设）
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
  if (list.length === 0) return null; // 无归档条目整区隐藏
  // 收起动画中再点头部：直接重开（kids 未卸载，closing 类摘掉即过渡回展开）
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
      {/* 整头可点（折叠/展开），hover 高亮合法挂头行 */}
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
