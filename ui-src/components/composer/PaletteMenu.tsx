// 输入框 sigil 补全卡（@ 文件候选 / 行首 / 命令候选共用）：输入框卡的同款圆角卡片，
// 两张卡片上下排列（间距 2px、同宽、最大高度 = 输入框卡 2.6 倍，定位见 placePaletteCard）。
// 复用既有 .menu/.mi/.sub 基类与 popIn 动画，只改卡片外观与定位。
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { placePaletteCard } from "./place";
import { pathBase, useAppStore } from "../../store";
import { BUILTIN_DESC_ZH } from "../../i18n/locales/commands-zh-CN";

/** @ 文件候选（mentionResult.matches 元素） */
export type FileItem = { path: string; dir: boolean };
/** 斜杠命令候选（commands 清单元素的结构子集） */
export type CommandItem = { name: string; aliases?: string[]; description?: string; hint?: string | null; source?: string };
export type PaletteItem = FileItem | CommandItem;

type PaletteMenuProps = {
  mode: "file" | "command";
  items: PaletteItem[];
  index: number;
  loading: boolean;
  composerRef: RefObject<HTMLDivElement | null>;
  onPick: (i: number) => void;
  onHover: (i: number) => void;
};

/**
 * mode: "file" | "command"；items: file 为 {path,dir}、command 为 {name,aliases,description,hint}；
 * index 当前高亮项；loading 拉取中（显示加载中…）。
 */
export default function PaletteMenu({ mode, items, index, loading, composerRef, onPick, onHover }: PaletteMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const lang = useAppStore((s) => s.uiPrefs.lang);
  // 挂载即定位；候选/加载态变化引起高度变化后重新定位（底缘始终贴输入框卡上方 2px）
  useLayoutEffect(() => {
    placePaletteCard(composerRef.current, menuRef.current);
  }, [composerRef, items.length, loading, mode]);
  // 键盘上下移动高亮时，把高亮行滚动进可视区（block:"nearest" 不跳动容器）
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
            if (!("path" in it)) return null; // 类型守卫：mode 与 items 同源，file 候选必含 path
            const tail = pathBase(it.path) || it.path;
            label = it.dir ? tail + "/" : tail;
            key = it.path;
            desc = it.path;
          } else {
            if (!("name" in it)) return null; // 类型守卫：command 候选必含 name
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
