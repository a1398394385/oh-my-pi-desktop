// composer 菜单定位（原 composer.js openComposerMenu 的定位主体平移，不依赖 shell.js）：
// 锚定按钮（left 跟随、底部贴按钮上方 8px 向上展开），右缘不越界。
// 垂直方向按按钮实时 offsetTop 计算而非固定 bottom:44px——后者只在单行布局侥幸成立，
// 换行/分级收缩导致按钮位移后弹窗会脱离按钮（新建会话窄窗口错位 bug 的根因）。
// 上方视口空间不足时改限高 + 内部滚动，菜单顶最多到视口上沿 4px，底缘仍贴按钮上方。
import { S } from "../../store.js";

export function placeComposerMenu(comp, menu, btn) {
  if (!comp || !menu || !btn) return;
  menu.style.maxHeight = "";
  menu.style.overflowY = "";
  const z = S.zoomLevel || 1;
  const maxLeft = comp.clientWidth - menu.offsetWidth - 4;
  menu.style.left = Math.max(0, Math.min(btn.offsetLeft, maxLeft)) + "px";
  const btnAbsTop = btn.getBoundingClientRect().top;
  let top = btn.offsetTop - menu.offsetHeight - 8;
  if (btnAbsTop - (menu.offsetHeight + 8) * z < 4) {
    const compTop = comp.getBoundingClientRect().top;
    menu.style.maxHeight = Math.max(80, Math.round((btnAbsTop - 8 * z - 4) / z)) + "px";
    menu.style.overflowY = "auto";
    top = Math.round((4 - compTop) / z);
  }
  menu.style.top = top + "px";
  menu.style.bottom = "auto";
}
