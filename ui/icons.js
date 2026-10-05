// ════════════════════════════════════════════════════════════
// Unified icon registry: every static SVG icon in the project lives here, stored once.
// Usage:
//   JS:    icon("folder") / icon("caret", 12)
//   JSX:   <Icon name="folder" size={23} /> (ui-src/Icon.tsx, injects the registry svg)
//          Legacy HTML placeholder path: hydrateIcons() swaps a <span data-icon="name"
//          data-size="N"> for the svg and copies class / id / style; the React app
//          uses the Icon component instead.
// Dynamic graphics (e.g. the ctxRing progress ring) are not icons; they render as React components.
// Layers (later ones override earlier by name): custom -> Font Awesome solid -> Lucide line-style -> vscode-icons file-type colored
// ════════════════════════════════════════════════════════════
// Custom icons (ones FA lacks, e.g. the app logo): written directly here
// The Lucide line-style layer (topmost) overrides FA solid icons by name for the ZCode look;
// names it doesn't cover (logo/termBox etc.) still fall back to the custom / FA layers
import { FA_ICONS } from "./fa-icons.js";
import { LUCIDE_ICONS } from "./lucide-icons.js";
import { FILE_TYPE_ICONS } from "./file-icons.js";

const ICONS = {
  // ZCode project / new-task icons: keep the Lucide line style.
  house: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></svg>',
  messagePlus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/><path d="M12 8v6"/><path d="M9 11h6"/></svg>',
  // Line-style up/right arrows (lucide arrow-up / arrow-right): send button icon
  arrowUp: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
  arrowRight: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  // Command key icon (lucide command)
  command: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>',
  // Aligned with ZCodium SquareIcon + fill-current: send button stop state
  stopSolid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>',
  logo: '<svg width="16" height="16" viewBox="0 0 17 17"><rect width="17" height="17" rx="4.5" fill="#3a7bd5"/><path d="M4.8 9.2 7 11.4l5.4-5.6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // Line-style info circle (lucide info): hover hint icon next to group titles. FA circle-info is a solid block; a hand-drawn line version matches the lucide look (same precedent as refresh)
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  // Shield + exclamation: FA Free has no shield-exclamation (Pro-only), composed from the shield path + an evenodd cut-out
  shieldWarn: '<svg width="16" height="16" viewBox="0 0 512 512"><path fill="currentColor" fill-rule="evenodd" d="M256 0c4.6 0 9.2 1 13.4 2.9L457.8 82.8c22 9.3 38.4 31 38.3 57.2-.5 99.2-41.3 280.7-213.6 363.2-16.7 8-36.1 8-52.8 0-172.4-82.5-213.1-264-213.6-363.2-.1-26.2 16.3-47.9 38.3-57.2L242.7 2.9C246.9 1 251.4 0 256 0zM234 152h44a24 24 0 0 1 24 24v96a24 24 0 0 1-24 24h-44a24 24 0 0 1-24-24v-96a24 24 0 0 1 24-24zM256 336a26 26 0 1 1 0 52 26 26 0 1 1 0-52z"/></svg>',
  // Terminal icon with a full rectangular shell (unlike the bare >_ in the main chat area)
  termBox: '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.2l2.3 1.8-2.3 1.8"/><path d="M8.5 9.8h3"/></svg>',
  // Wireframe folder + plus (open folder)
  folderPlus: '<svg width="14" height="14" viewBox="0 0 512 512"><path fill="currentColor" d="M64 400l384 0c8.8 0 16-7.2 16-16l0-240c0-8.8-7.2-16-16-16l-149.3 0c-17.3 0-34.2-5.6-48-16L212.3 83.2c-2.8-2.1-6.1-3.2-9.6-3.2L64 80c-8.8 0-16 7.2-16 16l0 288c0 8.8 7.2 16 16 16zm384 48L64 448c-35.3 0-64-28.7-64-64L0 96C0 60.7 28.7 32 64 32l138.7 0c13.8 0 27.3 4.5 38.4 12.8l38.4 28.8c5.5 4.2 12.3 6.4 19.2 6.4L448 80c35.3 0 64 28.7 64 64l0 240c0 35.3-28.7 64-64 64zM240 220c0-8.8 7.2-16 16-16s16 7.2 16 16l0 32 32 0c8.8 0 16 7.2 16 16s-7.2 16-16 16l-32 0 0 32c0 8.8-7.2 16-16 16s-16-7.2-16-16l0-32-32 0c-8.8 0-16-7.2-16-16s7.2-16 16-16l32 0 0-32z"/></svg>',
  // Line-style refresh (feather rotate-cw): the unified icon for settings-page refresh buttons.
  // FA rotateRight is a solid block — too visually heavy at the same size, reads like a lit background
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  // Git Diff line-level write actions (feather line family, same style as refresh): stage + / unstage - / discard (counter-clockwise revert arrow)
  stage: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  unstage: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  discard: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  // Line-style pause/play (feather): pause/resume in the goal bar (in-place swap); FA versions are solid blocks
  pause: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  play: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
  // Line-style up/down chevrons (feather chevron): previous/next in the in-session find bar
  chevronUp: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
  chevronDown: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  // Line-style double-down arrows (lucide chevrons-down): right-sidebar tab-overview icon, aligned with ZCodium ChevronsDownIcon
  chevronsDown: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>',
  // Line-style message fork (feather git-branch: vertical line + branch dots): the message-row
  // fork button and the right-sidebar branch tab. Named to avoid "branch" — that name is taken
  // by the FA layer's solid code-branch (used by the Git Diff tab), which would override a custom-layer same-name entry
  fork: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  // Line-style copy (feather copy: two overlapping rectangles): turn-end output copy button, same family as fork with stroke-width=2
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  // Line-style steer (feather corner-up-right: path bending into an up-right arrow): subagent
  // steer control on Agent Hub cards — same family as fork/copy (stroke-width=2)
  steer: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>',
  wrapText: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18"/><path d="M3 11h15a3 3 0 1 1 0 6h-4"/><path d="m14 15-2 2 2 2"/><path d="M3 17h2"/></svg>',
  // Session-tree tab (lucide list-tree, line version): right-sidebar entry-tree tab, distinct from fork (file-level branch)
  tree: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/></svg>',
  // Experimental-feature category icon: line-style conical flask (lucide-layer params: stroke-width=1.5 / viewBox 24)
  flask: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3v6.4L4.9 18.4a2 2 0 0 0 1.8 3.1h10.6a2 2 0 0 0 1.8-3.1L14.5 9.4V3"/><path d="M8.2 3h7.6"/><path d="M6.9 14.5h10.2"/></svg>',
  // Plan mode: line-style plan document (dog-eared page + body lines). Neither FA nor Lucide
  // has a plan-semantics icon; hand-drawn line version in the refresh / flask family (stroke-width 1.7 / viewBox 24)
  plan: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2.75H7A2.25 2.25 0 0 0 4.75 5v14A2.25 2.25 0 0 0 7 21.25h10A2.25 2.25 0 0 0 19.25 19V8z"/><path d="M14 2.75V8h5.25"/><path d="M8.5 13h7M8.5 16.5h4"/></svg>',
  // Line-style archive (lucide archive): hover archive button on session rows
  archive: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
};

