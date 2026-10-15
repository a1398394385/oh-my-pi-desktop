// Completion candidate filters for the composer palette (moved out of
// components/Composer.tsx by A14): slash commands, $ skills, and command
// subcommands. Pure functions, no React/store dependency.

/** Structural mirror of the palette command row (see PaletteMenu for the
 *  declared shape; kept field-compatible so the two assign either way) */
export type CommandItem = {
  name: string;
  aliases?: string[];
  description?: string;
  hint?: string | null;
  source?: string;
};

// Slash command candidate filter: empty query returns all, grouped and sorted by
// source (builtin->skill->extension->custom->others); non-empty first matches
// name/aliases by prefix, then by includes, then falls back to source order; cap 50
const SRC_RANK: Record<string, number> = { builtin: 0, skill: 1, extension: 2, custom: 3, file: 4 };
export function filterCommands(list: CommandItem[] | null | undefined, query: string): CommandItem[] {
  if (!Array.isArray(list) || !list.length) return [];
  const rank = (c: CommandItem) => SRC_RANK[c.source ?? ""] ?? 9;
  const q = (query || "").toLowerCase();
  if (!q) return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 50);
  const pre: CommandItem[] = [];
  const incl: CommandItem[] = [];
  for (const c of list) {
    const names = [c.name, ...(c.aliases || [])].map((n) => n.toLowerCase());
    if (names.some((n) => n.startsWith(q))) pre.push(c);
    else if (names.some((n) => n.includes(q))) incl.push(c);
  }
  const byRank = (a: CommandItem, b: CommandItem) => rank(a) - rank(b) || a.name.localeCompare(b.name);
  return [...pre.sort(byRank), ...incl.sort(byRank)].slice(0, 50);
}

// $ skill candidate filter: the source==="skill" entries of the same commands
// list; matching uses the bare name (strip the "skill:" prefix the host reports)
export function filterSkills(list: CommandItem[] | null | undefined, query: string): CommandItem[] {
  if (!Array.isArray(list) || !list.length) return [];
  const bare = (c: CommandItem) => c.name.replace(/^skill:/, "");
  const skills = list.filter((c) => c.source === "skill");
  const byBare = (a: CommandItem, b: CommandItem) => bare(a).localeCompare(bare(b));
  const q = (query || "").toLowerCase();
  if (!q) return skills.sort(byBare).slice(0, 50);
  const pre: CommandItem[] = [];
  const incl: CommandItem[] = [];
  for (const c of skills) {
    const n = bare(c).toLowerCase();
    if (n.startsWith(q)) pre.push(c);
    else if (n.includes(q)) incl.push(c);
  }
  return [...pre.sort(byBare), ...incl.sort(byBare)].slice(0, 50);
}

// Subcommand candidate filter for commandArgs triggers: prefix match,
// lowercase (aligned with the base TUI's buildArgumentCompletions); entries
// reuse the CommandItem shape (name/description/hint = usage)
export function filterSubcommands(
  subs: { name: string; description?: string; usage?: string | null }[] | undefined,
  query: string,
): CommandItem[] {
  if (!Array.isArray(subs) || !subs.length) return [];
  const q = (query || "").toLowerCase();
  return subs.filter((s) => s.name.toLowerCase().startsWith(q)).map((s) => ({ name: s.name, description: s.description, hint: s.usage }));
}
