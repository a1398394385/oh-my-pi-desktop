// Theme registry for omp-desktop
// Mirrors the structure of openhanako theme-registry.ts

export interface ThemeEntry {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  shikiTheme: 'dark-plus' | 'light-plus' | 'nord';
}

export const THEMES: Record<string, ThemeEntry> = {
  // Built-in themes (existing)
  dark: {
    id: 'dark',
    name: 'Dark',
    mode: 'dark',
    shikiTheme: 'dark-plus',
  },
  light: {
    id: 'light',
    name: 'Light',
    mode: 'light',
    shikiTheme: 'light-plus',
  },

  // Four selected Openhanako themes
  midnight: {
    id: 'midnight',
    name: 'Midnight (青夜)',
    mode: 'dark',
    shikiTheme: 'nord',
  },
  'warm-paper': {
    id: 'warm-paper',
    name: 'Warm Paper (暖纸)',
    mode: 'light',
    shikiTheme: 'light-plus',
  },
  'deep-think': {
    id: 'deep-think',
    name: 'Deep Think',
    mode: 'light',
    shikiTheme: 'light-plus',
  },
  coral: {
    id: 'coral',
    name: 'Coral (珊瑚)',
    mode: 'light',
    shikiTheme: 'light-plus',
  },
};

export type ThemeId = keyof typeof THEMES;

export function getThemeIds(): ThemeId[] {
  return Object.keys(THEMES) as ThemeId[];
}

export function getThemeById(id: string): ThemeEntry | undefined {
  return THEMES[id as ThemeId];
}

export function resolveTheme(id: string | null): ThemeId {
  if (!id || !(id in THEMES)) return 'dark';
  return id as ThemeId;
}
