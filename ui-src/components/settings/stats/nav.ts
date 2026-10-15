import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import {
  Activity,
  CircleAlert,
  Coins,
  Cpu,
  FolderGit2,
  Frown,
  LayoutGrid,
  type LucideIcon,
  PlugZap,
  Sparkles,
  SquareChartGantt,
  Wrench,
} from "lucide-react";

export type DashboardSection =
  | "overview"
  | "models"
  | "providers"
  | "costs"
  | "requests"
  | "errors"
  | "traces"
  | "tools"
  | "frustration"
  | "projects"
  | "gain";

export interface NavItem {
  id: DashboardSection;
  label: string;
  icon: LucideIcon;
  hotkey: string;
}

export interface NavGroup {
  heading: string;
  items: readonly NavItem[];
}

/** Sidebar navigation; labels resolve through i18n at render time. */
export function useNav(): readonly NavGroup[] {
  const { t } = useTranslation();
  return useMemo(
    () => [
      {
        heading: t("settingsPage.stats.nav.groupUsage"),
        items: [
          { id: "overview", label: t("settingsPage.stats.nav.overview"), icon: LayoutGrid, hotkey: "o" },
          { id: "models", label: t("settingsPage.stats.nav.models"), icon: Cpu, hotkey: "m" },
          { id: "providers", label: t("settingsPage.stats.nav.providers"), icon: PlugZap, hotkey: "p" },
          { id: "costs", label: t("settingsPage.stats.nav.costs"), icon: Coins, hotkey: "c" },
        ],
      },
      {
        heading: t("settingsPage.stats.nav.groupActivity"),
        items: [
          { id: "requests", label: t("settingsPage.stats.nav.requests"), icon: Activity, hotkey: "r" },
          { id: "errors", label: t("settingsPage.stats.nav.errors"), icon: CircleAlert, hotkey: "e" },
          { id: "traces", label: t("settingsPage.stats.nav.traces"), icon: SquareChartGantt, hotkey: "t" },
        ],
      },
      {
        heading: t("settingsPage.stats.nav.groupPerformance"),
        items: [
          { id: "tools", label: t("settingsPage.stats.nav.tools"), icon: Wrench, hotkey: "l" },
          { id: "frustration", label: t("settingsPage.stats.nav.frustration"), icon: Frown, hotkey: "f" },
          { id: "projects", label: t("settingsPage.stats.nav.projects"), icon: FolderGit2, hotkey: "j" },
          { id: "gain", label: t("settingsPage.stats.nav.gain"), icon: Sparkles, hotkey: "g" },
        ],
      },
    ],
    [t],
  );
}
