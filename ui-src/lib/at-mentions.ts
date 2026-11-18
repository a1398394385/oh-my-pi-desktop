// `@path` tokens in a user prompt. Mirrors the base's file-mention grammar
// (pi-coding-agent utils/file-mentions.ts) so the bubble hides exactly what the base
// auto-read: @path, @"path with space", @'path with space', and only when the @ follows
// whitespace or an opening bracket/quote. Text glued to the @ ("see@a.md")
// never triggers a read (the base requires the boundary), so such tokens stay visible.
//
// `known` is the authoritative path list from the host (fileMention read-back): when
// present only those tokens are hidden, so a mention the base failed to read keeps its
// `@path` on screen instead of silently turning into an attachment chip.
// Backtick excluded from the bare branch: an inline-code mention (`@a/b`) would otherwise
// carry the closing backtick into the path, which the base's sanitizeMentionPath strips.
const TOKEN_RE = /@(?:"([^"]+)"|'([^']+)'|([^\s@`]+))/g;
const BOUNDARY_RE = /[\s([{<"'`]/;

// `/skill:<name>` invocations the host dispatches (mirror of the base's SKILL_TOKEN_RE
// and allowsSkillTokens): one optional `/` namespace, whitespace-delimited, and only when
// the draft is not owned by another sigil — a leading `/cmd`, `!cmd` or `$ cmd` consumes
// its text verbatim, so such a `/skill:` stays on screen as typed.
const SKILL_RE = /(^|\s)\/skill:([^\s/]+(?:\/[^\s/]+)?)(?=\s|$)/g;

/** Picked-element block, byte-for-byte as AgentBrowserView.pickedText writes it: a header
 *  line, the meta lines and the fenced markup, closed by a `[/element]` line. The closing
 *  marker is what lets the block be recognised anywhere in the prompt (typed-in front or
 *  back); without one the header + fence pair alone is too easy to forge in prose, so
 *  blocks written before the marker existed stay anchored to a line start. Matched whole
 *  because the fenced html may contain @ and / tokens that must not split it. */
const ELEMENT_BLOCK_RE = /\[element\] [^\n]*(?:\n[^\n]*)*?\n```[^\n]*\n[\s\S]*?\n```\n\[\/element\]/g;
// shortcut: an html body that itself contains a `[/element]` line ends the block early —
// only picking an element whose own text says that can hit it.
const ELEMENT_LEGACY_RE = /^\[element\] [^\n]*(?:\n[^\n]*)*?\n```[^\n]*\n[\s\S]*?\n```/gm;

/** Every picked-element block in `text`, in order (a legacy match can sit inside a marked
 *  block, so overlapping ranges collapse into the first one). */
function elementBlocks(text: string): Array<{ start: number; end: number; token: string }> {
  const all = [...text.matchAll(ELEMENT_BLOCK_RE), ...text.matchAll(ELEMENT_LEGACY_RE)]
    .map((m) => ({ start: m.index!, end: m.index! + m[0].length, token: m[0] }))
    .sort((a, b) => a.start - b.start);
  const out: typeof all = [];
  for (const b of all) if (out.length === 0 || b.start >= out[out.length - 1].end) out.push(b);
  return out;
}

/** Header label of a picked-element block: "[element] div#x.cls 120×40" → "div#x.cls".
 *  The box size and the markup stay in the block (chip title). */
export function elementLabel(block: string): string {
  return block
    .slice("[element] ".length)
    .split("\n")[0]
    .replace(/\s+\d+×\d+$/, "");
}

/** Cut the picked-element blocks out of the body: one chip in the bubble instead of the
 *  header lines plus the markup. Runs before the skill / @ passes so a token inside the
 *  quoted html is never mistaken for a reference. */
function stripElements(text: string): { text: string; elements: string[] } {
  const blocks = elementBlocks(text);
  if (blocks.length === 0) return { text, elements: [] };
  let out = "";
  let last = 0;
  for (const b of blocks) {
    out += text.slice(last, b.start);
    last = b.end;
    // A block dropped between two words leaves one space, not two
    if (/[ \t]/.test(text[b.start - 1] ?? "") && /[ \t]/.test(text[b.end] ?? "")) last += 1;
  }
  out += text.slice(last);
  return {
    text: out.replace(/[ \t]*\n[ \t]*(?=\n|$)/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    elements: blocks.map((b) => b.token),
  };
}

function skillAllowed(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith("/")) return t.startsWith("/skill:");
  if (t.startsWith("!")) return false;
  if (!t.startsWith("$") || t[1] === "{") return true;
  const rest = t.slice(t[1] === "$" ? 2 : 1);
  return rest !== "" && !/^\s/.test(rest);
}

/** Cut the skill invocations out of the body: the bubble chips them like @ references. */
function stripSkills(text: string): { text: string; skills: string[] } {
  const skills: string[] = [];
  if (!skillAllowed(text)) return { text, skills };
  const out = text.replace(SKILL_RE, (_m, _lead: string, name: string) => {
    skills.push(name);
    return "";
  });
  // The match owns one leading space, so "a /skill:x b" leaves "a b"; what a line-start
  // token leaves behind is its own trailing space
  return { text: skills.length > 0 ? out.trim() : text, skills };
}

/** Strip the mention, skill and picked-element tokens from `text` and return what each
 *  kind needs to render as a chip. */
export function atMentions(
  text: string,
  known?: string[],
): { text: string; paths: string[]; skills: string[]; elements: string[] } {
  const element = stripElements(text);
  const { text: body, skills } = stripSkills(element.text);
  const hits: Array<{ start: number; end: number; path: string }> = [];
  for (const m of body.matchAll(TOKEN_RE)) {
    const start = m.index;
    if (start === undefined) continue;
    if (start > 0 && !BOUNDARY_RE.test(body[start - 1])) continue;
    const path = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!path) continue;
    // An empty array is authoritative ("the base read nothing, this is prose"), so the token
    // stays on screen; an absent list only means the caller has no read-back yet and keeps
    // the optimistic strip (sidebar preview, queue card, optimistic-resend dedupe).
    if (known && !known.includes(path)) continue;
    hits.push({ start, end: start + m[0].length, path });
  }
  if (hits.length === 0) return { text: body, paths: known ?? [], skills, elements: element.elements };
  let out = "";
  let last = 0;
  for (const hit of hits) {
    // Swallow one preceding space so "see @a.md" leaves "see" instead of "see "
    const cut = hit.start > 0 && (body[hit.start - 1] === " " || body[hit.start - 1] === "\t") ? hit.start - 1 : hit.start;
    out += body.slice(last, cut);
    last = hit.end;
  }
  out += body.slice(last);
  // Attachment lines leave empty whitespace-only lines and doubled breaks behind
  out = out.replace(/[ \t]*\n[ \t]*(?=\n|$)/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, paths: known ?? hits.map((h) => h.path), skills, elements: element.elements };
}

/** One prompt reference the base / host resolves, in prompt order. */
export interface PromptRef {
  kind: "file" | "session";
  path: string;
  /** The exact source token (leading `@`, quoting and any consumed trailing space
   *  included) so a rebuilt editor serializes back to the same bytes. */
  token: string;
}

/** True when a file-mention token points at a directory. insertFile writes a trailing
 *  slash for directory matches ("@docs/", '@"a b/"'); file matches end with a space. */
export function isDirToken(token: string): boolean {
  return token.replace(/ +$/, "").replace(/"$/, "").endsWith("/");
}

/** An element the browser mirror's picker wrote into the draft: a `[element] sel WxH`
 *  header with color/background/font/url lines and the fenced html below it. The whole
 *  block is one chip, so it carries no path -- only the bytes to serialize back. */
export interface ElementRef {
  kind: "element";
  token: string;
}

const REF_RE = /@session:(?:"([^"]+)"|(\S+)) ?|@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;

/** Split a prompt into literal text and its references. Used to rebuild the editor
 *  (chips) from already-sent text; display paths use `atMentions` instead. */
export function splitRefs(text: string): Array<{ text: string } | PromptRef | ElementRef> {
  const out: Array<{ text: string } | PromptRef | ElementRef> = [];
  const blocks = elementBlocks(text);
  let next = 0;
  let last = 0;
  const flushTo = (cut: number) => {
    if (cut > last) out.push({ text: text.slice(last, cut) });
    last = cut;
  };
  const flushBlocksBefore = (cut: number) => {
    while (next < blocks.length && blocks[next].end <= cut) {
      const b = blocks[next++];
      flushTo(b.start);
      out.push({ kind: "element", token: b.token });
      last = b.end;
    }
  };
  for (const m of text.matchAll(REF_RE)) {
    const start = m.index;
    if (start === undefined) continue;
    flushBlocksBefore(start);
    if (next < blocks.length && start >= blocks[next].start && start < blocks[next].end) continue;
    const session = m[1] !== undefined || m[2] !== undefined;
    if (!session && start > 0 && !BOUNDARY_RE.test(text[start - 1])) continue;
    const path = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
    if (!path) continue;
    // The token owns its trailing space (insertFile/insertSessionRef write one) so the
    // rebuilt text stays byte-identical: "a @f.ts b" -> "a " + chip("@f.ts ") + "b"
    const spaced = text[start + m[0].length] === " ";
    const token = m[0] + (spaced ? " " : "");
    flushTo(start);
    out.push({ kind: session ? "session" : "file", path, token });
    last = start + token.length;
  }
  flushBlocksBefore(text.length);
  flushTo(text.length);
  return out;
}
