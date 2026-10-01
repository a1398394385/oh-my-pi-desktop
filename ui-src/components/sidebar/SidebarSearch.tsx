// 侧边栏会话搜索卡片：位于新建任务下方，卡片样式对齐新建任务，支持按会话标题搜索，点击或回车切换到对应会话详情页。
import { useState, useMemo, useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, send, saveUnseen, hideWelcomeScreen, refreshGitDiff, activateSession, pathBase } from "../../store";
import type { DiskSessionRow } from "../../types/frames";
import Icon from "../../Icon";
import { fmtAgo, sessionLabel } from "./util";

interface SessionMatch {
  path: string;
  title: string;
  repo: string;
  cwd: string;
  modified: string;
  searchText: string;
  archived?: boolean;
}

export default function SidebarSearch() {
  const { t } = useTranslation();
  const diskProjects = useAppStore((s) => s.diskProjects);
  const archivedSessions = useAppStore((s) => s.archivedSessions);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isKeyboardNavRef = useRef(false);

  // 汇总所有磁盘会话（未重命名/未打标会话以 firstMessage 兜底标签呈现，对齐侧栏 SessionRow）
  const allSessions = useMemo(() => {
    const list: SessionMatch[] = [];
    const seenPaths = new Set<string>();

    const pushSession = (s: DiskSessionRow, cwd: string, archived = false) => {
      if (seenPaths.has(s.path)) return;
      const displayTitle = sessionLabel(s);
      if (!displayTitle || displayTitle === t("sidebar.emptySession")) return;
      seenPaths.add(s.path);
      const repo = pathBase(cwd);
      list.push({
        path: s.path,
        title: displayTitle,
        searchText: `${s.title || ""} ${s.firstMessage || ""} ${repo}`.toLowerCase(),
        repo,
        cwd,
        modified: s.modified,
        archived,
      });
    };

    for (const p of diskProjects) {
      for (const s of p.sessions) {
        pushSession(s, p.cwd, false);
      }
    }
    for (const s of archivedSessions) {
      pushSession(s, s.cwd, true);
    }
    return list;
  }, [diskProjects, archivedSessions]);

  const kw = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!kw) return [];
    return allSessions
      .filter((s) => s.searchText.includes(kw) || s.title.toLowerCase().includes(kw))
      .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
      .slice(0, 20);
  }, [allSessions, kw]);

  useEffect(() => {
    setSelectedIndex(0);
    listRef.current?.scrollTo({ top: 0 });
  }, [matches]);

  // 键盘上下导航时自动将高亮项滚动至可视区域
  useEffect(() => {
    if (!open || !isKeyboardNavRef.current) return;
    const activeEl = listRef.current?.querySelector<HTMLElement>(".side-search-item.on");
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, open]);

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

  // 打开会话详情页：切换到该会话、展开对应项目并关闭欢迎屏
  const handleOpenSession = (path: string, cwd?: string) => {
    useAppStore.setState({ isCreatingNew: false });
    hideWelcomeScreen();
    useAppStore.setState((st) => ({
      unseenFinished: new Set([...st.unseenFinished].filter((p) => p !== path)),
    }));
    saveUnseen();
    if (cwd) useAppStore.getState().expandProject(cwd);
    if (useAppStore.getState().openSessions.has(path)) {
      activateSession(path);
      refreshGitDiff();
    } else {
      send({ type: "reload_settings" });
      send({ type: "load_session", path });
    }
    // selectedFile/selectedSubagent cleanup is owned by restoreRightPanel (already-open branch)
    // and the session_created frame (host-load branch) — resetting here would clobber the
    // just-restored per-session right panel state
    setQuery("");
    setOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      isKeyboardNavRef.current = true;
      return;
    }
    if (e.key === "ArrowDown") {
      if (matches.length > 0) {
        e.preventDefault();
        isKeyboardNavRef.current = true;
        setSelectedIndex((prev) => (prev + 1) % matches.length);
      }
    } else if (e.key === "ArrowUp") {
      if (matches.length > 0) {
        e.preventDefault();
        isKeyboardNavRef.current = true;
        setSelectedIndex((prev) => (prev - 1 + matches.length) % matches.length);
      }
    } else if (e.key === "Enter") {
      if (matches.length > 0) {
        e.preventDefault();
        const target = matches[selectedIndex >= 0 && selectedIndex < matches.length ? selectedIndex : 0];
        if (target) handleOpenSession(target.path, target.cwd);
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
        placeholder={t("sidebar.searchPlaceholder")}
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
          title={t("sidebar.clear")}
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
        <div ref={listRef} className="side-search-pop" onClick={(e) => e.stopPropagation()}>
          {matches.length === 0 ? (
            <div className="side-search-empty">{t("sidebar.noMatch")}</div>
          ) : (
            matches.map((item, idx) => (
              <div
                key={item.path}
                className={"side-search-item" + (idx === selectedIndex ? " on" : "")}
                onClick={() => handleOpenSession(item.path, item.cwd)}
                onMouseEnter={() => {
                  isKeyboardNavRef.current = false;
                  setSelectedIndex(idx);
                }}
              >
                <div className="side-search-item-tt" title={item.title}>
                  {item.title}
                </div>
                <div className="side-search-item-meta">
                  {item.archived && <span className="side-search-item-repo text-faint">{t("sidebar.archivedLabel")}</span>}
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
