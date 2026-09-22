// 归档区（ui/sidebar.js renderArchived/archivedRow 平移）：列表底部折叠分组（默认收起，
// 不持久化），条目可恢复/彻底删除；纯展示承载行（点击不打开会话），hover 高亮只挂行内按钮。
import { useLayoutEffect, useRef, useState } from "react";
import { S, send } from "../../store.js";
import Icon from "../../Icon.jsx";
import { sessionLabel } from "./util.js";

function ArchRow({ s, onDelete, animate, index }) {
  return (
    <div
      className={"arch-row" + (animate ? " kids-in" : "")}
      style={animate ? { animationDelay: `${index * 25}ms` } : undefined}
    >
      <span className="tt" title={s.cwd || s.path}>{sessionLabel(s)}</span>
      <button
        className="arch-act"
        title="取消归档，恢复到项目列表"
        onClick={() => send({ type: "archive_session", sessionId: s.id, archived: false })}
      >
        恢复
      </button>
      <button className="arch-act arch-del" title="彻底删除会话" onClick={() => onDelete(s)}>删除</button>
    </div>
  );
}

// 展开容器：mount 时 0fr→1fr；animate 时逐行 kids-in 错峰（对齐项目分组）
function ArchKids({ list, animate, closing, onDelete }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
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

export default function ArchivedSection({ onDelete }) {
  const list = S.archivedSessions ?? [];
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
        title={open ? "收起归档区" : "展开归档区"}
        onClick={toggle}
      >
        <span className="caret"><Icon name="caret" size={14} /></span>
        <span className="aname">已归档</span>
        <span className="acount">{`(${list.length})`}</span>
      </div>
      {(expanded || closing) && <ArchKids list={list} animate={open} closing={closing} onDelete={onDelete} />}
    </>
  );
}
