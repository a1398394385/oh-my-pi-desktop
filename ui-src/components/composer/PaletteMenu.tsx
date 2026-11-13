// Composer sigil completion card. Slash commands add a category strip and
// keyboard footer; @ file and $ skill completion reuse that card with the strip
// pinned to a single tab; subcommand completion keeps the plain list.
import { useLayoutEffect, useRef, useState, useEffect } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { placePaletteCard } from "./place";
import { COMMAND_CATEGORIES } from "./completionFilters";
import type { CommandCategory } from "./completionFilters";
import { pathBase, useAppStore } from "../../store";
import { fmtAgo } from "../main/sidebar/util";
import Icon from "../../Icon";
import { fileTypeIcon } from "../../../ui/icons";

// Built-in command descriptions (zh-CN dictionary): loaded on first palette
// render so the module stays out of the startup closure; rows fall back to the
// command's own English description for the one frame before it lands.
let builtinDescZh: Record<string, string> | null = null;
let builtinDescLoad: Promise<Record<string, string>> | null = null;
const NO_DESC: Record<string, string> = {};
/** Strip tab names: slash categories plus the @ card's file/session pair */
export type PaletteTabName = CommandCategory | "file" | "skill" | "session";
const CATEGORY_LABELS: Record<PaletteTabName, string> = {
  recent: "composer.paletteRecent",
  mode: "composer.paletteModes",
  skill: "composer.paletteSkills",
  plugin: "composer.palettePlugins",
  command: "composer.paletteCommands",
  file: "composer.paletteFiles",
  session: "composer.paletteSessions",
};

/** @ file candidate (an element of mentionResult.matches) */
export type FileItem = { path: string; dir: boolean; empty?: boolean };
/** Slash command candidate (structural subset of the commands list element) */
export type CommandItem = { name: string; aliases?: string[]; description?: string; hint?: string | null; source?: string };
/** Session candidate (@ session tab; a SessionMatch from shared/session-search) */
export type SessionItem = { path: string; title: string; repo: string; modified: string; archived?: boolean; snippet?: string };
export type PaletteItem = FileItem | CommandItem | SessionItem;

type PaletteMenuProps = {
  mode: "file" | "session" | "command" | "commandArgs" | "skill";
  items: PaletteItem[];
  index: number;
  loading: boolean;
  composerRef: RefObject<HTMLDivElement | null>;
  /** Strip tabs; a single entry renders as a pinned (non-switchable) tab */
  tabs: readonly PaletteTabName[];
  tab: PaletteTabName;
  query: string;
  onTabChange: (tab: PaletteTabName) => void;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
};

