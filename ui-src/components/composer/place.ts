// composer 菜单定位（原 composer.js openComposerMenu 的定位主体平移，不依赖 shell.js）：
// 锚定按钮（left 跟随、底部贴按钮上方 8px 向上展开），右缘不越界。
// 垂直方向按按钮实时 offsetTop 计算而非固定 bottom:44px——后者只在单行布局侥幸成立，
// 换行/分级收缩导致按钮位移后弹窗会脱离按钮（新建会话窄窗口错位 bug 的根因）。
// 上方视口空间不足时改限高 + 内部滚动，菜单顶最多到视口上沿 4px，底缘仍贴按钮上方。
import { useAppStore } from "../../store";

export function placeComposerMenu(comp: HTMLElement | null, menu: HTMLElement | null, btn: HTMLElement | null): void {
  if (!comp || !menu || !btn) return;
  menu.style.maxHeight = "";
  menu.style.overflowY = "";
  const z = useAppStore.getState().zoomLevel || 1;
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

// sigil 补全卡定位：与输入框卡外缘同宽对齐，底缘贴卡片上缘上方 2px（屏幕像素，不随界面
// 缩放翻倍）——两张一模一样的圆角卡片上下排列（内容更多的那张在上）。最大高度 = 输入框卡
// 高度的 ratio 倍（2.6）；上方视口不足时底缘不动、顶最多到视口上沿 4px，超出部分内部滚动。
// 垂直位置用 bottom 锚定（= padding box 高 + 顶边框 + 间距）而非 top 测量：不依赖弹层自身
// 高度的一次性测量，候选到达/字体加载引起高度变化时不会留出过期的空隙。
export function placePaletteCard(comp: HTMLElement | null, menu: HTMLElement | null, ratio = 2.6): void {
  if (!comp || !menu) return;
  const z = useAppStore.getState().zoomLevel || 1;
  const cs = getComputedStyle(comp);
  const borderLeft = Number.parseFloat(cs.borderLeftWidth) || 0;
  const borderTop = Number.parseFloat(cs.borderTopWidth) || 0;
  menu.style.maxHeight = "";
  menu.style.overflowY = "";
  // containing block 是 #composer 的 padding box：外缘对齐 = 左移左边框宽 + 卡片的 border-box 宽
  menu.style.left = -borderLeft + "px";
  menu.style.width = comp.offsetWidth + "px";
  // 底缘锚定：padding box 底缘上方 (padding 高 + 顶边框 + 间距/zoom)，即卡片上缘上方 2 屏幕像素
  menu.style.bottom = comp.clientHeight + borderTop + 2 / z + "px";
  menu.style.top = "auto";
  const maxH = Math.round(comp.offsetHeight * ratio);
  if (menu.offsetHeight > maxH) {
    menu.style.maxHeight = maxH + "px";
    menu.style.overflowY = "auto";
  }
  // 上方可用高度（layout px）：视口上沿 4px 为止，减去间距与 containing block 到卡片外缘的边框差
  const avail = Math.round((comp.getBoundingClientRect().top - 4) / z) - borderTop - Math.ceil(2 / z);
  if (menu.offsetHeight > avail) {
    menu.style.maxHeight = Math.max(80, avail) + "px";
    menu.style.overflowY = "auto";
  }
}
