// 输入框 sigil 补全卡（@ 文件候选 / 行首 / 命令候选共用）：输入框卡的同款圆角卡片，
// 两张卡片上下排列（间距 2px、同宽、最大高度 = 输入框卡 2.6 倍，定位见 placePaletteCard）。
// 复用既有 .menu/.mi/.sub 基类与 popIn 动画，只改卡片外观与定位。
import { useLayoutEffect, useRef } from "react";
import { placePaletteCard } from "./place.js";
import { BUILTIN_DESC_ZH } from "./commands-zh.js";

/**
 * mode: "file" | "command"；items: file 为 {path,dir}、command 为 {name,aliases,description,hint}；
 * index 当前高亮项；loading 拉取中（显示加载中…）。
 */
export default function PaletteMenu({ mode, items, index, loading, composerRef, onPick, onHover }) {
  const menuRef = useRef(null);
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
        <div className="mi empty">加载中…</div>
      ) : !items.length ? (
        <div className="mi empty">无匹配</div>
      ) : (
        items.map((it, i) => {
          let label;
          let desc = "";
          let hint = null;
          if (mode === "file") {
            const tail = it.path.split("/").pop() || it.path;
            label = it.dir ? tail + "/" : tail;
            desc = it.path;
          } else {
            label = "/" + it.name + (it.aliases?.length ? " /" + it.aliases[0] : "");
            // builtin 描述走中文映射（未收录/非 builtin 回退原文）
            desc = (it.source === "builtin" ? BUILTIN_DESC_ZH[it.name] : null) || it.description || "";
            hint = it.hint || null;
          }
          return (
            <div
              className={"mi" + (i === index ? " on" : "")}
              key={mode === "file" ? it.path : it.name}
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