export default function PaletteMenu({ mode, items, index, loading, composerRef, tabs, tab, query, onTabChange, onPick, onHover }: PaletteMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const [builtinDesc, setBuiltinDesc] = useState<Record<string, string>>(builtinDescZh ?? NO_DESC);
  // Slash, @ file/session and $ skill completion share the slash card (tabs +
  // fixed footer): its height is fixed, so they take the slash placement branch
  // rather than the content-sized palette one.
  const slashMode = mode === "command" || mode === "skill" || mode === "file" || mode === "session";
  const commandMode = mode === "command";
  const singleTab = tabs.length === 1;

  useLayoutEffect(() => {
    const composer = composerRef.current;
    const menu = menuRef.current;
    const place = () => {
      placePaletteCard(composer, menu, slashMode ? Number.POSITIVE_INFINITY : 2.6);
      if (slashMode && menu) menu.style.overflowY = "hidden";
    };
    place();
    if (!slashMode || !composer) return;
    const observer = new ResizeObserver(place);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [composerRef, items.length, loading, mode, slashMode]);

  useLayoutEffect(() => {
    menuRef.current?.querySelector(".mi.on")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  // The editor retains focus. Left/right switches tabs only for the empty-query
  // browser; with a query they remain ordinary caret movement.
  useEffect(() => {
    if (singleTab || query) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      const offset = event.key === "ArrowLeft" ? -1 : 1;
      const current = tabs.indexOf(tab);
      onTabChange(tabs[(current + offset + tabs.length) % tabs.length]);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onTabChange, query, singleTab, tab, tabs]);

  useEffect(() => {
    if (lang !== "zh-CN" || builtinDescZh) return;
    builtinDescLoad ??= import("../../i18n/locales/commands-zh-CN").then((m) => {
      builtinDescZh = m.BUILTIN_DESC_ZH;
      return builtinDescZh;
    });
    let alive = true;
    void builtinDescLoad.then((dict) => {
      if (alive) setBuiltinDesc(dict);
    });
    return () => {
      alive = false;
    };
  }, [lang]);

  return (
    <div className={"menu palette open" + (slashMode ? " slash" : "")} ref={menuRef}>
      {slashMode ? (
        <div className="slash-tabs" role="tablist" aria-label={t("composer.paletteCategories")}>
          {tabs.map((name) => (
            <button
              type="button"
              role="tab"
              tabIndex={-1}
              className="slash-tab"
              id={`slash-tab-${name}`}
              aria-selected={commandMode ? !query && tab === name : tab === name}
              aria-controls="slash-command-results"
              key={name}
              disabled={singleTab}
              onMouseDown={(event) => event.preventDefault()}
              onClick={singleTab ? undefined : () => onTabChange(name)}
            >
              {t(CATEGORY_LABELS[name])}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className={slashMode ? "slash-list" : "palette-list"}
        id={slashMode ? "slash-command-results" : undefined}
        role={slashMode ? "listbox" : undefined}
        aria-labelledby={slashMode ? `slash-tab-${tab}` : undefined}
      >
        {loading ? (
          <div className="mi empty">{t("common.loading")}</div>
        ) : !items.length ? (
          <div className="mi empty">{t("composer.noMatch")}</div>
        ) : (
          items.map((it, i) => {
            let label: string;
            let key: string;
            let desc = "";
            let hint: string | null = null;
            let iconName: string;
            if (mode === "file") {
              if (!("dir" in it)) return null;
              const tail = pathBase(it.path) || it.path;
              label = it.dir ? tail + "/" : tail;
              key = it.path;
              // Sub line = parent dir: the full path would repeat the label now
              // that the row renders label + sub side by side
              const cut = it.path.lastIndexOf("/");
              desc = cut > 0 ? it.path.slice(0, cut) : "";
              iconName = it.dir ? "folder" : fileTypeIcon(it.path);
            } else if (mode === "session") {
              if (!("title" in it)) return null;
              label = it.title;
              key = it.path;
              // Content-hit snippet wins; a title-only hit falls back to the project name
              desc = [it.archived ? t("sidebar.archivedLabel") : "", it.snippet || it.repo].filter(Boolean).join(" · ");
              hint = fmtAgo(it.modified);
              iconName = "comment";
            } else if (mode === "commandArgs") {
              if (!("name" in it)) return null;
              label = it.name;
              key = it.name;
              desc = it.description || "";
              hint = it.hint || null;
              iconName = "command";
            } else {
              if (!("name" in it)) return null;
              // skill entries share the row shape; only the label drops the
              // host's "skill:" prefix for the $ form
              label = mode === "skill" ? "$" + it.name.replace(/^skill:/, "") : it.name + (it.aliases?.length ? " /" + it.aliases[0] : "");
              key = it.name;
              desc = (it.source === "builtin" && lang === "zh-CN" ? builtinDesc[it.name] : null) || it.description || "";
              hint = it.hint || null;
              iconName = mode === "skill" ? "zap" : it.name === "plan" ? "plan" : "command";
            }
            const secondary = [hint, desc].filter(Boolean).join(" · ");
            return (
              <div
                className={"mi" + (i === index ? " on" : "")}
                key={key}
                role={slashMode ? "option" : undefined}
                aria-selected={slashMode ? i === index : undefined}
                title={secondary ? `${label} — ${secondary}` : label}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(i)}
              >
                {slashMode ? (
                  <span className="slash-ic">
                    <Icon name={iconName} size={15} />
                  </span>
                ) : null}
                <span className="mi-tx">{label}</span>
                {secondary ? <span className="sub">{secondary}</span> : null}
              </div>
            );
          })
        )}
      </div>
      {slashMode ? (
        <div className="slash-footer">
          <span className="slash-hint"><kbd>↑↓</kbd>{t("composer.paletteSelect")}</span>
          {commandMode ? <span className="slash-hint"><kbd>←→</kbd>{t("composer.paletteSwitchCategory")}</span> : null}
          <span className="slash-hint"><kbd>Enter / Tab</kbd>{t("composer.paletteAdd")}</span>
          <span className="slash-hint slash-close"><kbd>Esc</kbd>{t("common.close")}</span>
        </div>
      ) : null}
    </div>
  );
}
