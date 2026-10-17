// Session accent: a stable color derived from the session title (TUI parity — the TUI hashes
// the name into a hue in theme/session-color.ts). The desktop keeps the palette tokenized:
// 8 curated slots with separate dark/light values in tokens.css, so contrast is reviewed per
// theme instead of being computed from OKLCH at runtime.
const SLOT_COUNT = 8;

// djb2, same family as the TUI's nameToHash: stable across reloads and platforms.
function hashName(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** CSS color of the title's accent slot; null while the session has no title yet. */
export function sessionAccentColor(title: string | null | undefined): string | null {
  if (!title) return null;
  return `var(--sess-${(hashName(title) % SLOT_COUNT) + 1})`;
}

/** Bash-mode color for the same session: the next slot over, so the terminal composer is
 *  recognizably a different mode and never shares the input's color. */
export function bashAccentColor(title: string | null | undefined): string | null {
  if (!title) return null;
  return `var(--sess-${((hashName(title) + 1) % SLOT_COUNT) + 1})`;
}
