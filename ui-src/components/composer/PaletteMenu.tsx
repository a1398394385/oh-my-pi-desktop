// Composer sigil completion card. Slash commands add a category strip and
// keyboard footer; file, $skill and subcommand completion keep the plain list.
import { useLayoutEffect, useRef, useState, useEffect } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { placePaletteCard } from "./place";
import { COMMAND_CATEGORIES } from "./completionFilters";
import type { CommandCategory } from "./completionFilters";
import { pathBase, useAppStore } from "../../store";
import Icon from "../../Icon";

// Built-in command descriptions (zh-CN dictionary): loaded on first palette
// render so the module stays out of the startup closure; rows fall back to the
// command's own English description for the one frame before it lands.
let builtinDescZh: Record<string, string> | null = null;
let builtinDescLoad: Promise<Record<string, string>> | null = null;
const NO_DESC: Record<string, string> = {};
const CATEGORY_LABELS: Record<CommandCategory, string> = {
  recent: "composer.paletteRecent",
  mode: "composer.paletteModes",
  skill: "composer.paletteSkills",
  plugin: "composer.palettePlugins",
  command: "composer.paletteCommands",
};

/** @ file candidate (an element of mentionResult.matches) */
export type FileItem = { path: string; dir: boolean; empty?: boolean };
/** Slash command candidate (structural subset of the commands list element) */
export type CommandItem = { name: string; aliases?: string[]; description?: string; hint?: string | null; source?: string };
export type PaletteItem = FileItem | CommandItem;

type PaletteMenuProps = {
  mode: "file" | "command" | "commandArgs" | "skill";
  items: PaletteItem[];
  index: number;
  loading: boolean;
  composerRef: RefObject<HTMLDivElement | null>;
  category: CommandCategory;
  query: string;
  onCategoryChange: (category: CommandCategory) => void;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
};

export default function PaletteMenu({ mode, items, index, loading, composerRef, category, query, onCategoryChange, onPick, onHover }: PaletteMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const lang = useAppStore((s) => s.uiPrefs.lang);
  const [builtinDesc, setBuiltinDesc] = useState<Record<string, string>>(builtinDescZh ?? NO_DESC);
  const commandMode = mode === "command";

  useLayoutEffect(() => {
    const composer = composerRef.current;
    const menu = menuRef.current;
    const place = () => {
      placePaletteCard(composer, menu, commandMode ? Number.POSITIVE_INFINITY : 2.6);
      if (commandMode && menu) menu.style.overflowY = "hidden";
    };
    place();
    if (!commandMode || !composer) return;
    const observer = new ResizeObserver(place);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [commandMode, composerRef, items.length, loading, mode]);

  useLayoutEffect(() => {
    menuRef.current?.querySelector(".mi.on")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  // The editor retains focus. Left/right switches categories only for the
  // empty-query browser; with a query they remain ordinary caret movement.
  useEffect(() => {
    if (!commandMode || query) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      const offset = event.key === "ArrowLeft" ? -1 : 1;
      const current = COMMAND_CATEGORIES.indexOf(category);
      const next = (current + offset + COMMAND_CATEGORIES.length) % COMMAND_CATEGORIES.length;
      onCategoryChange(COMMAND_CATEGORIES[next]);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [category, commandMode, onCategoryChange, query]);

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
    <div className={"menu palette open" + (commandMode ? " slash" : "")} ref={menuRef}>
      {commandMode ? (
        <div className="slash-tabs" role="tablist" aria-label={t("composer.paletteCategories")}>
          {COMMAND_CATEGORIES.map((name) => (
            <button
              type="button"
              role="tab"
              tabIndex={-1}
              className="slash-tab"
              id={`slash-tab-${name}`}
              aria-selected={!query && category === name}
              aria-controls="slash-command-results"
              key={name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onCategoryChange(name)}
            >
              {t(CATEGORY_LABELS[name])}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className={commandMode ? "slash-list" : "palette-list"}
        id={commandMode ? "slash-command-results" : undefined}
        role={commandMode ? "listbox" : undefined}
        aria-labelledby={commandMode ? `slash-tab-${category}` : undefined}
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
            if (mode === "file") {
              if (!("path" in it)) return null;
              const tail = pathBase(it.path) || it.path;
              label = it.dir ? tail + "/" : tail;
              key = it.path;
              desc = it.path;
            } else if (mode === "skill") {
              if (!("name" in it)) return null;
              label = "$" + it.name.replace(/^skill:/, "");
              key = it.name;
              desc = it.description || "";
            } else if (mode === "commandArgs") {
              if (!("name" in it)) return null;
              label = it.name;
              key = it.name;
              desc = it.description || "";
              hint = it.hint || null;
            } else {
              if (!("name" in it)) return null;
              label = it.name + (it.aliases?.length ? " /" + it.aliases[0] : "");
              key = it.name;
              desc = (it.source === "builtin" && lang === "zh-CN" ? builtinDesc[it.name] : null) || it.description || "";
              hint = it.hint || null;
            }
            const secondary = [hint, desc].filter(Boolean).join(" · ");
            return (
              <div
                className={"mi" + (i === index ? " on" : "")}
                key={key}
                role={commandMode ? "option" : undefined}
                aria-selected={commandMode ? i === index : undefined}
                title={secondary ? `${label} — ${secondary}` : label}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(i)}
              >
                {commandMode ? <span className="slash-ic"><Icon name={"name" in it && it.name === "plan" ? "plan" : "command"} size={15} /></span> : null}
                <span className="mi-tx">{label}</span>
                {secondary ? <span className="sub">{secondary}</span> : null}
              </div>
            );
          })
        )}
      </div>
      {commandMode ? (
        <div className="slash-footer">
          <span className="slash-hint"><kbd>↑↓</kbd>{t("composer.paletteSelect")}</span>
          <span className="slash-hint"><kbd>←→</kbd>{t("composer.paletteSwitchCategory")}</span>
          <span className="slash-hint"><kbd>Enter / Tab</kbd>{t("composer.paletteAdd")}</span>
          <span className="slash-hint slash-close"><kbd>Esc</kbd>{t("common.close")}</span>
        </div>
      ) : null}
    </div>
  );
}
