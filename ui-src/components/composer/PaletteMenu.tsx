// Composer sigil completion card (shared by @ file candidates / line-leading /
// command candidates / line-leading $ skill candidates): the same rounded card
// as the composer card, two cards stacked vertically (2px gap, same width, max
// height = 2.6x the composer card; see placePaletteCard for positioning).
// Reuses the existing .menu/.mi/.sub base classes and the popIn animation;
// only the card look and positioning differ.
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { placePaletteCard } from "./place";
import { pathBase, useAppStore } from "../../store";
import { BUILTIN_DESC_ZH } from "../../i18n/locales/commands-zh-CN";

/** @ file candidate (an element of mentionResult.matches) */
export type FileItem = { path: string; dir: boolean };
/** Slash command candidate (structural subset of the commands list element) */
export type CommandItem = { name: string; aliases?: string[]; description?: string; hint?: string | null; source?: string };
export type PaletteItem = FileItem | CommandItem;

type PaletteMenuProps = {
  mode: "file" | "command" | "commandArgs" | "skill";
  items: PaletteItem[];
  index: number;
  loading: boolean;
  composerRef: RefObject<HTMLDivElement | null>;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
};

/**
 * mode: "file" | "command" | "skill"; items: {path,dir} for file,
 * {name,aliases,description,hint} for command/skill; index is the currently
 * highlighted item; loading means fetching (shows loading...).
 */
export default function PaletteMenu({ mode, items, index, loading, composerRef, onPick, onHover }: PaletteMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const lang = useAppStore((s) => s.uiPrefs.lang);
  // Position on mount; re-position after candidate/loading changes alter the
  // height (the bottom edge always hugs 2px above the composer card)
  useLayoutEffect(() => {
    placePaletteCard(composerRef.current, menuRef.current);
  }, [composerRef, items.length, loading, mode]);
  // When the keyboard moves the highlight, scroll the highlighted row into view
  // (block:"nearest" does not jump the container)
  useLayoutEffect(() => {
    menuRef.current?.querySelector(".mi.on")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div className="menu palette open" ref={menuRef}>
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
            if (!("path" in it)) return null; // type guard: mode and items share one source; file candidates always carry path
            const tail = pathBase(it.path) || it.path;
            label = it.dir ? tail + "/" : tail;
            key = it.path;
            desc = it.path;
          } else if (mode === "skill") {
            if (!("name" in it)) return null; // type guard: skill candidates are command-list entries carrying name
            // The palette is entered via $, so the row shows the bare name with
            // the $ sigil; the accepted chip text is "/skill:<name>"
            label = "$" + it.name.replace(/^skill:/, "");
            key = it.name;
            desc = it.description || "";
          } else if (mode === "commandArgs") {
            if (!("name" in it)) return null; // type guard: subcommand candidates carry name
            // No sigil prefix and no builtin dictionary: subcommand names
            // (view/stats/...) would collide with command-name keys
            label = it.name;
            key = it.name;
            desc = it.description || "";
            hint = it.hint || null;
          } else {
            if (!("name" in it)) return null; // type guard: command candidates always carry name
            label = "/" + it.name + (it.aliases?.length ? " /" + it.aliases[0] : "");
            key = it.name;
            // Built-in command descriptions: zh-CN maps through the dictionary;
            // en has no dictionary by design, unmapped and non-builtin names
            // fall back to the command's own English description.
            desc = (it.source === "builtin" && lang === "zh-CN" ? BUILTIN_DESC_ZH[it.name] : null) || it.description || "";
            hint = it.hint || null;
          }
          return (
            <div
              className={"mi" + (i === index ? " on" : "")}
              key={key}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(i)}
            >
              <span className="mi-tx">{label}</span>
              {hint ? <span className="sub">{hint}</span> : null}
              {desc ? <span className="sub">{desc}</span> : null}
            </div>
          );
        })
      )}
    </div>
  );
}
