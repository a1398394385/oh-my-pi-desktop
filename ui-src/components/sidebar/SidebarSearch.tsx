// 侧边栏会话搜索卡片：位于新建任务下方，卡片样式对齐新建任务，支持按会话标题搜索，点击或回车切换到对应会话详情页。
import { useState, useMemo, useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useAppStore, setBump, send, saveUnseen, hideWelcomeScreen, refreshGitDiff, activateSession } from "../../store";
import Icon from "../../Icon";
import { fmtAgo } from "./util";

interface SessionMatch {
  path: string;
  title: string;
  repo: string;
  modified: string;
}

export default function SidebarSearch() {
  const diskProjects = useAppStore((s) => s.diskProjects);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 汇总所有磁盘会话（仅支持搜索有会话标题的内容）
  const allSessions = useMemo(() => {
    const list: SessionMatch[] = [];
    const seenPaths = new Set<string>();
    for (const p of diskProjects) {
      const repo = p.cwd.split("/").filter(Boolean).pop() || "";
      for (const s of p.sessions) {
        if (s.title && !seenPaths.has(s.path)) {
          seenPaths.add(s.path);
          list.push({
            path: s.path,
            title: s.title,
            repo,
            modified: s.modified,
          });
        }
      }
    }
    return list;
  }, [diskProjects]);

  const kw = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!kw) return [];
    return allSessions
      .filter((s) => s.title.toLowerCase().includes(kw))
      .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
      .slice(0, 20);
  }, [allSessions, kw]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [matches]);

  // 点击外部收起搜索结果浮层
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: globalThis.MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onClickOutside);
    return () => window.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  // 打开会话详情页：切换到该会话并关闭欢迎屏
  const handleOpenSession = (path: string) => {
    useAppStore.setState({ isCreatingNew: false });
    hideWelcomeScreen();
    useAppStore.setState((st) => ({
      unseenFinished: new Set([...st.unseenFinished].filter((p) => p !== path)),
    }));
    saveUnseen();
    if (useAppStore.getState().openSessions.has(path)) {
      activateSession(path);
      refreshGitDiff();
    } else {
      send({ type: "reload_settings" });
      send({ type: "load_session", path });
    }
    setBump({ selectedSubagent: null, selectedFile: null });
    setQuery("");
    setOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      if (matches.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % matches.length);
      }
    } else if (e.key === "ArrowUp") {
      if (matches.length > 0) {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + matches.length) % matches.length);
      }
    } else if (e.key === "Enter") {
      if (matches.length > 0) {
        e.preventDefault();
        const target = matches[selectedIndex >= 0 && selectedIndex < matches.length ? selectedIndex : 0];
        if (target) handleOpenSession(target.path);
      }
    } else if (e.key === "Escape") {
      setQuery("");
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div
      ref={rootRef}
      className={"nav-item nav-search relative" + (open && kw ? " search-active" : "")}
      onClick={() => inputRef.current?.focus()}
    >
      <span className="nav-search-icon">
        <Icon name="search" size={17} />
      </span>
      <input
        ref={inputRef}
        type="text"
        className="nav-search-input"
        placeholder="搜索会话..."
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
      />
      {query ? (
        <button
          type="button"
          className="nav-search-clear"
          title="清空"
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            setQuery("");
            setOpen(false);
            inputRef.current?.focus();
          }}
        >
          <Icon name="xmark" size={12} />
        </button>
      ) : null}

      {/* 搜索结果浮层 */}
      {open && kw && (
        <div className="side-search-pop" onClick={(e) => e.stopPropagation()}>
          {matches.length === 0 ? (
            <div className="side-search-empty">无匹配会话</div>
          ) : (
            matches.map((item, idx) => (
              <div
                key={item.path}
                className={"side-search-item" + (idx === selectedIndex ? " on" : "")}
                onClick={() => handleOpenSession(item.path)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div className="side-search-item-tt" title={item.title}>
                  {item.title}
                </div>
                <div className="side-search-item-meta">
                  {item.repo && (
                    <span className="side-search-item-repo" title={item.repo}>
                      {item.repo}
                    </span>
                  )}
                  <span>{fmtAgo(item.modified)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
