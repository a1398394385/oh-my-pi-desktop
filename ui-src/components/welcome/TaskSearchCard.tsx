// 欢迎页会话搜索卡片：位于新建任务卡片下方，支持按会话标题搜索，点击或回车切换到详情页。
import { useState, useMemo, useEffect, useRef } from "react";
import { useAppStore, setBump, send, saveUnseen, hideWelcomeScreen, refreshGitDiff, activateSession } from "../../store";
import Icon from "../../Icon";
import { fmtAgo } from "../sidebar/util";

interface SessionMatch {
  path: string;
  title: string;
  repo: string;
  modified: string;
}

export default function TaskSearchCard() {
  const diskProjects = useAppStore((s) => s.diskProjects);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

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
      .slice(0, 15);
  }, [allSessions, kw]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [matches]);

  // 打开会话详情页：切换到该会话并关闭欢迎屏
  const openSession = (path: string) => {
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
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
        if (target) openSession(target.path);
      }
    } else if (e.key === "Escape") {
      setQuery("");
    }
  };

  return (
    <div className="wb-search-card" id="wbSearchCard">
      <div className="wb-search-input-wrap">
        <span className="wb-search-icon">
          <Icon name="search" size={16} />
        </span>
        <input
          ref={inputRef}
          type="text"
          className="wb-search-input"
          placeholder="搜索会话标题..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {query && (
          <button
            type="button"
            className="wb-search-clear"
            title="清空"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            <Icon name="xmark" size={12} />
          </button>
        )}
      </div>
      {kw && (
        <div className="wb-search-results">
          {matches.length === 0 ? (
            <div className="wb-search-empty">无匹配会话</div>
          ) : (
            matches.map((item, idx) => (
              <div
                key={item.path}
                className={"wb-search-item" + (idx === selectedIndex ? " on" : "")}
                onClick={() => openSession(item.path)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <span className="wb-search-item-tt" title={item.title}>
                  {item.title}
                </span>
                <div className="wb-search-item-meta">
                  {item.repo && (
                    <span className="wb-search-item-repo" title={item.repo}>
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