// Font Awesome layer: overrides custom defaults by name (fa-icons.js generated by .local/build-fa-icons.py)
Object.assign(ICONS, FA_ICONS);

// Lucide line-style layer: overrides the FA layer by name (lucide-icons.js generated by a script, see that file's header)
Object.assign(ICONS, LUCIDE_ICONS);

// vscode-icons file-type colored layer (topmost): overrides the lucide line-style layer's ft* file icons by name
// (file-icons.js generated by .local/build-file-icons.py, size 16 matching the overridden layer)
Object.assign(ICONS, FILE_TYPE_ICONS);

// Get an icon: omitting size uses the registry default; passing it overrides width/height (viewBox unchanged).
// Variant cache (BUG-007): the render hot path calls this for every Icon every frame; the replace
// regex times the component count is a main-thread hotspot in long sessions — compute each
// name+size variant once, then look it up.
const iconVariantCache = {};
function icon(name, size) {
  const d = ICONS[name];
  if (!d) return "";
  if (!size) return d;
  const key = name + "@" + size;
  return (iconVariantCache[key] ??= d.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`));
}

// ---------- File-type icon by file name (vscode-icons colored layer) ----------
// Extension (lowercase) -> registry key; special file names take priority over extensions (dockerfile has no extension semantics)
const FILE_NAME_ICONS = {
  dockerfile: "ftDocker",
  "docker-compose.yml": "ftDocker",
  "docker-compose.yaml": "ftDocker",
};
const FILE_EXT_ICONS = {
  html: "ftHtml", htm: "ftHtml",
  css: "ftCss", scss: "ftScss", sass: "ftScss",
  js: "ftJs", mjs: "ftJs", cjs: "ftJs", jsx: "ftJsx",
  ts: "ftTs", mts: "ftTs", cts: "ftTs", tsx: "ftTsx",
  json: "ftJson", jsonc: "ftJson", json5: "ftJson",
  md: "ftMd", mdx: "ftMd", markdown: "ftMd",
  py: "ftPy", pyi: "ftPy", pyw: "ftPy",
  rs: "ftRs", go: "ftGo", java: "ftJava",
  kt: "ftKt", kts: "ftKt", swift: "ftSwift",
  c: "ftC", cpp: "ftCpp", cc: "ftCpp", cxx: "ftCpp", hpp: "ftCpp", hh: "ftCpp", h: "ftH",
  vue: "ftVue",
  sh: "ftSh", bash: "ftSh", zsh: "ftSh", fish: "ftSh",
  yml: "ftYaml", yaml: "ftYaml", toml: "ftToml", sql: "ftSql",
  svg: "ftSvg",
  png: "ftImg", jpg: "ftImg", jpeg: "ftImg", gif: "ftImg", webp: "ftImg", bmp: "ftImg", ico: "ftImg", tiff: "ftImg",
  txt: "ftText", log: "ftText", pdf: "ftPdf",
  zip: "ftZip", gz: "ftZip", tgz: "ftZip", tar: "ftZip", rar: "ftZip", "7z": "ftZip",
  mp4: "ftVideo", mov: "ftVideo", mkv: "ftVideo", webm: "ftVideo", avi: "ftVideo",
  mp3: "ftAudio", wav: "ftAudio", flac: "ftAudio", aac: "ftAudio", m4a: "ftAudio",
  gitignore: "ftGit", gitattributes: "ftGit", gitmodules: "ftGit", editorconfig: "ftGit",
};
function fileTypeIcon(name) {
  const base = String(name || "").split("/").pop() || "";
  const clean = base.replace(/:\d+(?:-\d+)?$/, "");
  const lower = clean.toLowerCase();
  if (FILE_NAME_ICONS[lower]) return FILE_NAME_ICONS[lower];
  const i = lower.lastIndexOf(".");
  const ext = i >= 0 ? lower.slice(i + 1) : "";
  return FILE_EXT_ICONS[ext] || "ftFile";
}

// Replaces placeholder elements in HTML <span class/id/style data-icon="name" data-size="N"></span>
// with the matching svg, copying class / id / style from the placeholder element
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

// ESM exports (React migration): the bundler also exports the final registry merged with all override layers
export { icon, hydrateIcons, ICONS, fileTypeIcon };
