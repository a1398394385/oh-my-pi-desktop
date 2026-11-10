const RECENT_COMMANDS_KEY = "omp-slash-recents";
const RECENT_COMMANDS_MAX = 12;

export function readRecentCommands(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((name): name is string => typeof name === "string" && name.length > 0))].slice(0, RECENT_COMMANDS_MAX);
  } catch {
    return [];
  }
}

export function recordRecentCommand(name: string): string[] {
  const next = [name, ...readRecentCommands().filter((recent) => recent !== name)].slice(0, RECENT_COMMANDS_MAX);
  try {
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next));
  } catch {
    // Storage quota/privacy failures only lose persistence; the in-memory list still updates.
  }
  return next;
}
