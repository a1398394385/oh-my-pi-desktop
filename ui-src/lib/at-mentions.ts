// `@path` tokens in a user prompt. Mirrors the base's file-mention grammar
// (pi-coding-agent utils/file-mentions.ts) so the bubble hides exactly what the base
// auto-read: @path, @"path with space", @'path with space', and only when the @ follows
// whitespace or an opening bracket/quote. Text glued to the @ ("see@a.md")
// never triggers a read (the base requires the boundary), so such tokens stay visible.
//
// `known` is the authoritative path list from the host (fileMention read-back): when
// present only those tokens are hidden, so a mention the base failed to read keeps its
// `@path` on screen instead of silently turning into an attachment chip.
const TOKEN_RE = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
const BOUNDARY_RE = /[\s([{<"'`]/;

/** Strip the mention tokens from `text` and return the paths to render as attachments. */
export function atMentions(text: string, known?: string[]): { text: string; paths: string[] } {
  const hits: Array<{ start: number; end: number; path: string }> = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index;
    if (start === undefined) continue;
    if (start > 0 && !BOUNDARY_RE.test(text[start - 1])) continue;
    const path = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!path) continue;
    if (known?.length && !known.includes(path)) continue;
    hits.push({ start, end: start + m[0].length, path });
  }
  if (hits.length === 0) return { text, paths: known ?? [] };
  let out = "";
  let last = 0;
  for (const hit of hits) {
    // Swallow one preceding space so "see @a.md" leaves "see" instead of "see "
    const cut = hit.start > 0 && (text[hit.start - 1] === " " || text[hit.start - 1] === "\t") ? hit.start - 1 : hit.start;
    out += text.slice(last, cut);
    last = hit.end;
  }
  out += text.slice(last);
  // Attachment lines leave empty whitespace-only lines and doubled breaks behind
  out = out.replace(/[ \t]*\n[ \t]*(?=\n|$)/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, paths: known ?? hits.map((h) => h.path) };
}
