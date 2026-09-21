// ════════════════════════════════════════════════════════════
// 统一图标注册表：项目内所有静态 SVG 图标集中于此，只存一份
// 取用方式：
//   JS  中：icon("folder") / icon("caret", 12)
//   HTML 中：<span class="..." data-icon="folder" data-size="23"></span>
//           （app.js 启动时 hydrateIcons() 会把占位 span 替换为 svg，
//             并复制占位元素上的 class / id / style）
// 动态图形（如 ctxRing 进度环）不属于图标，仍在 index.html 内联。
// 图层（后者同名覆盖前者）：自定义 → Font Awesome 实心 → Lucide 线条风
// ════════════════════════════════════════════════════════════
// 自定义图标（FA 没有的，如应用 Logo）：直接写在这里
// Lucide 线条风层（最顶层）：同名覆盖 FA 实心图标，达到 ZCode 同款观感；
// 未覆盖到的名（logo/termBox 等）仍由自定义层 / FA 层兜底
import { FA_ICONS } from "./fa-icons.js";
import { LUCIDE_ICONS } from "./lucide-icons.js";

const ICONS = {
  logo: '<svg width="16" height="16" viewBox="0 0 17 17"><rect width="17" height="17" rx="4.5" fill="#3a7bd5"/><path d="M4.8 9.2 7 11.4l5.4-5.6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // 盾牌 + 感叹号：FA Free 无 shield-exclamation（Pro 专属），用 shield 路径 + evenodd 镂空合成
  shieldWarn: '<svg width="16" height="16" viewBox="0 0 512 512"><path fill="currentColor" fill-rule="evenodd" d="M256 0c4.6 0 9.2 1 13.4 2.9L457.8 82.8c22 9.3 38.4 31 38.3 57.2-.5 99.2-41.3 280.7-213.6 363.2-16.7 8-36.1 8-52.8 0-172.4-82.5-213.1-264-213.6-363.2-.1-26.2 16.3-47.9 38.3-57.2L242.7 2.9C246.9 1 251.4 0 256 0zM234 152h44a24 24 0 0 1 24 24v96a24 24 0 0 1-24 24h-44a24 24 0 0 1-24-24v-96a24 24 0 0 1 24-24zM256 336a26 26 0 1 1 0 52 26 26 0 1 1 0-52z"/></svg>',
  // 带长方形完整外壳的终端图标（区别于主对话区的纯 >_）
  termBox: '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.2l2.3 1.8-2.3 1.8"/><path d="M8.5 9.8h3"/></svg>',
  // 线框文件夹 + 加号（打开文件夹）
  folderPlus: '<svg width="14" height="14" viewBox="0 0 512 512"><path fill="currentColor" d="M64 400l384 0c8.8 0 16-7.2 16-16l0-240c0-8.8-7.2-16-16-16l-149.3 0c-17.3 0-34.2-5.6-48-16L212.3 83.2c-2.8-2.1-6.1-3.2-9.6-3.2L64 80c-8.8 0-16 7.2-16 16l0 288c0 8.8 7.2 16 16 16zm384 48L64 448c-35.3 0-64-28.7-64-64L0 96C0 60.7 28.7 32 64 32l138.7 0c13.8 0 27.3 4.5 38.4 12.8l38.4 28.8c5.5 4.2 12.3 6.4 19.2 6.4L448 80c35.3 0 64 28.7 64 64l0 240c0 35.3-28.7 64-64 64zM240 220c0-8.8 7.2-16 16-16s16 7.2 16 16l0 32 32 0c8.8 0 16 7.2 16 16s-7.2 16-16 16l-32 0 0 32c0 8.8-7.2 16-16 16s-16-7.2-16-16l0-32-32 0c-8.8 0-16-7.2-16-16s7.2-16 16-16l32 0 0-32z"/></svg>',
  // 线条风刷新（feather rotate-cw）：设置页刷新钮统一用此图标，FA 的 rotateRight 是实心块，
  // 同尺寸下视觉面积过大，观感像常亮底板
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  // Git Diff 行级写操作（feather 线条族，与 refresh 同风格）：暂存 + / 取消暂存 − / 丢弃（逆时针回退箭头）
  stage: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  unstage: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  discard: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  // 线条风停止（feather square）：流式中的停止生成按钮，FA 的 stop 是实心方块
  stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  // 线条风上下尖角（feather chevron）：会话内查找条的上一个/下一个
  chevronUp: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
  chevronDown: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  // 线条风消息分叉（feather git-branch：竖线 + 分叉圆点）：消息行分叉按钮与右栏分支 tab 用。
  // 命名避开 branch——该名已被 FA 层实心 code-branch 占用（Git Diff tab 在用），自定义层同名会被覆盖
  fork: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
};

// Font Awesome 层：同名覆盖自定义默认（fa-icons.js 由 .local/build-fa-icons.py 生成）
Object.assign(ICONS, FA_ICONS);

// Lucide 线条风层：同名覆盖 FA 层（lucide-icons.js 由脚本生成，见文件头注释）
Object.assign(ICONS, LUCIDE_ICONS);

// 取图标：size 省略时用注册表默认尺寸；传入时覆盖 width/height（保持 viewBox 不变）
function icon(name, size) {
  const d = ICONS[name];
  if (!d) return "";
  if (!size) return d;
  return d.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
}

// 把 HTML 里的占位元素 <span class/id/style data-icon="name" data-size="N"></span>
// 替换为对应 svg，并复制占位元素上的 class / id / style
function hydrateIcons(root) {
  (root || document).querySelectorAll("[data-icon]").forEach((el) => {
    const html = icon(el.dataset.icon, el.dataset.size ? +el.dataset.size : undefined);
    if (!html) return;
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    const svg = t.content.firstElementChild;
    if (!svg) return;
    for (const attr of ["class", "id", "style"]) {
      const v = el.getAttribute(attr);
      if (v && !svg.getAttribute(attr)) svg.setAttribute(attr, v);
    }
    el.replaceWith(svg);
  });
}

// ESM 导出（React 迁移）：esbuild 打包时与 FA 层同名覆盖后的最终注册表一并导出
export { icon, hydrateIcons, ICONS };
